import { log } from '../../shared/logger.js'
import type { SemanticSearchResult, SymbolKind } from '../../shared/types.js'
import { isVectorSearchAvailable } from '../storage/sqlite-ext.js'
import { EMBED_QUERY_PREFIX } from '../embeddings/embed-pipeline.js'
import { OllamaClient } from '../embeddings/ollama-client.js'
import type { AtlasStore } from '../storage/store.js'

export async function semanticSearch(
	store: AtlasStore,
	query: string,
	opts?: { limit?: number; includeTests?: boolean },
): Promise<SemanticSearchResult> {
	const limit = opts?.limit ?? 10
	const includeTests = opts?.includeTests ?? false

	if (!isVectorSearchAvailable()) {
		return { query, results: [], embeddingsAvailable: false }
	}

	// check if embeddings exist
	const meta = store.queryRaw<{ count: number }>(
		'SELECT COUNT(*) as count FROM embedding_meta',
	)
	if (!meta[0] || meta[0].count === 0) {
		return { query, results: [], embeddingsAvailable: false }
	}

	// embed the query with the nomic-embed-text task prefix so it lives in
	// the same retrieval space as the documents (which use EMBED_DOCUMENT_PREFIX
	// in buildEmbedText). without the matching prefix, natural-language queries
	// return noise. see #22.
	const ollama = new OllamaClient()
	let queryEmbedding: number[]
	try {
		await ollama.ensureRunning()
		const embeddings = await ollama.embed([EMBED_QUERY_PREFIX + query])
		queryEmbedding = embeddings[0]
	} catch (e) {
		log.warn(`semantic search query failed: ${e}`)
		return { query, results: [], embeddingsAvailable: false }
	}

	const queryVec = new Float32Array(queryEmbedding)

	// over-fetch to absorb test-symbol post-filter rejects when includeTests=false.
	// vec0 MATCH does not compose cleanly with column filters on joined tables,
	// so filtering happens in JS after KNN ranking.
	const fetchK = includeTests ? limit : limit * 5

	const rows = store.queryRawWithParams<{
		rowid: number
		distance: number
		name: string
		qualifiedName: string
		kind: string
		signature: string | null
		filePath: string
		lineStart: number
		lineEnd: number
		isExported: number
		docComment: string | null
		isTest: number
	}>(
		`SELECT e.rowid, e.distance,
		s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
		f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
		s.is_exported as isExported, s.doc_comment as docComment, f.is_test as isTest
		FROM symbol_embeddings e
		JOIN symbols s ON s.id = e.rowid
		JOIN files f ON f.id = s.file_id
		WHERE e.embedding MATCH ?
		AND k = ?
		ORDER BY e.distance`,
		queryVec,
		fetchK,
	)

	const filtered = includeTests ? rows : rows.filter((r) => r.isTest === 0)

	const results = filtered.slice(0, limit).map((r) => ({
		name: r.name,
		qualifiedName: r.qualifiedName,
		kind: r.kind as SymbolKind,
		signature: r.signature,
		filePath: r.filePath,
		lineStart: r.lineStart,
		lineEnd: r.lineEnd,
		isExported: Boolean(r.isExported),
		docComment: r.docComment,
		usageCount: 0,
		dependentCount: 0,
		distance: r.distance,
	}))

	return { query, results, embeddingsAvailable: true }
}
