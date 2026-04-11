import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../../shared/logger.js'
import { contentHash } from '../../shared/identity.js'
import type { AtlasStore } from '../storage/store.js'
import { OllamaClient } from '../embeddings/ollama-client.js'
import { buildSummaryPrompt } from './prompt.js'

export async function runSummaryPipeline(
	store: AtlasStore,
	projectRoot: string,
): Promise<{ generated: number; cached: number; skipped: number }> {
	// check if summary table exists
	const tables = store.queryRaw<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_summaries'",
	)
	if (tables.length === 0) return { generated: 0, cached: 0, skipped: 0 }

	// check if Ollama has a chat model available
	const client = new OllamaClient()
	try {
		const running = await client.isRunning()
		if (!running) return { generated: 0, cached: 0, skipped: 0 }
	} catch {
		return { generated: 0, cached: 0, skipped: 0 }
	}

	// check available models for a chat model (not just embedding)
	let chatModel: string | null = null
	try {
		const res = await fetch('http://127.0.0.1:11434/api/tags')
		if (res.ok) {
			const data = (await res.json()) as { models: { name: string }[] }
			const chatModels = data.models
				.map((m) => m.name)
				.filter((n) => !n.includes('minilm') && !n.includes('embed'))
			if (chatModels.length > 0) chatModel = chatModels[0]
		}
	} catch {
		return { generated: 0, cached: 0, skipped: 0 }
	}

	if (!chatModel) {
		log.debug('no chat model available for summaries')
		return { generated: 0, cached: 0, skipped: 0 }
	}

	// get exported symbols without cached summaries
	const symbols = store.queryRaw<{
		stableId: string
		name: string
		qualifiedName: string
		kind: string
		signature: string | null
		docComment: string | null
		filePath: string
		lineStart: number
		lineEnd: number
	}>(`SELECT s.stable_id as stableId, s.name, s.qualified_name as qualifiedName, s.kind,
		s.signature, s.doc_comment as docComment, f.path as filePath,
		s.line_start as lineStart, s.line_end as lineEnd
		FROM symbols s JOIN files f ON s.file_id = f.id
		WHERE s.is_exported = 1
		AND s.kind IN ('function', 'class', 'method', 'interface', 'type')
		ORDER BY s.kind, s.name`)

	// get existing summaries
	const existing = new Map<string, string>()
	const rows = store.queryRaw<{ stableId: string; sourceHash: string }>(
		'SELECT symbol_stable_id as stableId, source_hash as sourceHash FROM symbol_summaries',
	)
	for (const r of rows) existing.set(r.stableId, r.sourceHash)

	let generated = 0
	let cached = 0
	let skipped = 0

	for (const sym of symbols) {
		// read source code for content hash
		let sourceCode: string | undefined
		try {
			const fullPath = join(projectRoot, sym.filePath)
			const text = readFileSync(fullPath, 'utf-8')
			const lines = text.split('\n')
			sourceCode = lines.slice(sym.lineStart - 1, sym.lineEnd).join('\n')
		} catch {
			skipped++
			continue
		}

		const hash = contentHash(sourceCode ?? sym.qualifiedName)

		// skip if already cached and source hasn't changed
		if (existing.has(sym.stableId) && existing.get(sym.stableId) === hash) {
			cached++
			continue
		}

		// generate summary
		const prompt = buildSummaryPrompt(
			{
				name: sym.name,
				qualifiedName: sym.qualifiedName,
				kind: sym.kind as any,
				signature: sym.signature,
				filePath: sym.filePath,
				lineStart: sym.lineStart,
				lineEnd: sym.lineEnd,
				isExported: true,
				docComment: sym.docComment,
				usageCount: 0,
				dependentCount: 0,
			},
			sourceCode,
			[],
			[],
		)

		try {
			const summary = await client.generate(prompt, chatModel)
			store.runRaw(
				'INSERT OR REPLACE INTO symbol_summaries (symbol_stable_id, summary, model, generated_at, source_hash) VALUES (?, ?, ?, ?, ?)',
				sym.stableId,
				summary.trim(),
				chatModel,
				Date.now(),
				hash,
			)
			generated++

			// log progress every 10
			if (generated % 10 === 0) {
				log.debug(`summarized ${generated} symbols so far...`)
			}
		} catch (e) {
			log.debug(`failed to summarize ${sym.name}: ${e}`)
			skipped++
		}
	}

	return { generated, cached, skipped }
}
