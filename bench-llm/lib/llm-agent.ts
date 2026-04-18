// shared LLM agent driver. baseline + with-atlas variants share this
// loop; the only difference is which tools the model gets.
//
// the agent is asked to answer a structured task. its final message
// must be a fenced ```json block matching the AgentAnswer shape so the
// bench-eval judge can score it deterministically.

import { runChat, type ChatMessage, type OpenRouterTool, type ToolCall } from './openrouter.js'
import type { AgentAnswer } from '../../bench-eval/lib/judge.js'

export interface LlmAgentResult {
	answer: AgentAnswer
	toolCallCount: number
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

Use the provided tools to explore the codebase. Be efficient — do not list every file in a directory if you only need one. When you have enough information, write your final answer.

Your FINAL message MUST be a single \`\`\`json fenced block with one of these shapes (no prose outside the block):

For "symbols" answers: {"symbols": ["filePath::symbolName", "..."]}
For "count" answers:   {"count": 42}
For "files" answers:   {"files": ["a.ts", "b.ts"]}
For "structural" answers: {"raw": <the raw tool output you used>}

Qualified names use the format \`relativeFilePath::SymbolName\` (e.g. \`crates/core/main.rs::run\`). Do not invent names — only answer with values you found via tool calls.`

export async function runLlmAgent(opts: {
	model: string
	task: LlmTaskInput
	tools: OpenRouterTool[]
	toolHandler: (call: ToolCall) => Promise<string> | string
	maxIters?: number
}): Promise<LlmAgentResult> {
	const start = performance.now()
	const userMsg: ChatMessage = {
		role: 'user',
		content: `Task ${opts.task.id} (capability: ${opts.task.capability}).

${opts.task.intent}

Expected answer shape: ${opts.task.expectedShape}. Reply with the JSON block as instructed.`,
	}

	const r = await runChat({
		model: opts.model,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			userMsg,
		],
		tools: opts.tools,
		toolHandler: opts.toolHandler,
		maxIters: opts.maxIters ?? 10,
		temperature: 0,
	})

	const wallMs = Math.round(performance.now() - start)
	const answer = parseAnswer(r.finalMessage)
	const toolCallCount = r.steps.filter((s) => s.role === 'assistant' && s.tool_calls).reduce((n, s) => n + (s.tool_calls?.length ?? 0), 0)

	return {
		answer,
		toolCallCount,
		tokens: { prompt: r.usage.prompt_tokens, completion: r.usage.completion_tokens, total: r.usage.total_tokens },
		cost: r.cost,
		model: r.model,
		wallMs,
		steps: r.steps.length,
		stoppedReason: r.stoppedReason,
		error: r.error,
	}
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
