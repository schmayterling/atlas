// generic mcp-client wrapper. spawns an external mcp server over
// stdio, handshakes, lists tools, exposes them to the LLM via the
// OpenAI tool-call format. lets bench-llm compare atlas, CBM, and
// chunkhound on the same task set under identical conditions.
//
// the server process is owned by this module — it's spawned per agent
// run and torn down on close(). multiple bench-llm trials share one
// server when the caller pools through openMcpAgent + agent.close().
//
// design choices:
// - tool name prefix is preserved as-is (no remapping). the LLM sees
//   chunkhound's `semantic_search`, CBM's `search_graph`, atlas's
//   `atlas_search` etc. — that's correct for measuring "what an
//   agent does when given THIS specific tool surface."
// - a per-tool init() hook lets each agent index the corpus before
//   the first task. CBM needs explicit `index_repository`; atlas
//   indexes via the engine; chunkhound auto-discovers on first query.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { OpenRouterTool, ToolCall } from './openrouter.js'

export interface McpAgentSpec {
	// human-friendly id used in result rows ('cbm', 'chunkhound')
	name: string
	// command + args to spawn the mcp server. inherits the parent env
	// unless `env` is set.
	command: string
	args: string[]
	env?: Record<string, string>
	// optional one-shot init called once per corpus before the first
	// LLM call. e.g. CBM: { name: 'index_repository', args: { path } }
	init?: (callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>, corpusRoot: string) => Promise<void>
	// optional: drop tools by name. some tools (e.g. atlas's `atlas_dead_code`)
	// might be too expensive to expose to the LLM in a benchmark.
	allowTools?: string[]
}

export interface McpAgentHandle {
	tools: OpenRouterTool[]
	handler: (call: ToolCall) => Promise<string>
	close: () => Promise<void>
}

const RESPONSE_LIMIT = 24_000

export async function openMcpAgent(spec: McpAgentSpec, corpusRoot: string): Promise<McpAgentHandle> {
	const transport = new StdioClientTransport({
		command: spec.command,
		args: spec.args,
		env: spec.env,
	})
	const client = new Client({ name: 'bench-llm', version: '0.0.1' })
	await client.connect(transport)

	const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
		const r = await client.callTool({ name, arguments: args })
		return r
	}

	if (spec.init) await spec.init(callTool, corpusRoot)

	const listing = await client.listTools()
	const allow = spec.allowTools ? new Set(spec.allowTools) : null
	const tools: OpenRouterTool[] = []
	for (const t of listing.tools) {
		if (allow && !allow.has(t.name)) continue
		tools.push({
			type: 'function',
			function: {
				name: t.name,
				description: t.description ?? '',
				parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
			},
		})
	}

	const handler = async (call: ToolCall): Promise<string> => {
		const args = (() => { try { return JSON.parse(call.function.arguments) } catch { return {} } })() as Record<string, unknown>
		try {
			const result = await callTool(call.function.name, args)
			const text = serialize(result)
			return text.length > RESPONSE_LIMIT ? `${text.slice(0, RESPONSE_LIMIT)}\n[truncated at ${RESPONSE_LIMIT} chars]` : text
		} catch (e) {
			return `error: ${e instanceof Error ? e.message : String(e)}`
		}
	}

	return {
		tools,
		handler,
		close: async () => {
			try { await client.close() } catch { /* ignore */ }
		},
	}
}

// mcp tool results commonly come back as { content: [{ type: 'text',
// text: '...' }] }. extract the text payload when possible; otherwise
// stringify the whole thing.
function serialize(result: unknown): string {
	if (result && typeof result === 'object' && 'content' in result) {
		const content = (result as { content: unknown }).content
		if (Array.isArray(content)) {
			const textParts: string[] = []
			for (const part of content) {
				if (part && typeof part === 'object' && 'text' in part) textParts.push(String((part as { text: unknown }).text))
				else textParts.push(JSON.stringify(part))
			}
			return textParts.join('\n')
		}
	}
	return JSON.stringify(result, null, 2)
}
