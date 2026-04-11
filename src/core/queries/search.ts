import type { AtlasStore } from '../storage/store.js'
import type { SearchResult, SymbolKind } from '../../shared/types.js'

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

	const filtered = opts?.kind
		? results.filter((r) => r.kind === opts.kind).slice(0, limit)
		: results

	return { query, total: filtered.length, results: filtered }
}
