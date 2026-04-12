import { createHash } from 'node:crypto'
import { UndirectedGraph } from 'graphology'
import louvain from 'graphology-communities-louvain'
import type { AtlasStore } from '../storage/store.js'

export interface DetectedSubsystem {
	id: string
	name: string
	memberFileIds: number[]
	memberFilePaths: string[]
	conductance: number
}

export interface SubsystemDetectionResult {
	clusters: DetectedSubsystem[]
	partitionModularity: number
}

const MIN_CLUSTER_SIZE = 2
const MAX_NAME_SYMBOLS = 3

interface FileEdgeRow {
	a: number
	b: number
	weight: number
}

interface FileRow {
	id: number
	path: string
}

// build a file-level undirected graph weighted by cross-file edges. ignores
// intra-file edges (file_id is null for cross-file in atlas).
export function buildFileGraph(store: AtlasStore, opts?: { withCoChange?: boolean }): UndirectedGraph {
	const graph = new UndirectedGraph()
	const files = store.queryRaw<FileRow>('SELECT id, path FROM files')
	for (const f of files) {
		graph.addNode(String(f.id), { path: f.path })
	}

	// pull cross-file edges by joining symbols → file. dedupe pairs and sum
	// weights. an edge counts when source and target symbols live in
	// different files. SQLite has no LEAST/GREATEST so we use CASE WHEN
	// to canonicalize each pair as (smaller, larger).
	const edgeRows = store.queryRaw<FileEdgeRow>(`
		SELECT a, b, COUNT(*) as weight FROM (
			SELECT
				CASE WHEN s_src.file_id < s_tgt.file_id THEN s_src.file_id ELSE s_tgt.file_id END as a,
				CASE WHEN s_src.file_id < s_tgt.file_id THEN s_tgt.file_id ELSE s_src.file_id END as b
			FROM edges e
			JOIN symbols s_src ON s_src.stable_id = e.source_id
			JOIN symbols s_tgt ON s_tgt.stable_id = e.target_id
			WHERE s_src.file_id != s_tgt.file_id
		)
		GROUP BY a, b
	`)
	for (const er of edgeRows) {
		const aId = String(er.a)
		const bId = String(er.b)
		if (!graph.hasNode(aId) || !graph.hasNode(bId)) continue
		if (graph.hasEdge(aId, bId)) {
			const cur = (graph.getEdgeAttribute(aId, bId, 'weight') as number) ?? 0
			graph.setEdgeAttribute(aId, bId, 'weight', cur + er.weight)
		} else {
			graph.addEdge(aId, bId, { weight: er.weight })
		}
	}

	// optional co-change weight from pillar B
	if (opts?.withCoChange) {
		const cochange = store.queryRaw<{ a: string; b: string; count: number }>(`
			SELECT f1.id as a, f2.id as b, cc.count
			FROM co_change_pairs cc
			JOIN files f1 ON f1.path = cc.file_a
			JOIN files f2 ON f2.path = cc.file_b
		`)
		const beta = 0.5
		for (const cc of cochange) {
			const aId = String(cc.a)
			const bId = String(cc.b)
			if (!graph.hasNode(aId) || !graph.hasNode(bId)) continue
			const additional = beta * cc.count
			if (graph.hasEdge(aId, bId)) {
				const cur = (graph.getEdgeAttribute(aId, bId, 'weight') as number) ?? 0
				graph.setEdgeAttribute(aId, bId, 'weight', cur + additional)
			} else {
				graph.addEdge(aId, bId, { weight: additional })
			}
		}
	}

	return graph
}

// run Louvain on the file graph, return clusters with stable content-hash IDs
// and conductance scores.
export function detectSubsystems(
	store: AtlasStore,
	opts?: { withCoChange?: boolean },
): SubsystemDetectionResult {
	const graph = buildFileGraph(store, opts)
	if (graph.order < 2) {
		return { clusters: [], partitionModularity: 0 }
	}

	const detail = louvain.detailed(graph, { getEdgeWeight: 'weight' })
	const partitionModularity = detail.modularity
	const communityToNodes = new Map<number, string[]>()
	for (const [nodeId, community] of Object.entries(detail.communities)) {
		const arr = communityToNodes.get(community) ?? []
		arr.push(nodeId)
		communityToNodes.set(community, arr)
	}

	const fileById = new Map<string, string>()
	graph.forEachNode((id, attrs) => fileById.set(id, attrs.path as string))

	const clusters: DetectedSubsystem[] = []
	for (const [, nodeIds] of communityToNodes) {
		if (nodeIds.length < MIN_CLUSTER_SIZE) continue
		const memberFileIds = nodeIds.map((n) => Number(n)).sort((a, b) => a - b)
		const memberFilePaths = memberFileIds.map((id) => fileById.get(String(id)) ?? '').sort()
		const id = stableSubsystemId(memberFilePaths)
		const name = canonicalName(store, memberFileIds, memberFilePaths)
		const conductance = computeConductance(graph, new Set(nodeIds))
		clusters.push({ id, name, memberFileIds, memberFilePaths, conductance })
	}

	return { clusters, partitionModularity }
}

// content-addressed cluster ID: same membership produces the same ID across
// re-clusterings, so MCP/UI deep links survive re-indexing.
export function stableSubsystemId(sortedMemberPaths: string[]): string {
	return createHash('sha256').update(sortedMemberPaths.join('\n')).digest('hex').slice(0, 16)
}

// deterministic cluster name: longest common path prefix + top central
// exported symbols by in-degree. ollama-independent.
export function canonicalName(
	store: AtlasStore,
	memberFileIds: number[],
	memberFilePaths: string[],
): string {
	const prefix = longestCommonPathPrefix(memberFilePaths)
	const placeholders = memberFileIds.map(() => '?').join(',')
	const topSymbols = store.queryRawWithParams<{ name: string; in_degree: number }>(
		`SELECT s.name, COUNT(e.id) as in_degree
		 FROM symbols s
		 LEFT JOIN edges e ON e.target_id = s.stable_id AND e.kind != 'contains'
		 WHERE s.file_id IN (${placeholders}) AND s.is_exported = 1
		 GROUP BY s.id
		 ORDER BY in_degree DESC, s.name
		 LIMIT ?`,
		...memberFileIds,
		MAX_NAME_SYMBOLS,
	)
	const symbolPart = topSymbols.map((s) => s.name).join(', ')
	if (prefix && symbolPart) return `${prefix} · ${symbolPart}`
	if (prefix) return prefix
	if (symbolPart) return symbolPart
	return `cluster of ${memberFileIds.length} files`
}

function longestCommonPathPrefix(paths: string[]): string {
	if (paths.length === 0) return ''
	const split = paths.map((p) => p.split('/'))
	const minLen = Math.min(...split.map((s) => s.length))
	const common: string[] = []
	for (let i = 0; i < minLen; i++) {
		const seg = split[0][i]
		if (split.every((s) => s[i] === seg)) common.push(seg)
		else break
	}
	if (common.length === 0) return ''
	// drop the last segment if it looks like a filename (contains a dot)
	const last = common[common.length - 1]
	if (last.includes('.')) common.pop()
	return common.join('/')
}

// conductance = edges leaving the cluster / (2*internal + leaving). ranges
// 0 (perfectly isolated) to 1 (no internal cohesion). low is good.
function computeConductance(graph: UndirectedGraph, members: Set<string>): number {
	let internal = 0
	let leaving = 0
	for (const node of members) {
		graph.forEachEdge(node, (_edge, attrs, source, target) => {
			const weight = (attrs.weight as number) ?? 1
			const other = source === node ? target : source
			if (members.has(other)) {
				// each internal edge will be visited twice (once from each end)
				internal += weight / 2
			} else {
				leaving += weight
			}
		})
	}
	const denom = 2 * internal + leaving
	if (denom === 0) return 0
	return leaving / denom
}

export function persistSubsystems(
	store: AtlasStore,
	clusters: DetectedSubsystem[],
	commitHash: string | null,
): void {
	store.runRaw('UPDATE files SET subsystem_id = NULL')
	store.runRaw('DELETE FROM subsystems')
	const now = Date.now()
	store.bulkInsert(() => {
		for (const c of clusters) {
			store.runRaw(
				'INSERT INTO subsystems (id, name, description, member_file_ids, conductance, generated_at, generated_for_commit) VALUES (?, ?, ?, ?, ?, ?, ?)',
				c.id,
				c.name,
				null,
				JSON.stringify(c.memberFileIds),
				c.conductance,
				now,
				commitHash,
			)
			for (const fileId of c.memberFileIds) {
				store.runRaw('UPDATE files SET subsystem_id = ? WHERE id = ?', c.id, fileId)
			}
		}
	})
}
