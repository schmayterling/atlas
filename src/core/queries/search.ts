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

	const results = store.searchSymbols(query, limit)

	// filter by kind if specified
	const filtered = opts?.kind
		? results.filter((r) => r.kind === opts.kind)
		: results

	return { query, total: filtered.length, results: filtered }
}
