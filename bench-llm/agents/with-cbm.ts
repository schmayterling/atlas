// with-cbm agent: text tools + codebase-memory-mcp tools.
// spawns CBM as a stdio mcp server, indexes the corpus once, then
// runs an LLM loop that has access to its 14 mcp tools alongside the
// shared read_file/grep/glob.
//
// install (one-time, per machine):
//   download from https://github.com/DeusData/codebase-memory-mcp/releases
//   the `cbm-mcp` binary onto your PATH (or export CBM_BIN).
//
// behavior:
//   - calls cbm.index_repository(path) once per (corpus, agent run)
//     before any task runs. atlas's runner pre-indexes through
//     ensureCorpus + engine.index; cbm has its own indexer so we
//     trigger it via the mcp tool.
//   - all 14 cbm tools are exposed verbatim — same names the LLM
//     would see in production. system prompt does NOT mention them
//     by name; the LLM discovers via the tool list.

import type { LlmAgentResult, LlmTaskInput } from '../lib/llm-agent.js'
import { runLlmAgent } from '../lib/llm-agent.js'
import { TEXT_TOOLS, makeTextHandler } from '../lib/text-tools.js'
import { openMcpAgent } from '../lib/mcp-client.js'
import type { McpAgentHandle } from '../lib/mcp-client.js'
import type { ToolCall } from '../lib/openrouter.js'

const CBM_BIN = process.env.CBM_BIN || 'cbm-mcp'

// cached handles per corpus root so the bench doesn't respawn cbm
// (and re-index!) for every trial.
const handles = new Map<string, Promise<McpAgentHandle>>()

async function getHandle(corpusRoot: string): Promise<McpAgentHandle> {
	let p = handles.get(corpusRoot)
	if (!p) {
		p = openMcpAgent({
			name: 'cbm',
			command: CBM_BIN,
			args: ['serve', '--stdio'],
			init: async (callTool, root) => {
				// indexing is required before search/trace/etc. work.
				// errors here surface to the runner as agent error.
				await callTool('index_repository', { path: root })
			},
		}, corpusRoot)
		handles.set(corpusRoot, p)
	}
	return p
}

export async function runWithCbmAgent(opts: {
	model: string
	task: LlmTaskInput
	corpusRoot: string
}): Promise<LlmAgentResult> {
	const cbm = await getHandle(opts.corpusRoot)
	const textHandler = makeTextHandler(opts.corpusRoot)
	const handler = async (call: ToolCall) => {
		// dispatch by tool name. cbm tools don't share a prefix; they're
		// listed by name (index_repository, search_graph, trace_call_path,
		// query_graph, etc.). we know what cbm.tools is — anything else
		// is text-tools.
		const cbmNames = new Set(cbm.tools.map((t) => t.function.name))
		if (cbmNames.has(call.function.name)) return cbm.handler(call)
		return textHandler(call)
	}
	return runLlmAgent({
		model: opts.model,
		task: opts.task,
		tools: [...TEXT_TOOLS, ...cbm.tools],
		toolHandler: handler,
	})
}

export async function closeCbmAgents(): Promise<void> {
	for (const p of handles.values()) {
		try { (await p).close() } catch { /* ignore */ }
	}
	handles.clear()
}
