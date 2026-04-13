import { join } from 'node:path'
import { log } from '../../shared/logger.js'
import { contentHash } from '../../shared/identity.js'
import type { AtlasStore } from '../storage/store.js'
import { OllamaClient } from '../embeddings/ollama-client.js'
import { buildSummaryPrompt } from './prompt.js'

export async function runSummaryPipeline(
	store: AtlasStore,
	projectRoot: string,
): Promise<{ generated: number; cached: number; skipped: number; fileSummaries: number }> {
	// check if summary table exists
	const tables = store.queryRaw<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_summaries'",
	)
	if (tables.length === 0) return { generated: 0, cached: 0, skipped: 0, fileSummaries: 0 }

	// check if Ollama has a chat model available
	const client = new OllamaClient()
	try {
		const running = await client.isRunning()
		if (!running) return { generated: 0, cached: 0, skipped: 0, fileSummaries: 0 }
	} catch {
		return { generated: 0, cached: 0, skipped: 0, fileSummaries: 0 }
	}

	// use qwen2.5-coder:1.5b (fast, code-specialized, ~1GB)
	const chatModel = 'qwen2.5-coder:1.5b'

	// check if model is available (don't auto-pull, respect user consent)
	try {
		const res = await fetch('http://127.0.0.1:11434/api/tags')
		if (res.ok) {
			const data = (await res.json()) as { models: { name: string }[] }
			const hasModel = data.models.some((m) => m.name.startsWith('qwen2.5-coder'))
			if (!hasModel) {
				log.warn(`${chatModel} not found. run 'ollama pull ${chatModel}' to enable LLM summaries.`)
				return { generated: 0, cached: 0, skipped: 0, fileSummaries: 0 }
			}
		}
	} catch {
		return { generated: 0, cached: 0, skipped: 0, fileSummaries: 0 }
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
		ORDER BY s.kind, s.name`)

	// build flow membership map: stableId -> flow names
	const flowMap = new Map<string, string[]>()
	try {
		const flows = store.queryRaw<{ name: string; symbolIds: string }>(
			'SELECT name, symbol_ids as symbolIds FROM flows',
		)
		for (const flow of flows) {
			const ids: string[] = JSON.parse(flow.symbolIds)
			for (const id of ids) {
				if (!flowMap.has(id)) flowMap.set(id, [])
				flowMap.get(id)!.push(flow.name)
			}
		}
	} catch { /* flows table may not exist */ }

	// get existing summaries
	const existing = new Map<string, string>()
	const rows = store.queryRaw<{ stableId: string; sourceHash: string }>(
		'SELECT symbol_stable_id as stableId, source_hash as sourceHash FROM symbol_summaries',
	)
	for (const r of rows) existing.set(r.stableId, r.sourceHash)

	let generated = 0
	let cached = 0
	let skipped = 0

	// build work items (filter cached/unreadable first)
	const work: { sym: typeof symbols[0]; sourceCode: string; hash: string; prompt: string }[] = []
	for (const sym of symbols) {
		let sourceCode: string | undefined
		try {
			const fullPath = join(projectRoot, sym.filePath)
			const text = await Bun.file(fullPath).text()
			const lines = text.split('\n')
			sourceCode = lines.slice(sym.lineStart - 1, sym.lineEnd).join('\n')
		} catch {
			skipped++
			continue
		}

		const hash = contentHash(sourceCode ?? sym.qualifiedName)
		if (existing.has(sym.stableId) && existing.get(sym.stableId) === hash) {
			cached++
			continue
		}

		const flows = flowMap.get(sym.stableId)
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
			flows,
		)
		work.push({ sym, sourceCode, hash, prompt })
	}

	if (work.length > 0) {
		log.info(`summarizing ${work.length} symbols (${cached} cached)...`)
	}

	let done = 0
	const batchSize = 20
	for (let i = 0; i < work.length; i += batchSize) {
		const batch = work.slice(i, i + batchSize)
		const results = await Promise.allSettled(
			batch.map(async (item) => {
				const summary = await client.generate(item.prompt, chatModel)
				done++
				log.info(`[${done}/${work.length}] ${item.sym.kind} ${item.sym.name}`)
				return { stableId: item.sym.stableId, name: item.sym.name, summary: summary.trim(), hash: item.hash }
			}),
		)

		for (const result of results) {
			if (result.status === 'fulfilled') {
				const { stableId, summary, hash } = result.value
				store.runRaw(
					'INSERT OR REPLACE INTO symbol_summaries (symbol_stable_id, summary, model, generated_at, source_hash) VALUES (?, ?, ?, ?, ?)',
					stableId,
					summary,
					chatModel,
					Date.now(),
					hash,
				)
				generated++
			} else {
				skipped++
			}
		}
	}

	// file-level summaries
	let fileSummaries = 0
	try {
		const files = store.queryRaw<{ path: string }>('SELECT path FROM files')
		const existingFiles = new Map<string, string>()
		try {
			const rows = store.queryRaw<{ filePath: string; sourceHash: string }>(
				'SELECT symbol_stable_id as filePath, source_hash as sourceHash FROM symbol_summaries WHERE symbol_stable_id LIKE \'file:%\'',
			)
			for (const r of rows) existingFiles.set(r.filePath, r.sourceHash)
		} catch { /* no table */ }

		const fileWork: { path: string; hash: string; prompt: string }[] = []
		for (const file of files) {
			const fileSymbols = store.getSymbolsByFilePath(file.path)
			if (fileSymbols.length === 0) continue
			const hash = contentHash(fileSymbols.map((s) => s.name).join(','))
			const key = `file:${file.path}`
			if (existingFiles.has(key) && existingFiles.get(key) === hash) continue

			const { buildFileSummaryPrompt } = await import('./prompt.js')
			const prompt = buildFileSummaryPrompt(
				file.path,
				fileSymbols.map((s) => s.name),
				fileSymbols.map((s) => s.kind),
			)
			fileWork.push({ path: file.path, hash, prompt })
		}

		if (fileWork.length > 0) {
			log.info(`summarizing ${fileWork.length} files...`)
		}

		for (let i = 0; i < fileWork.length; i += batchSize) {
			const batch = fileWork.slice(i, i + batchSize)
			const results = await Promise.allSettled(
				batch.map(async (item) => {
					const summary = await client.generate(item.prompt, chatModel)
					return { path: item.path, summary: summary.trim(), hash: item.hash }
				}),
			)
			for (const result of results) {
				if (result.status === 'fulfilled') {
					const { path, summary, hash } = result.value
					store.runRaw(
						'INSERT OR REPLACE INTO symbol_summaries (symbol_stable_id, summary, model, generated_at, source_hash) VALUES (?, ?, ?, ?, ?)',
						`file:${path}`,
						summary,
						chatModel,
						Date.now(),
						hash,
					)
					fileSummaries++
				}
			}
		}
	} catch (e) {
		log.warn(`file summaries failed: ${e}`)
	}

	return { generated, cached, skipped, fileSummaries }
}
