import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AtlasEngine } from '../core/engine.js'
import { formatBlast, formatDeadCode, formatDeps, formatSearch, formatStatus, formatTrace } from './formatters.js'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

async function safe(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await fn()
	} catch (e) {
		return { content: [{ type: 'text' as const, text: `error: ${e}` }], isError: true }
	}
}

export async function startMcpServer(projectRoot: string) {
	const engine = new AtlasEngine(projectRoot)

	const server = new McpServer(
		{ name: 'atlas', version: '0.1.0' },
		{
			instructions:
				'atlas indexes codebases and answers structural questions about code. call atlas_status first to check if the index is fresh. use atlas_search for symbol lookup, atlas_semantic_search for natural language queries, atlas_deps for dependency graphs, atlas_blast_radius for change impact analysis, atlas_trace for execution path tracing, and atlas_dead_code for finding unreferenced symbols.',
		},
	)

	// --- atlas_status ---
	server.tool('atlas_status', 'check index health, freshness, and statistics', {}, () =>
		safe(() => ({ content: [{ type: 'text' as const, text: formatStatus(engine.status()) }] })),
	)

	// --- atlas_search ---
	server.tool(
		'atlas_search',
		'search for symbols (functions, classes, types) by name or pattern',
		{
			query: z.string().describe('symbol name or pattern to search for'),
			kind: z
				.enum(['function', 'class', 'method', 'interface', 'type', 'variable', 'module', 'enum', 'property'])
				.optional()
				.describe('filter by symbol kind'),
			limit: z.number().optional().describe('max results (default 20)'),
		},
		({ query, kind, limit }) => safe(() => {
			const result = engine.search(query, { kind, limit })
			return { content: [{ type: 'text' as const, text: formatSearch(result) }] }
		}),
	)

	// --- atlas_semantic_search ---
	server.tool(
		'atlas_semantic_search',
		'search code by meaning using natural language (requires Ollama embeddings)',
		{
			query: z.string().describe('natural language description of what to find'),
			limit: z.number().optional().describe('max results (default 10)'),
		},
		({ query, limit }) => safe(async () => {
			const result = await engine.semanticSearch(query, { limit })
			if (!result.embeddingsAvailable) {
				return { content: [{ type: 'text' as const, text: 'embeddings not available. run `atlas index` with Ollama running.' }] }
			}
			return { content: [{ type: 'text' as const, text: formatSearch({ query, total: result.results.length, results: result.results }) }] }
		}),
	)

	// --- atlas_resolve_symbol ---
	server.tool(
		'atlas_resolve_symbol',
		'get detailed info about a specific symbol including signature, location, and relationship counts',
		{
			symbol: z.string().describe('symbol name or file:name reference'),
		},
		({ symbol }) => safe(() => {
			const result = engine.resolveSymbol(symbol)
			if (!result) return { content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }], isError: true }
			const text = `${result.kind} ${result.name}\n  file: ${result.filePath}:${result.lineStart}\n  signature: ${result.signature ?? 'none'}\n  exported: ${result.isExported}\n  usages: ${result.usageCount}, dependents: ${result.dependentCount}`
			return { content: [{ type: 'text' as const, text }] }
		}),
	)

	// --- atlas_deps ---
	server.tool(
		'atlas_deps',
		'get dependency graph for a symbol (what it depends on and what depends on it)',
		{
			symbol: z.string().describe('symbol name or file:name reference'),
			direction: z.enum(['upstream', 'downstream', 'both']).optional().describe('dependency direction (default: both)'),
			depth: z.number().optional().describe('max traversal depth (default 3)'),
		},
		({ symbol, direction, depth }) => safe(() => {
			const result = engine.deps(symbol, { direction, depth })
			if (!result) return { content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }], isError: true }
			return { content: [{ type: 'text' as const, text: formatDeps(result) }] }
		}),
	)

	// --- atlas_blast_radius ---
	server.tool(
		'atlas_blast_radius',
		'analyze what code would be affected if a symbol or file changes',
		{
			target: z.string().describe('symbol name, file path, or file:line'),
			depth: z.number().optional().describe('max propagation depth (default 5)'),
		},
		({ target, depth }) => safe(() => {
			const result = engine.blast(target, { depth })
			if (!result) return { content: [{ type: 'text' as const, text: `symbol not found: ${target}` }], isError: true }
			return { content: [{ type: 'text' as const, text: formatBlast(result) }] }
		}),
	)

	// --- atlas_trace ---
	server.tool(
		'atlas_trace',
		'find execution paths between two symbols (how does code flow from A to B)',
		{
			from: z.string().describe('source symbol name'),
			to: z.string().describe('target symbol name'),
			maxPaths: z.number().optional().describe('max paths to return (default 5)'),
			maxDepth: z.number().optional().describe('max path depth (default 10)'),
		},
		({ from, to, maxPaths, maxDepth }) => safe(() => {
			const result = engine.trace(from, to, { maxPaths, maxDepth })
			if (!result) return { content: [{ type: 'text' as const, text: `could not resolve both symbols: "${from}" and "${to}"` }], isError: true }
			return { content: [{ type: 'text' as const, text: formatTrace(result) }] }
		}),
	)

	// --- atlas_dead_code ---
	server.tool(
		'atlas_dead_code',
		'find unreferenced symbols (potential dead code)',
		{
			path: z.string().optional().describe('filter by file path'),
			kind: z
				.enum(['function', 'class', 'method', 'interface', 'type', 'variable', 'module', 'enum', 'property'])
				.optional()
				.describe('filter by symbol kind'),
		},
		({ path, kind }) => safe(() => {
			const result = engine.deadCode({ path, kind })
			return { content: [{ type: 'text' as const, text: formatDeadCode(result) }] }
		}),
	)

	const transport = new StdioServerTransport()
	await server.connect(transport)
}
