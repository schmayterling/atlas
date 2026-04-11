import type { AtlasStore } from '../storage/store.js'
import type { SearchResult, SymbolKind, SymbolResult } from '../../shared/types.js'

export function searchSymbols(
	store: AtlasStore,
	query: string,
	opts?: { kind?: SymbolKind; exact?: boolean; limit?: number },
): SearchResult {
	const limit = opts?.limit ?? 20

	if (opts?.exact) {
		const results = store.searchSymbolsExact(query, opts.kind, limit)
		return { query, total: results.length, results }
	}

	// when kind filter is specified, request more results from FTS
	// then filter, to avoid the limit cutting off valid matches
	const fetchLimit = opts?.kind ? limit * 5 : limit
	const results = store.searchSymbols(query, fetchLimit)

	// also search LLM summaries for richer matches
	const summaryMatches = searchSummaries(store, query, fetchLimit)
	const seen = new Set(results.map((r) => r.qualifiedName))
	for (const match of summaryMatches) {
		if (!seen.has(match.qualifiedName)) {
			results.push(match)
			seen.add(match.qualifiedName)
		}
	}

	const filtered = opts?.kind
		? results.filter((r) => r.kind === opts.kind).slice(0, limit)
		: results.slice(0, limit)

	return { query, total: filtered.length, results: filtered }
}

// search symbol_summaries table for matches
function searchSummaries(store: AtlasStore, query: string, limit: number): SymbolResult[] {
	try {
		const sanitized = query.replace(/[^a-zA-Z0-9_\s]/g, '').trim()
		if (!sanitized) return []

		const rows = store.queryRawWithParams<{ stableId: string }>(
			`SELECT symbol_stable_id as stableId FROM symbol_summaries
			WHERE summary LIKE ? LIMIT ?`,
			`%${sanitized}%`,
			limit,
		)

		const results: SymbolResult[] = []
		for (const row of rows) {
			const sym = store.getSymbolByStableId(row.stableId)
			if (sym) results.push(store.symbolToResult(sym))
		}
		return results
	} catch {
		return []
	}
}
