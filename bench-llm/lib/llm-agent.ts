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

TOOL ROUTING (pick the tool that best fits the question; do not shotgun):

  Known symbol name, want rich context → atlas_overview({q:"SymbolName"}). Returns identity + callers + callees + blast + tests + subsystem in ONE call. Do not also call atlas_search for the same symbol.
  Exact name lookup, want a list of candidates or need to disambiguate → atlas_search. Pass kind: "function"/"class"/"method" when the question implies one. Prefer this for questions like "top-level run function" where semantic_search would over-rank a method.
  Unknown name, discovery by intent only → atlas_semantic_search. Returns similarity-ranked results; the top hit is a SUGGESTION, not a guarantee. Verify kind/filePath before committing. Do NOT use for substrings or comments.
  File-content / substring / comment / TODO / "how many files mention X" → atlas_content_search (literal text). Do NOT use atlas_search or atlas_semantic_search for these.
  "What calls X" / "what does X call" → atlas_deps (upstream / downstream).
  Per-line call sites → atlas_call_sites.
  Impact of changing X → atlas_blast_radius.
  Path from A to B → atlas_trace.
  Tests that cover X → atlas_test_coverage.
  Read the source of X → atlas_symbol_detail.
  File inventory / "how many files under X/" / "how many rust files" → atlas_files. Use the returned \`count\` field DIRECTLY. Do NOT re-count. Pass \`language\` when the question specifies one (e.g. rust, typescript).

OUTPUT RULES — the answer shape depends on the expected type the task declares:

  type "symbols" → {"symbols": ["filePath::symbolName", ...]}
      The array MUST contain JUST STRINGS. Extract the qualifiedName value
      from each tool result and put that string in the array. Do NOT put
      tool-result objects inside "symbols"; arrays of objects score 0.
      Example: if atlas_search returned {results: [{qualifiedName: "pkg/x.ts::Foo", kind: "class", ...}]},
      your answer is {"symbols": ["pkg/x.ts::Foo"]}.

  type "count" → {"count": 42}   (a bare number, not an object)

  type "files" → {"files": ["a.ts", "b.ts"]}   (strings only)

  type "structural" → {"raw": <preserve tool object keys verbatim>}
      This is the ONLY shape that accepts nested objects. Keep the
      qualifiedName / name / kind / filePath keys visible; the scorer
      counts quoted "qualifiedName" occurrences. A bare array of strings
      like ["a::b"] scores 0 for structural tasks.

Quick check before you submit: if the expected type is "symbols", every
entry in your array must be a string containing "::". If the expected
type is "structural", your raw field should be an object (or object
array) that preserves the tool's keys.

BEHAVIOR RULES:

- Prefer correctness over parsimony. One extra verification call is cheap; committing to a wrong answer is expensive.
- If a semantic_search top hit's \`kind\` or \`filePath\` looks inconsistent with the question ("top-level" but kind is "method", wrong crate, etc.), make a second call with atlas_search or atlas_overview to confirm before answering.
- Do NOT repeat the same tool with the same arguments.
- If two calls return empty or irrelevant results, change approach or return your best effort with what you have.
- Qualified names use \`relativeFilePath::SymbolName\` (e.g. \`crates/core/main.rs::run\`).
- Do NOT invent names, counts, or paths. Only cite values you actually received from a tool call.`

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
		// normalize symbols: llms occasionally dump full tool-result objects
		// into the array instead of just qualifiedName strings. .map(String)
		// on an object produces "[object Object]" which is worse than
		// extracting the qualifiedName field. preserve the string path for
		// clean responses; fall back to qualifiedName / qn / name for objects.
		if (Array.isArray(parsed.symbols)) out.symbols = parsed.symbols.map(toSymbolString)
		if (Array.isArray(parsed.files)) out.files = parsed.files.map(toFileString)
		if (typeof parsed.count === 'number') out.count = parsed.count
		if (parsed.raw !== undefined) out.raw = parsed.raw
		return out
	} catch (e) {
		return { error: `parse failure: ${e instanceof Error ? e.message : String(e)}` }
	}
}

function toSymbolString(entry: unknown): string {
	if (typeof entry === 'string') return entry
	if (entry && typeof entry === 'object') {
		const obj = entry as Record<string, unknown>
		const qn = obj.qualifiedName ?? obj.qn ?? obj.name
		if (typeof qn === 'string') return qn
	}
	return String(entry)
}

function toFileString(entry: unknown): string {
	if (typeof entry === 'string') return entry
	if (entry && typeof entry === 'object') {
		const obj = entry as Record<string, unknown>
		const p = obj.path ?? obj.filePath ?? obj.file
		if (typeof p === 'string') return p
	}
	return String(entry)
}
