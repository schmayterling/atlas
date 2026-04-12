import type { AtlasStore } from '../storage/store.js'
import type { DuplicatePair } from '../../shared/types.js'
import { isVectorSearchAvailable } from '../storage/sqlite-ext.js'

export type { DuplicatePair }

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
		// batch-fetch all symbols
		const allIds = [...new Set(stored.flatMap((r) => [r.symbolAId, r.symbolBId]))]
		const symMap = store.getSymbolsByStableIds(allIds)
		const results = store.symbolsToResults([...symMap.values()])
		const resultMap = new Map<string, import('../../shared/types.js').SymbolResult>()
		const symValues = [...symMap.values()]
		for (let i = 0; i < symValues.length; i++) {
			resultMap.set(symValues[i].stableId, results[i])
		}

		return stored
			.map((row) => {
				const a = resultMap.get(row.symbolAId)
				const b = resultMap.get(row.symbolBId)
				if (!a || !b) return null
				return {
					symbolA: a,
					symbolB: b,
					similarity: row.similarity,
					confirmed: row.confirmed === 1,
					description: row.description,
				}
			})
			.filter((d) => d !== null) as DuplicatePair[]
	}

	return []
}

// detect duplicates from embeddings (run during indexing).
// only considers function-like and class-like symbols. interface/type
// property declarations are too small to embed meaningfully and would
// flood the results with near-identical vectors.
const DUP_ELIGIBLE_KINDS = ['function', 'method', 'class', 'type', 'interface', 'enum']

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

	// only embed-eligible kinds, and only symbols whose source body is
	// large enough to be meaningful (smallest function/method bodies still
	// have a few tokens; this skips one-line property accessors).
	const placeholders = DUP_ELIGIBLE_KINDS.map(() => '?').join(',')
	const meta = store.queryRawWithParams<{ stableId: string; symbolId: number }>(
		`SELECT em.symbol_stable_id as stableId, em.symbol_id as symbolId
		 FROM embedding_meta em
		 JOIN symbols s ON s.stable_id = em.symbol_stable_id
		 WHERE s.kind IN (${placeholders})
		 AND (s.byte_end - s.byte_start) >= 60`,
		...DUP_ELIGIBLE_KINDS,
	)

	if (meta.length < 2) return 0

	// pre-build lookup map to avoid O(n^2) .find() inside the KNN loop
	const metaById = new Map(meta.map((m) => [m.symbolId, m]))
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
				const matchedMeta = metaById.get(match.rowid)
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
