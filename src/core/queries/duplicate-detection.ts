import type { AtlasStore } from '../storage/store.js'
import type { SymbolResult } from '../../shared/types.js'
import { isVectorSearchAvailable } from '../storage/sqlite-ext.js'

export interface DuplicatePair {
	symbolA: SymbolResult
	symbolB: SymbolResult
	similarity: number
	confirmed: boolean
	description: string | null
}

// find duplicate candidates using embedding similarity
export function findDuplicates(
	store: AtlasStore,
	opts?: { threshold?: number; limit?: number },
): DuplicatePair[] {
	// first check stored duplicates
	const stored = store.queryRaw<{
		symbolAId: string
		symbolBId: string
		similarity: number
		confirmed: number
		description: string | null
	}>('SELECT symbol_a_id as symbolAId, symbol_b_id as symbolBId, similarity, confirmed, description FROM duplicates ORDER BY similarity DESC')

	if (stored.length > 0) {
		return stored
			.map((row) => {
				const symA = store.getSymbolByStableId(row.symbolAId)
				const symB = store.getSymbolByStableId(row.symbolBId)
				if (!symA || !symB) return null
				return {
					symbolA: store.symbolToResult(symA),
					symbolB: store.symbolToResult(symB),
					similarity: row.similarity,
					confirmed: row.confirmed === 1,
					description: row.description,
				}
			})
			.filter((d) => d !== null) as DuplicatePair[]
	}

	return []
}

// detect duplicates from embeddings (run during indexing)
export function detectDuplicatesFromEmbeddings(
	store: AtlasStore,
	threshold = 0.92,
	maxResults = 100,
): number {
	if (!isVectorSearchAvailable()) return 0

	// check if embedding tables exist
	const tables = store.queryRaw<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_embeddings'",
	)
	if (tables.length === 0) return 0

	const dupTable = store.queryRaw<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='duplicates'",
	)
	if (dupTable.length === 0) return 0

	// get all embedded symbols with their embeddings
	const meta = store.queryRaw<{ stableId: string; symbolId: number }>(
		'SELECT symbol_stable_id as stableId, symbol_id as symbolId FROM embedding_meta',
	)

	if (meta.length < 2) return 0

	let count = 0

	// for each symbol, find similar symbols via KNN
	for (const entry of meta) {
		try {
			const results = store.queryRawWithParams<{
				rowid: number
				distance: number
			}>(
				`SELECT rowid, distance FROM symbol_embeddings
				WHERE embedding MATCH (SELECT embedding FROM symbol_embeddings WHERE rowid = ?)
				AND k = 5
				AND rowid != ?`,
				entry.symbolId,
				entry.symbolId,
			)

			for (const match of results) {
				// convert distance to similarity (cosine distance -> similarity)
				const similarity = 1 - match.distance
				if (similarity < threshold) continue

				// find the matched symbol's stable_id
				const matchedMeta = meta.find((m) => m.symbolId === match.rowid)
				if (!matchedMeta) continue

				// avoid duplicate pairs (a,b) and (b,a)
				const [first, second] = [entry.stableId, matchedMeta.stableId].sort()

				try {
					store.runRaw(
						'INSERT OR IGNORE INTO duplicates (symbol_a_id, symbol_b_id, similarity) VALUES (?, ?, ?)',
						first,
						second,
						similarity,
					)
					count++
				} catch {
					// already exists
				}
			}
		} catch {
			// KNN query may fail for some entries
		}
	}

	return count
}
