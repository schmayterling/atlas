import { log } from '../../shared/logger.js'
import { contentHash } from '../../shared/identity.js'
import type { AtlasStore } from '../storage/store.js'
import type { SymbolDetail } from '../../shared/types.js'
import { OllamaClient } from '../embeddings/ollama-client.js'
import { buildSummaryPrompt } from './prompt.js'

export interface SummaryResult {
	summary: string
	model: string
	cached: boolean
}

interface SummaryRecord {
	stableId: string
	summary: string
	model: string
	generatedAt: number
	sourceHash: string
}

export async function summarizeSymbol(
	store: AtlasStore,
	detail: SymbolDetail,
	opts?: { model?: string; provider?: string },
): Promise<SummaryResult> {
	const sym = store.resolveSymbol(detail.symbol.qualifiedName)
	if (!sym) throw new Error(`symbol not found: ${detail.symbol.qualifiedName}`)

	const stableId = sym.stableId
	const sourceHash = contentHash(detail.sourceCode ?? detail.symbol.qualifiedName)

	// check cache
	const cached = store.queryRawWithParams<SummaryRecord>(
		'SELECT symbol_stable_id as stableId, summary, model, generated_at as generatedAt, source_hash as sourceHash FROM symbol_summaries WHERE symbol_stable_id = ?',
		stableId,
	)

	if (cached.length > 0 && cached[0].sourceHash === sourceHash) {
		return { summary: cached[0].summary, model: cached[0].model, cached: true }
	}

	// generate summary via Ollama
	const model = opts?.model ?? 'llama3.2'
	const prompt = buildSummaryPrompt(detail.symbol, detail.sourceCode, detail.upstream, detail.downstream)

	let summary: string
	try {
		const client = new OllamaClient()
		summary = await client.generate(prompt, model)
	} catch (e) {
		log.error(`llm summarize failed: ${e}`)
		throw new Error(`llm summarize failed: ${e}`)
	}

	// cache result
	store.runRaw(
		'INSERT OR REPLACE INTO symbol_summaries (symbol_stable_id, summary, model, generated_at, source_hash) VALUES (?, ?, ?, ?, ?)',
		stableId,
		summary.trim(),
		model,
		Date.now(),
		sourceHash,
	)

	return { summary: summary.trim(), model, cached: false }
}
