import type { AtlasStore } from '../storage/store.js'
import type { SymbolResult } from '../../shared/types.js'
import { log } from '../../shared/logger.js'

export interface DetectedFlow {
	id: number
	name: string
	description: string | null
	rootSymbol: SymbolResult | null
	symbols: SymbolResult[]
	generatedAt: number
}

// find flow roots: exported functions/methods with no inbound calls edges
export function findFlowRoots(store: AtlasStore): { stableId: string; name: string; kind: string }[] {
	return store.queryRaw<{ stableId: string; name: string; kind: string }>(`
		SELECT s.stable_id as stableId, s.name, s.kind
		FROM symbols s
		WHERE s.is_exported = 1
		AND s.kind IN ('function', 'method')
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

	return rows.map((row) => {
		const ids: string[] = JSON.parse(row.symbolIds)
		const rootSym = store.getSymbolByStableId(row.rootStableId)
		const symbols = ids
			.map((id) => store.getSymbolByStableId(id))
			.filter((s) => s !== null)
			.map((s) => store.symbolToResult(s!))

		return {
			id: row.id,
			name: row.name,
			description: row.description,
			rootSymbol: rootSym ? store.symbolToResult(rootSym) : null,
			symbols,
			generatedAt: row.generatedAt,
		}
	})
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
