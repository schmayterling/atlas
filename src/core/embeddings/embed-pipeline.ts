import { createHash } from 'node:crypto'
import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'
import { isVectorSearchAvailable } from '../storage/sqlite-ext.js'
import { OllamaClient } from './ollama-client.js'

interface EmbedCandidate {
	symbolId: number
	stableId: string
	embedText: string
	embedHash: string
}

// build the text to embed for a symbol
function buildEmbedText(row: {
	kind: string
	name: string
	signature: string | null
	docComment: string | null
}): string {
	const parts = [row.kind, row.name]
	if (row.signature) parts.push(row.signature)
	if (row.docComment) parts.push(row.docComment)
	return parts.join(' ').slice(0, 512) // cap at 512 chars
}

function hashText(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export async function runEmbeddingPipeline(
	store: AtlasStore,
): Promise<{ embedded: number; skipped: number }> {
	if (!isVectorSearchAvailable()) {
		log.debug('vector search not available, skipping embeddings')
		return { embedded: 0, skipped: 0 }
	}

	const tables = store.queryRaw<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_meta'",
	)
	if (tables.length === 0) {
		log.debug('embedding_meta table not found, skipping')
		return { embedded: 0, skipped: 0 }
	}

	const symbols = store.queryRaw<{
		id: number
		stableId: string
		kind: string
		name: string
		signature: string | null
		docComment: string | null
	}>('SELECT id, stable_id as stableId, kind, name, signature, doc_comment as docComment FROM symbols')

	// get existing embed hashes
	const existingMeta = store.queryRaw<{
		stableId: string
		embedHash: string
	}>('SELECT symbol_stable_id as stableId, embed_hash as embedHash FROM embedding_meta')
	const existingHashes = new Map(existingMeta.map((m) => [m.stableId, m.embedHash]))

	// find candidates that need embedding
	const candidates: EmbedCandidate[] = []
	let skipped = 0

	for (const sym of symbols) {
		const embedText = buildEmbedText(sym)
		const embedHash = hashText(embedText)

		if (existingHashes.get(sym.stableId) === embedHash) {
			skipped++
			continue
		}

		candidates.push({
			symbolId: sym.id,
			stableId: sym.stableId,
			embedText,
			embedHash,
		})
	}

	if (candidates.length === 0) {
		return { embedded: 0, skipped }
	}

	// check ollama
	const ollama = new OllamaClient()
	try {
		await ollama.ensureRunning()
		await ollama.ensureModel()
	} catch (e) {
		log.warn(`ollama not available, skipping embeddings: ${e}`)
		return { embedded: 0, skipped }
	}

	// embed in batches
	log.info(`embedding ${candidates.length} symbols...`)
	const texts = candidates.map((c) => c.embedText)
	const embeddings = await ollama.embedBatched(texts)

	// store embeddings
	store.bulkInsert(() => {
		for (let i = 0; i < candidates.length; i++) {
			const candidate = candidates[i]
			const embedding = new Float32Array(embeddings[i])

			// upsert into symbol_embeddings (vec0)
			try {
				store.runRaw('DELETE FROM symbol_embeddings WHERE rowid = ?', candidate.symbolId)
			} catch {
				// may not exist yet
			}
			store.runRaw(
				'INSERT INTO symbol_embeddings(rowid, embedding) VALUES (?, ?)',
				candidate.symbolId,
				embedding,
			)

			// upsert into embedding_meta
			store.runRaw(
				'INSERT OR REPLACE INTO embedding_meta (symbol_stable_id, symbol_id, embed_text, embed_hash) VALUES (?, ?, ?, ?)',
				candidate.stableId,
				candidate.symbolId,
				candidate.embedText,
				candidate.embedHash,
			)
		}
	})

	return { embedded: candidates.length, skipped }
}
