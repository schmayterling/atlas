// with-chunkhound agent: text tools + chunkhound's mcp tools.
// chunkhound is semantic-RAG-first (cAST chunking + embedding
// retrieval + LLM-driven research orchestration). it has 3 mcp tools:
// semantic search, regex search, and code research. atlas's call
// tracing / blast radius / test coverage are NOT in its surface.
//
// install (one-time):
//   pip install chunkhound
//
// embedding backend (this benchmark):
//   bench-llm/config/chunkhound.json points chunkhound at the local
//   ollama server (http://localhost:11434/v1) with the
//   nomic-embed-text model. that's the same embedding atlas uses, so
//   neither tool gets a quality advantage from a paid embedding tier.
//   to swap models or providers, edit the config file directly.
//
// behavior:
//   - chunkhound process is spawned with cwd=corpusRoot so its
//     project-local .chunkhound directory lands inside the cached
//     clone, not in atlas's repo.
//   - CHUNKHOUND_CONFIG_FILE env var points at the shared bench
//     config so every corpus shares one embedding backend.
//   - lazy indexing: first semantic_search query triggers embedding
//     of the corpus. expect a one-time delay on the first task per
//     corpus (proportional to file count + embedding model speed).

import { resolve } from 'node:path'
import type { LlmAgentResult, LlmTaskInput } from '../lib/llm-agent.js'
import { runLlmAgent } from '../lib/llm-agent.js'
import { TEXT_TOOLS, makeTextHandler } from '../lib/text-tools.js'
import { openMcpAgent } from '../lib/mcp-client.js'
import type { McpAgentHandle } from '../lib/mcp-client.js'
import type { ToolCall } from '../lib/openrouter.js'
import { getChunkhoundHandle } from '../lib/preconfigure.js'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const CHUNKHOUND_BIN = process.env.CHUNKHOUND_BIN || 'chunkhound'
const CHUNKHOUND_CONFIG = process.env.CHUNKHOUND_CONFIG_FILE
	|| resolve(REPO_ROOT, 'bench-llm', 'config', 'chunkhound.json')

const handles = new Map<string, Promise<McpAgentHandle>>()

async function getHandle(corpusRoot: string): Promise<McpAgentHandle> {
	const pre = getChunkhoundHandle(corpusRoot)
	if (pre) return pre
	let p = handles.get(corpusRoot)
	if (!p) {
		p = openMcpAgent({
			name: 'chunkhound',
			command: CHUNKHOUND_BIN,
			args: ['mcp', '--stdio'],
			cwd: corpusRoot,
			env: {
				...process.env,
				CHUNKHOUND_CONFIG_FILE: CHUNKHOUND_CONFIG,
			} as Record<string, string>,
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
