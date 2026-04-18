// with-cbm agent: text tools + codebase-memory-mcp tools.
// spawns CBM as a stdio mcp server, indexes the corpus once, then
// runs an LLM loop that has access to its 14 mcp tools alongside the
// shared read_file/grep/glob.
//
// install (one-time, per machine):
//   binary is `codebase-memory-mcp` (the project's actual name).
//   download from https://github.com/DeusData/codebase-memory-mcp
//   onto your PATH (or `codebase-memory-mcp install` for guided
//   setup). override path with CODEBASE_MEMORY_MCP_BIN env var.
//   running the binary with no args starts an MCP server on stdio.
//
// behavior:
//   - calls cbm.index_repository(path) once per (corpus, agent run)
//     before any task runs. atlas's runner pre-indexes through
//     ensureCorpus + engine.index; cbm has its own indexer so we
//     trigger it via the mcp tool.
//   - all 14 cbm tools are exposed verbatim — same names the LLM
//     would see in production (index_repository, search_graph,
//     query_graph, trace_path, get_code_snippet, get_graph_schema,
//     get_architecture, search_code, list_projects, delete_project,
//     index_status, detect_changes, manage_adr, ingest_traces).
//   - system prompt does NOT mention them by name; the LLM
//     discovers via the tool list.

import type { LlmAgentResult, LlmTaskInput } from '../lib/llm-agent.js'
import { runLlmAgent } from '../lib/llm-agent.js'
import { openMcpAgent } from '../lib/mcp-client.js'
import type { McpAgentHandle } from '../lib/mcp-client.js'
import { getCbmHandle } from '../lib/preconfigure.js'

const CBM_BIN = process.env.CODEBASE_MEMORY_MCP_BIN
	|| process.env.CBM_BIN
	|| 'codebase-memory-mcp'

// cached handles per corpus root so the bench doesn't respawn cbm
// (and re-index!) for every trial. preconfigure populates these
// before any LLM jobs run; this fallback path covers running an
// agent without preconfigure (e.g. one-off --task call).
const handles = new Map<string, Promise<McpAgentHandle>>()

async function getHandle(corpusRoot: string): Promise<McpAgentHandle> {
	const pre = getCbmHandle(corpusRoot)
	if (pre) return pre
	let p = handles.get(corpusRoot)
	if (!p) {
		p = openMcpAgent({
			name: 'cbm',
			command: CBM_BIN,
			args: [],
			init: async (callTool, root) => {
				// cbm's tool param is `repo_path`, not `path`.
				await callTool('index_repository', { repo_path: root })
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
	// cbm tools ONLY, no text fallback. isolates cbm's native capability
	// the same way with-atlas and with-chunkhound are isolated.
	const cbm = await getHandle(opts.corpusRoot)
	return runLlmAgent({
		model: opts.model,
		task: opts.task,
		tools: cbm.tools,
		toolHandler: cbm.handler,
	})
}

export async function closeCbmAgents(): Promise<void> {
	for (const p of handles.values()) {
		try { (await p).close() } catch { /* ignore */ }
	}
	handles.clear()
}
