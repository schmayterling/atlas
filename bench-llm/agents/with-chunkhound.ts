// with-chunkhound agent: text tools + chunkhound's mcp tools.
// chunkhound is semantic-RAG-first (cAST chunking + embedding
// retrieval + LLM-driven research orchestration). it has 3 mcp tools:
// semantic search, regex search, and code research. atlas's call
// tracing / blast radius / test coverage are NOT in its surface.
//
// install (one-time):
//   pip install chunkhound
//   export VOYAGE_API_KEY=... (or OPENAI_API_KEY for embeddings)
//
// behavior:
//   - chunkhound auto-discovers files on first query; we pass the
//     corpus root as cwd to the spawned process.
//   - no explicit init step; semantic indexing happens lazily on
//     first search (which can add a one-time cost to the first task).

import type { LlmAgentResult, LlmTaskInput } from '../lib/llm-agent.js'
import { runLlmAgent } from '../lib/llm-agent.js'
import { TEXT_TOOLS, makeTextHandler } from '../lib/text-tools.js'
import { openMcpAgent } from '../lib/mcp-client.js'
import type { McpAgentHandle } from '../lib/mcp-client.js'
import type { ToolCall } from '../lib/openrouter.js'

const CHUNKHOUND_BIN = process.env.CHUNKHOUND_BIN || 'chunkhound'

const handles = new Map<string, Promise<McpAgentHandle>>()

async function getHandle(corpusRoot: string): Promise<McpAgentHandle> {
	let p = handles.get(corpusRoot)
	if (!p) {
		p = openMcpAgent({
			name: 'chunkhound',
			command: CHUNKHOUND_BIN,
			args: ['mcp', '--cwd', corpusRoot],
		}, corpusRoot)
		handles.set(corpusRoot, p)
	}
	return p
}

export async function runWithChunkhoundAgent(opts: {
	model: string
	task: LlmTaskInput
	corpusRoot: string
}): Promise<LlmAgentResult> {
	const ch = await getHandle(opts.corpusRoot)
	const textHandler = makeTextHandler(opts.corpusRoot)
	const handler = async (call: ToolCall) => {
		const chNames = new Set(ch.tools.map((t) => t.function.name))
		if (chNames.has(call.function.name)) return ch.handler(call)
		return textHandler(call)
	}
	return runLlmAgent({
		model: opts.model,
		task: opts.task,
		tools: [...TEXT_TOOLS, ...ch.tools],
		toolHandler: handler,
	})
}

export async function closeChunkhoundAgents(): Promise<void> {
	for (const p of handles.values()) {
		try { (await p).close() } catch { /* ignore */ }
	}
	handles.clear()
}
