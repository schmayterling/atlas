import { createHash } from 'node:crypto'
import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'
import { OllamaClient } from '../embeddings/ollama-client.js'
import {
	detectSubsystems,
	persistSubsystems,
	type DetectedSubsystem,
} from '../queries/subsystem-detection.js'

// sha256 of the sorted file ids + sorted cross-file edge pairs + the
// option bits that materially change the partition. cheap to compute
// (three queries, no external deps). stable across runs unless the
// graph topology actually changes OR the user flips --with-cochange.
// cached as last_subsystem_topology_hash in atlas_meta.
function computeTopologyHash(store: AtlasStore, withCoChange: boolean): string {
	const fileIds = store
		.queryRaw<{ id: number }>('SELECT id FROM files ORDER BY id')
		.map((f) => f.id)
	const edges = store.queryRaw<{ s: string; t: string }>(
		`SELECT source_id as s, target_id as t FROM edges
		 WHERE file_id IS NULL AND kind IN ('calls','imports','type_ref','extends')
		 ORDER BY source_id, target_id`,
	)
	const coChangeCount = withCoChange
		? (store.queryRaw<{ count: number }>('SELECT COUNT(*) as count FROM co_change_pairs')[0]
				?.count ?? 0)
		: 0
	const h = createHash('sha256')
	h.update('files:')
	h.update(fileIds.join(','))
	h.update('|edges:')
	for (const e of edges) {
		h.update(e.s)
		h.update('->')
		h.update(e.t)
		h.update(',')
	}
	h.update('|withCoChange:')
	h.update(withCoChange ? '1' : '0')
	h.update('|coChangePairs:')
	h.update(String(coChangeCount))
	return h.digest('hex').slice(0, 16)
}

export interface SubsystemPipelineResult {
	clusters: number
	described: number
	partitionModularity: number
	skipped: boolean
}

export async function runSubsystemPipeline(
	store: AtlasStore,
	commitHash: string | null,
	opts?: { skipLLM?: boolean; withCoChange?: boolean },
): Promise<SubsystemPipelineResult> {
	// the subsystems table may not exist on older DBs that haven't run v9
	const tables = store.queryRaw<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='subsystems'",
	)
	if (tables.length === 0) {
		return { clusters: 0, described: 0, partitionModularity: 0, skipped: true }
	}

	// topology hash skip: when the file graph shape (files + cross-file
	// edge pairs + withCoChange option bit + co_change_pairs count) is
	// identical to the previous run we can reuse the persisted partition
	// instead of re-running louvain. hot path for no-op re-indexes
	// (docstring edits). full re-cluster still happens on every topology
	// change. incremental re-assignment is deferred until a consumer
	// hits a real cost.
	const withCoChange = opts?.withCoChange ?? false
	const topologyHash = computeTopologyHash(store, withCoChange)
	const lastHash = store.getMeta('last_subsystem_topology_hash')
	if (lastHash && topologyHash === lastHash) {
		const priorModularityRaw = store.getMeta('last_subsystem_modularity')
		const priorModularity = priorModularityRaw ? Number.parseFloat(priorModularityRaw) : 0
		const priorCount = store
			.queryRaw<{ count: number }>('SELECT COUNT(*) as count FROM subsystems')[0]
			?.count ?? 0
		return {
			clusters: priorCount,
			described: 0,
			partitionModularity: Number.isFinite(priorModularity) ? priorModularity : 0,
			skipped: true,
		}
	}

	const result = detectSubsystems(store, { withCoChange })
	if (result.clusters.length === 0) {
		// nothing to persist; clear any stale state and return. write the
		// topology hash so an identical empty graph on the next run still
		// takes the skip path instead of re-running louvain.
		persistSubsystems(store, [], commitHash)
		store.setMeta('last_subsystem_modularity', String(result.partitionModularity))
		store.setMeta('last_subsystem_topology_hash', topologyHash)
		return { clusters: 0, described: 0, partitionModularity: result.partitionModularity, skipped: false }
	}

	persistSubsystems(store, result.clusters, commitHash)
	store.setMeta('last_subsystem_modularity', String(result.partitionModularity))
	store.setMeta('last_subsystem_topology_hash', topologyHash)

	let described = 0
	if (!opts?.skipLLM) {
		described = await describeClusters(store, result.clusters)
	}

	return {
		clusters: result.clusters.length,
		described,
		partitionModularity: result.partitionModularity,
		skipped: false,
	}
}

// generate one-line LLM descriptions for each cluster. uses the same chat
// model selection logic as flow-pipeline. graceful fallback when ollama
// is unavailable.
async function describeClusters(store: AtlasStore, clusters: DetectedSubsystem[]): Promise<number> {
	const client = new OllamaClient()
	let chatModel: string | null = null
	try {
		const running = await client.isRunning()
		if (running) {
			const res = await fetch('http://127.0.0.1:11434/api/tags')
			if (res.ok) {
				const data = (await res.json()) as { models: { name: string }[] }
				const candidates = data.models
					.map((m) => m.name)
					.filter((n) => !n.includes('minilm') && !n.includes('embed'))
				if (candidates.length > 0) chatModel = candidates[0]
			}
		}
	} catch {
		// no LLM available
	}
	if (!chatModel) return 0

	let described = 0
	for (const cluster of clusters) {
		try {
			// gather a few exported symbols from member files for the prompt
			const sample = store.queryRawWithParams<{ name: string; kind: string }>(
				`SELECT s.name, s.kind FROM symbols s
				 WHERE s.file_id IN (${cluster.memberFileIds.map(() => '?').join(',')})
				 AND s.is_exported = 1
				 ORDER BY s.kind, s.name LIMIT 8`,
				...cluster.memberFileIds,
			)
			if (sample.length === 0) continue
			const prompt = `Files in this subsystem: ${cluster.memberFilePaths.slice(0, 5).join(', ')}\nKey exported symbols: ${sample.map((s) => `${s.kind} ${s.name}`).join(', ')}\n\nWrite a one-sentence description of what this subsystem does. No preamble, just the description.`
			const response = await client.generate(prompt, chatModel)
			const description = response.trim().split('\n')[0]
			if (description) {
				store.runRaw(
					'UPDATE subsystems SET description = ? WHERE id = ?',
					description,
					cluster.id,
				)
				described++
			}
		} catch (e) {
			log.warn(`failed to describe subsystem ${cluster.name}: ${e}`)
		}
	}
	return described
}
