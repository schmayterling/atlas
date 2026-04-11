import { log } from '../../shared/logger.js'
import type { SemanticSearchResult, SymbolKind } from '../../shared/types.js'
import { isVectorSearchAvailable } from '../storage/sqlite-ext.js'
import { OllamaClient } from '../embeddings/ollama-client.js'
import type { AtlasStore } from '../storage/store.js'

export async function semanticSearch(
	store: AtlasStore,
	query: string,
	opts?: { limit?: number },
): Promise<SemanticSearchResult> {
	const limit = opts?.limit ?? 10

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

	// embed the query
	const ollama = new OllamaClient()
	let queryEmbedding: number[]
	try {
		await ollama.ensureRunning()
		const embeddings = await ollama.embed([query])
		queryEmbedding = embeddings[0]
	} catch (e) {
		log.warn(`semantic search query failed: ${e}`)
		return { query, results: [], embeddingsAvailable: false }
	}

	const queryVec = new Float32Array(queryEmbedding)

	// KNN search via sqlite-vec
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
	}>(
		`SELECT e.rowid, e.distance,
		s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
		f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
		s.is_exported as isExported, s.doc_comment as docComment
		FROM symbol_embeddings e
		JOIN symbols s ON s.id = e.rowid
		JOIN files f ON f.id = s.file_id
		WHERE e.embedding MATCH ?
		AND k = ?
		ORDER BY e.distance`,
		queryVec,
		limit,
	)

	const results = rows.map((r) => ({
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
