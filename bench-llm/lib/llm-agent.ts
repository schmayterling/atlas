// shared LLM agent driver. baseline + with-atlas variants share this
// loop; the only difference is which tools the model gets.
//
// the agent is asked to answer a structured task. its final message
// must be a fenced ```json block matching the AgentAnswer shape so the
// bench-eval judge can score it deterministically.

import { runChat, type ChatMessage, type OpenRouterTool, type RunResult, type ToolCall } from './openrouter.js'
import type { AgentAnswer } from '../../bench-eval/lib/judge.js'

// full record of a single tool invocation. args + result are truncated
// so the trial rows stay auditable without blowing up the results json.
export interface TraceStep {
	tool: string
	args: string
	resultLen: number
	resultPreview: string
}

export interface LlmAgentResult {
	answer: AgentAnswer
	toolCallCount: number
	// ordered sequence of tool names as called. lets us see not just how many
	// tool calls the agent made but what it actually did (e.g. whether it
	// used atlas_semantic_search before atlas_search, or hit grep 4× in a row).
	toolSequence: string[]
	// per-tool call counts. quick to aggregate across trials.
	toolBreakdown: Record<string, number>
	// full compact trace: name + args (truncated) + result length + preview.
	// needed to explain *why* a trial failed (did the tool return garbage?
	// was the model given enough info?) without re-running.
	trace: TraceStep[]
	// the final assistant message, saved so we can tell json-parse-failure
	// from bad-atlas-answer when a trial scores 0.
	finalMessage: string
	tokens: { prompt: number; completion: number; total: number }
	cost: number
	model: string
	wallMs: number
	steps: number
	stoppedReason: string
	error?: string
}

export interface LlmTaskInput {
	id: string
	capability: string
	intent: string
	expectedShape: 'symbols' | 'count' | 'files' | 'structural'
}

const SYSTEM_PROMPT = `You are a code-intelligence agent answering structural questions about a codebase.

TOOL ROUTING (pick the smallest set of tools for each question type):

  Known symbol name → atlas_overview({q:"SymbolName"}) in ONE call. Returns identity + callers + callees + blast + tests + subsystem. Do not also call atlas_search for the same symbol.
  Unknown name, need to find by intent → atlas_semantic_search.
  Exact/fuzzy name lookup only → atlas_search (NOT for substrings or comments).
  File-content / substring / comment / TODO questions → atlas_content_search (NOT atlas_semantic_search, NOT atlas_search).
  "What calls X" / "What does X call" → atlas_deps (upstream / downstream).
  Per-line call sites → atlas_call_sites.
  Impact of changing X → atlas_blast_radius.
  Path from A to B → atlas_trace.
  Tests that cover X → atlas_test_coverage.
  Read the source of X → atlas_symbol_detail.
  File inventory / "how many files" / "which files under X/" → atlas_files. Use the returned array LENGTH as the count. Do NOT estimate.

OUTPUT RULES:

Your FINAL message MUST be a single \`\`\`json fenced block with one of these shapes (no prose outside the block):

  For "symbols" answers: {"symbols": ["filePath::symbolName", "..."]}
  For "count" answers:   {"count": 42}
  For "files" answers:   {"files": ["a.ts", "b.ts"]}
  For "structural" answers: {"raw": <THE DISTILLED SUMMARY YOU USED , flat keys like {count, qualifiedNames, paths}>}

Keep the final JSON as SMALL as it can be while still satisfying the question. If a tool returned a \`summary\` object with counts, put those counts in your final answer , do not dump the entire nested graph. If a tool returned a \`qualifiedNames\` array, use it directly.

BEHAVIOR RULES:

- Do NOT repeat the same tool with the same arguments.
- If two tool calls returned empty or irrelevant results, CHANGE your approach or give your best-effort answer.
- Qualified names use \`relativeFilePath::SymbolName\` (e.g. \`crates/core/main.rs::run\`).
- Do NOT invent names, counts, or paths , only cite values you actually received from a tool call.
- Be efficient: 2–3 tool calls is usually enough.`

// hard wallclock cap per trial. 2 minutes covers legitimate long-running
// searches (chunkhound first-embed, cbm max-iters at 10) without letting
// runaway trials block the pool. trials that hit this return with
// stoppedReason: 'timeout' and whatever steps completed so far.
const DEFAULT_TIMEOUT_MS = 120_000

export async function runLlmAgent(opts: {
	model: string
	task: LlmTaskInput
	tools: OpenRouterTool[]
	toolHandler: (call: ToolCall) => Promise<string> | string
	maxIters?: number
	timeoutMs?: number
}): Promise<LlmAgentResult> {
	const start = performance.now()
	const userMsg: ChatMessage = {
		role: 'user',
		content: `Task ${opts.task.id} (capability: ${opts.task.capability}).

${opts.task.intent}

Expected answer shape: ${opts.task.expectedShape}. Reply with the JSON block as instructed.`,
	}

	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
	let r: RunResult
	try {
		r = await runChat({
			model: opts.model,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				userMsg,
			],
			tools: opts.tools,
			toolHandler: opts.toolHandler,
			maxIters: opts.maxIters ?? 10,
			temperature: 0,
			signal: ctrl.signal,
		})
	} finally {
		clearTimeout(timer)
	}

	const wallMs = Math.round(performance.now() - start)
	const answer = parseAnswer(r.finalMessage)

	// index tool results by id so we can pair each assistant tool_call
	// with its response in the same iteration of the trace walk below.
	const resultsById = new Map<string, string>()
	for (const s of r.steps) {
		if (s.role !== 'tool' || !s.tool_results) continue
		for (const tr of s.tool_results) resultsById.set(tr.tool_call_id, tr.content ?? '')
	}

	const toolSequence: string[] = []
	const toolBreakdown: Record<string, number> = {}
	const trace: TraceStep[] = []
	for (const s of r.steps) {
		if (s.role !== 'assistant' || !s.tool_calls) continue
		for (const call of s.tool_calls) {
			const name = call.function.name
			toolSequence.push(name)
			toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1
			const result = resultsById.get(call.id) ?? ''
			trace.push({
				tool: name,
				args: truncate(call.function.arguments ?? '', ARGS_TRUNC),
				resultLen: result.length,
				resultPreview: truncate(result, RESULT_PREVIEW_TRUNC),
			})
		}
	}

	return {
		answer,
		toolCallCount: toolSequence.length,
		toolSequence,
		toolBreakdown,
		trace,
		finalMessage: r.finalMessage,
		tokens: { prompt: r.usage.prompt_tokens, completion: r.usage.completion_tokens, total: r.usage.total_tokens },
		cost: r.cost,
		model: r.model,
		wallMs,
		steps: r.steps.length,
		stoppedReason: r.stoppedReason,
		error: r.error,
	}
}

// truncation limits for the compact per-trial trace saved in results json.
// bumped from 120/180 so we can see what the agent actually searched for
// (full atlas_search('ZodObject') args, meaningful result prefix) without
// blowing up the results file. 400/800 × ~5 steps × 560 trials ≈ 3.4MB.
const ARGS_TRUNC = 400
const RESULT_PREVIEW_TRUNC = 800

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s
}

function parseAnswer(text: string): AgentAnswer {
	if (!text) return { error: 'empty response' }
	const fence = text.match(/```(?:json)?\s*([\s\S]+?)```/)
	const body = fence ? fence[1].trim() : text.trim()
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>
		const out: AgentAnswer = {}
		if (Array.isArray(parsed.symbols)) out.symbols = parsed.symbols.map(String)
		if (Array.isArray(parsed.files)) out.files = parsed.files.map(String)
		if (typeof parsed.count === 'number') out.count = parsed.count
		if (parsed.raw !== undefined) out.raw = parsed.raw
		return out
	} catch (e) {
		return { error: `parse failure: ${e instanceof Error ? e.message : String(e)}` }
	}
}
