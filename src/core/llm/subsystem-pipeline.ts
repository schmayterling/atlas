import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'
import { OllamaClient } from '../embeddings/ollama-client.js'
import {
	detectSubsystems,
	persistSubsystems,
	type DetectedSubsystem,
} from '../queries/subsystem-detection.js'

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

	const result = detectSubsystems(store, { withCoChange: opts?.withCoChange })
	if (result.clusters.length === 0) {
		// nothing to persist; clear any stale state and return
		persistSubsystems(store, [], commitHash)
		store.setMeta('last_subsystem_modularity', String(result.partitionModularity))
		return { clusters: 0, described: 0, partitionModularity: result.partitionModularity, skipped: false }
	}

	persistSubsystems(store, result.clusters, commitHash)
	store.setMeta('last_subsystem_modularity', String(result.partitionModularity))

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
