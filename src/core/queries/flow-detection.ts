import type { AtlasStore } from '../storage/store.js'
import type { DetectedFlow } from '../../shared/types.js'

export type { DetectedFlow }

// find flow roots: exported functions/methods with no inbound calls edges.
// excludes test files by default so detected flows describe production
// entry points, not test scaffolding.
export function findFlowRoots(
	store: AtlasStore,
	opts?: { includeTests?: boolean },
): { stableId: string; name: string; kind: string }[] {
	const testClause = opts?.includeTests ? '' : 'AND f.is_test = 0'
	return store.queryRaw<{ stableId: string; name: string; kind: string }>(`
		SELECT s.stable_id as stableId, s.name, s.kind
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		WHERE s.is_exported = 1
		AND s.kind IN ('function', 'method')
		${testClause}
		AND s.stable_id NOT IN (
			SELECT DISTINCT target_id FROM edges WHERE kind = 'calls'
		)
		ORDER BY s.name
	`)
}

// trace a flow: follow outbound calls edges from a root, collect the chain
export function traceFlowChain(store: AtlasStore, rootStableId: string, maxDepth = 5): string[] {
	const visited = new Set<string>()
	const chain: string[] = []

	function walk(id: string, depth: number) {
		if (depth > maxDepth || visited.has(id)) return
		visited.add(id)
		chain.push(id)

		const edges = store.getDirectEdgesFrom(id, 'calls')
		for (const edge of edges) {
			walk(edge.targetId, depth + 1)
		}
	}

	walk(rootStableId, 0)
	return chain
}

// get all stored flows
export function getFlows(store: AtlasStore): DetectedFlow[] {
	const rows = store.queryRaw<{
		id: number
		name: string
		description: string | null
		rootStableId: string
		symbolIds: string
		generatedAt: number
	}>('SELECT id, name, description, root_stable_id as rootStableId, symbol_ids as symbolIds, generated_at as generatedAt FROM flows ORDER BY name')

	// batch-fetch all symbols across all flows
	const allIds = new Set<string>()
	const parsedIds: string[][] = []
	for (const row of rows) {
		const ids: string[] = JSON.parse(row.symbolIds)
		parsedIds.push(ids)
		allIds.add(row.rootStableId)
		for (const id of ids) allIds.add(id)
	}
	const symMap = store.getSymbolsByStableIds([...allIds])
	const results = store.symbolsToResults([...symMap.values()])
	const resultMap = new Map<string, import('../../shared/types.js').SymbolResult>()
	const symValues = [...symMap.values()]
	for (let i = 0; i < symValues.length; i++) {
		resultMap.set(symValues[i].stableId, results[i])
	}

	return rows.map((row, idx) => ({
		id: row.id,
		name: row.name,
		description: row.description,
		rootSymbol: resultMap.get(row.rootStableId) ?? null,
		symbols: parsedIds[idx]
			.filter((id) => resultMap.has(id))
			.map((id) => resultMap.get(id)!),
		generatedAt: row.generatedAt,
	}))
}

// store a detected flow
export function storeFlow(
	store: AtlasStore,
	name: string,
	description: string | null,
	rootStableId: string,
	symbolIds: string[],
	model: string | null,
) {
	store.runRaw(
		'INSERT INTO flows (name, description, root_stable_id, symbol_ids, model, generated_at) VALUES (?, ?, ?, ?, ?, ?)',
		name,
		description,
		rootStableId,
		JSON.stringify(symbolIds),
		model,
		Date.now(),
	)
}

export function clearFlows(store: AtlasStore) {
	store.runRaw('DELETE FROM flows')
}
