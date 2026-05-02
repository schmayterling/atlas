import type { DuplicatePair } from '../../shared/types.js'
import { isVectorSearchAvailable } from '../storage/sqlite-ext.js'
import type { AtlasStore } from '../storage/store.js'

export type { DuplicatePair }

// find duplicate candidates using embedding similarity. by default, drop
// pairs where either symbol lives in a test file (intentional arrange/act/
// assert repetition would dominate the output otherwise).
export function findDuplicates(
	store: AtlasStore,
	opts?: { threshold?: number; limit?: number; includeTests?: boolean },
): DuplicatePair[] {
	const includeTests = opts?.includeTests ?? false
	// first check stored duplicates
	const stored = store.queryRaw<{
		symbolAId: string
		symbolBId: string
		similarity: number
		confirmed: number
		description: string | null
	}>(
		'SELECT symbol_a_id as symbolAId, symbol_b_id as symbolBId, similarity, confirmed, description FROM duplicates ORDER BY similarity DESC',
	)

	if (stored.length > 0) {
		// batch-fetch all symbols
		const allIds = [...new Set(stored.flatMap((r) => [r.symbolAId, r.symbolBId]))]
		const symMap = store.getSymbolsByStableIds(allIds)
		const fileMap = new Map<number, boolean>()
		if (!includeTests) {
			// fetch all files in one query rather than per-fileId getFile()
			for (const f of store.getAllFiles()) {
				fileMap.set(f.id, f.isTest)
			}
		}
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
				if (!includeTests) {
					const symA = symMap.get(row.symbolAId)
					const symB = symMap.get(row.symbolBId)
					if (!symA || !symB) return null
					if (fileMap.get(symA.fileId) || fileMap.get(symB.fileId)) return null
				}
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
	opts?: { excludeFileIds?: Set<number> },
): number {
	const dupTable = store.queryRaw<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='duplicates'",
	)
	if (dupTable.length === 0) return 0

	const existing = store.queryRaw<{
		symbolAId: string
		symbolBId: string
		confirmed: number
		description: string | null
	}>(
		'SELECT symbol_a_id as symbolAId, symbol_b_id as symbolBId, confirmed, description FROM duplicates',
	)
	const annotations = new Map(
		existing.map((row) => [
			`${row.symbolAId}\0${row.symbolBId}`,
			{ confirmed: row.confirmed, description: row.description },
		]),
	)
	store.runRaw('DELETE FROM duplicates')

	if (!isVectorSearchAvailable()) return 0

	// check if embedding tables exist
	const tables = store.queryRaw<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_embeddings'",
	)
	if (tables.length === 0) return 0

	// only embed-eligible kinds, and only symbols whose source body is
	// large enough to be meaningful (smallest function/method bodies still
	// have a few tokens; this skips one-line property accessors).
	const placeholders = DUP_ELIGIBLE_KINDS.map(() => '?').join(',')
	const metaRaw = store.queryRawWithParams<{ stableId: string; symbolId: number; fileId: number }>(
		`SELECT em.symbol_stable_id as stableId, em.symbol_id as symbolId, s.file_id as fileId
		 FROM embedding_meta em
		 JOIN symbols s ON s.stable_id = em.symbol_stable_id
		 WHERE s.kind IN (${placeholders})
		 AND (s.byte_end - s.byte_start) >= 60`,
		...DUP_ELIGIBLE_KINDS,
	)

	// filter out generated / mock files before they enter the knn loop. this
	// drops gomock fakes, protoc output, etc. so real production duplicates
	// aren't buried under codegen noise.
	const excluded = opts?.excludeFileIds
	const meta =
		excluded && excluded.size > 0 ? metaRaw.filter((m) => !excluded.has(m.fileId)) : metaRaw

	if (meta.length < 2) return 0

	// pre-build lookup map to avoid O(n^2) .find() inside the KNN loop
	const metaById = new Map(meta.map((m) => [m.symbolId, m]))
	const seenPairs = new Set<string>()
	let count = 0

	// for each symbol, find similar symbols via KNN. stop early once we've
	// inserted maxResults pairs so pathological cases don't run unbounded.
	for (const entry of meta) {
		if (count >= maxResults) break
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
				const pairKey = `${first}\0${second}`
				if (seenPairs.has(pairKey)) continue
				seenPairs.add(pairKey)
				const annotation = annotations.get(pairKey)

				try {
					store.runRaw(
						'INSERT INTO duplicates (symbol_a_id, symbol_b_id, similarity, confirmed, description) VALUES (?, ?, ?, ?, ?)',
						first,
						second,
						similarity,
						annotation?.confirmed ?? 0,
						annotation?.description ?? null,
					)
					count++
				} catch {
					// failed rows are skipped; detection is best-effort.
				}
			}
		} catch {
			// KNN query may fail for some entries
		}
	}

	return count
}
