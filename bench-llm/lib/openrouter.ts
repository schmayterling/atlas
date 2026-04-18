// minimal openrouter client (openai-compatible chat completions with
// tool use). zero new deps — uses bun's built-in fetch. supports any
// model openrouter routes to. tracks token usage and cost.
//
// requires OPENROUTER_API_KEY env var.
//
// design choices:
//  - openai shape on the wire because openrouter normalizes anthropic /
//    openai / gemini / open-weights to a common interface
//  - tool-use loop is internal: caller passes tools + handler, gets back
//    final assistant message + per-step trace + total usage
//  - hard cap on iterations and per-iteration token output to prevent
//    runaway loops in agent eval (cost + safety)

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

export interface OpenRouterTool {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string | null
	tool_calls?: ToolCall[]
	tool_call_id?: string
	name?: string
}

export interface ToolCall {
	id: string
	type: 'function'
	function: { name: string; arguments: string }
}

export interface Usage {
	prompt_tokens: number
	completion_tokens: number
	total_tokens: number
	cost?: number
}

export interface RunStep {
	role: 'assistant' | 'tool'
	content: string | null
	tool_calls?: ToolCall[]
	tool_results?: { tool_call_id: string; content: string }[]
}

export interface RunResult {
	finalMessage: string
	steps: RunStep[]
	usage: Usage
	cost: number
	model: string
	stoppedReason: 'natural' | 'max-iters' | 'error' | 'timeout'
	error?: string
}

export interface RunOptions {
	model: string
	messages: ChatMessage[]
	tools?: OpenRouterTool[]
	toolHandler?: (call: ToolCall) => Promise<string> | string
	maxIters?: number
	maxOutputTokens?: number
	temperature?: number
	// abort signal for the whole chat loop. when fired, any in-flight fetch
	// cancels and the loop returns with stoppedReason: 'timeout' (the caller
	// sets this via setTimeout for per-trial wallclock caps).
	signal?: AbortSignal
}

export async function runChat(opts: RunOptions): Promise<RunResult> {
	const apiKey = process.env.OPENROUTER_API_KEY
	if (!apiKey) {
		return {
			finalMessage: '',
			steps: [],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
			cost: 0,
			model: opts.model,
			stoppedReason: 'error',
			error: 'OPENROUTER_API_KEY env var not set',
		}
	}

	const messages: ChatMessage[] = [...opts.messages]
	const steps: RunStep[] = []
	const totalUsage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
	let totalCost = 0
	const maxIters = opts.maxIters ?? 12

	for (let iter = 0; iter < maxIters; iter++) {
		// caller-supplied signal (see bench-llm/lib/llm-agent.ts wiring it up
		// to a 2-min setTimeout per trial). bail BEFORE starting another
		// network call so the returned state includes every step completed
		// so far rather than throwing mid-fetch.
		if (opts.signal?.aborted) {
			return {
				finalMessage: '',
				steps,
				usage: totalUsage,
				cost: totalCost,
				model: opts.model,
				stoppedReason: 'timeout',
			}
		}

		const body: Record<string, unknown> = {
			model: opts.model,
			messages,
			temperature: opts.temperature ?? 0,
		}
		if (opts.tools && opts.tools.length > 0) body.tools = opts.tools
		if (opts.maxOutputTokens) body.max_tokens = opts.maxOutputTokens
		// openrouter passes through to upstream provider's usage accounting
		body.usage = { include: true }

		let res: Response
		try {
			res = await fetch(ENDPOINT, {
				method: 'POST',
				headers: {
					'authorization': `Bearer ${apiKey}`,
					'content-type': 'application/json',
					'http-referer': 'https://github.com/atlas/bench-llm',
					'x-title': 'atlas bench-llm',
				},
				body: JSON.stringify(body),
				signal: opts.signal,
			})
		} catch (e) {
			// AbortError (signal fired mid-fetch) → timeout, not error.
			// other throws (network) surface as stoppedReason: 'error'.
			const aborted = e instanceof Error && e.name === 'AbortError'
			return {
				finalMessage: '',
				steps,
				usage: totalUsage,
				cost: totalCost,
				model: opts.model,
				stoppedReason: aborted ? 'timeout' : 'error',
				error: aborted ? undefined : (e instanceof Error ? e.message : String(e)),
			}
		}

		if (!res.ok) {
			const text = await res.text().catch(() => '')
			return {
				finalMessage: '',
				steps,
				usage: totalUsage,
				cost: totalCost,
				model: opts.model,
				stoppedReason: 'error',
				error: `openrouter ${res.status}: ${text.slice(0, 200)}`,
			}
		}

		const json = await res.json() as {
			choices: Array<{ message: ChatMessage; finish_reason: string }>
			usage?: Usage
		}

		const choice = json.choices?.[0]
		if (!choice) {
			return {
				finalMessage: '', steps, usage: totalUsage, cost: totalCost, model: opts.model,
				stoppedReason: 'error', error: 'no choices in response',
			}
		}
		if (json.usage) {
			totalUsage.prompt_tokens += json.usage.prompt_tokens ?? 0
			totalUsage.completion_tokens += json.usage.completion_tokens ?? 0
			totalUsage.total_tokens += json.usage.total_tokens ?? 0
			if (json.usage.cost) totalCost += json.usage.cost
		}

		const msg = choice.message
		messages.push(msg)

		const toolCalls = msg.tool_calls ?? []
		steps.push({ role: 'assistant', content: msg.content ?? null, tool_calls: toolCalls.length > 0 ? toolCalls : undefined })

		// no tool calls → done
		if (toolCalls.length === 0 || !opts.toolHandler) {
			return {
				finalMessage: msg.content ?? '',
				steps, usage: totalUsage, cost: totalCost, model: opts.model,
				stoppedReason: 'natural',
			}
		}

		// run each tool call, append results, continue loop. check the
		// abort signal between every tool call so a fired timeout stops
		// the trial promptly rather than letting the remaining queued
		// calls run to completion past the wallclock cap. a tool call
		// already in flight cannot be interrupted here (each tool decides
		// what to do with cancellation on its own), but we bound the
		// BETWEEN-calls slack.
		const toolResults: { tool_call_id: string; content: string }[] = []
		for (const call of toolCalls) {
			if (opts.signal?.aborted) {
				if (toolResults.length > 0) {
					steps.push({ role: 'tool', content: null, tool_results: toolResults })
				}
				return {
					finalMessage: '',
					steps,
					usage: totalUsage,
					cost: totalCost,
					model: opts.model,
					stoppedReason: 'timeout',
				}
			}
			let result: string
			try { result = await opts.toolHandler(call) }
			catch (e) { result = `error: ${e instanceof Error ? e.message : String(e)}` }
			toolResults.push({ tool_call_id: call.id, content: result })
			messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result })
		}
		steps.push({ role: 'tool', content: null, tool_results: toolResults })
	}

	return {
		finalMessage: '', steps, usage: totalUsage, cost: totalCost, model: opts.model,
		stoppedReason: 'max-iters',
	}
}
