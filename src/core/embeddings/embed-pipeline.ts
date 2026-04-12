import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

// embed text combines a short metadata header with the actual source body.
// metadata gives the model file/name context; source body is what makes
// semantic search and duplicate detection meaningful. ollama 0.20 ignores
// num_ctx on /api/embed and clamps to the model default (~2048 tokens for
// nomic-embed-text), so we cap at 4500 chars to stay safely under that
// even for token-dense code.
const MAX_EMBED_CHARS = 4500

export function buildEmbedText(
	row: {
		kind: string
		name: string
		qualifiedName: string
		filePath: string
		signature: string | null
		docComment: string | null
		byteStart: number
		byteEnd: number
	},
	projectRoot: string,
	sourceCache: Map<string, string>,
): string {
	const header: string[] = [`${row.kind} ${row.name}`]
	const fileName = row.filePath.split('/').pop()
	if (fileName) header.push(`in ${fileName}`)
	if (row.signature) header.push(row.signature)
	if (row.docComment) header.push(row.docComment.slice(0, 200))

	let body = ''
	if (row.byteEnd > row.byteStart) {
		try {
			let source = sourceCache.get(row.filePath)
			if (source === undefined) {
				source = readFileSync(resolve(projectRoot, row.filePath), 'utf-8')
				sourceCache.set(row.filePath, source)
			}
			body = source.slice(row.byteStart, row.byteEnd)
		} catch {
			body = ''
		}
	}

	const text = body ? `${header.join(' ')}\n${body}` : header.join(' ')
	return text.slice(0, MAX_EMBED_CHARS)
}

function hashText(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export async function runEmbeddingPipeline(
	store: AtlasStore,
	projectRoot: string,
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
		qualifiedName: string
		filePath: string
		signature: string | null
		docComment: string | null
		byteStart: number
		byteEnd: number
	}>(`SELECT s.id, s.stable_id as stableId, s.kind, s.name, s.qualified_name as qualifiedName,
		f.path as filePath, s.signature, s.doc_comment as docComment,
		s.byte_start as byteStart, s.byte_end as byteEnd
		FROM symbols s JOIN files f ON s.file_id = f.id
		WHERE NOT (s.kind = 'property' AND (s.byte_end - s.byte_start) < 80)`)

	// get existing embed hashes
	const existingMeta = store.queryRaw<{
		stableId: string
		embedHash: string
	}>('SELECT symbol_stable_id as stableId, embed_hash as embedHash FROM embedding_meta')
	const existingHashes = new Map(existingMeta.map((m) => [m.stableId, m.embedHash]))

	// find candidates that need embedding
	const candidates: EmbedCandidate[] = []
	let skipped = 0
	const sourceCache = new Map<string, string>()

	for (const sym of symbols) {
		const embedText = buildEmbedText(sym, projectRoot, sourceCache)
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

	// validate we got embeddings for all candidates
	if (embeddings.length < candidates.length) {
		log.warn(
			`ollama returned ${embeddings.length} embeddings for ${candidates.length} candidates, processing partial results`,
		)
	}
	const validCount = Math.min(embeddings.length, candidates.length)

	// store embeddings (only for successfully embedded symbols)
	store.bulkInsert(() => {
		for (let i = 0; i < validCount; i++) {
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

	return { embedded: validCount, skipped }
}
