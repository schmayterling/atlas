// baseline LLM agent: tools = read_file + grep + glob (no atlas).
// uses openrouter so any chat-completion model works (default haiku 4.5).
//
// the agent loop, response parsing, and tool definitions all live in
// bench-llm/lib/. this file is just the wiring.

import type { LlmAgentResult, LlmTaskInput } from '../lib/llm-agent.js'
import { runLlmAgent } from '../lib/llm-agent.js'
import { TEXT_TOOLS, makeTextHandler } from '../lib/text-tools.js'

export async function runBaselineAgent(opts: {
	model: string
	task: LlmTaskInput
	corpusRoot: string
}): Promise<LlmAgentResult> {
	return runLlmAgent({
		model: opts.model,
		task: opts.task,
		tools: TEXT_TOOLS,
		toolHandler: makeTextHandler(opts.corpusRoot),
	})
}
