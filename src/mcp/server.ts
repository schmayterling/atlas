import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AtlasEngine } from '../core/engine.js'
import { getOrCreateEngine } from '../core/engine-pool.js'
import { log } from '../shared/logger.js'
import {
	formatBlast,
	formatDeadCode,
	formatDeps,
	formatSearch,
	formatStatus,
	formatTrace,
} from './formatters.js'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

async function safe(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await fn()
	} catch (e) {
		log.error(`mcp tool: ${e instanceof Error ? e.stack : e}`)
		return { content: [{ type: 'text' as const, text: `error: ${e}` }], isError: true }
	}
}

export function createMcpServer(engine: AtlasEngine): McpServer {
	const server = new McpServer(
		{ name: 'atlas', version: '0.1.0' },
		{
			instructions:
				'atlas indexes codebases and answers structural questions about code. call atlas_status first to check if the index is fresh. use atlas_search for symbol lookup, atlas_semantic_search for natural language queries, atlas_deps for dependency graphs, atlas_blast_radius for change impact analysis, atlas_trace for execution path tracing, atlas_dead_code for finding unreferenced symbols, atlas_test_coverage to see which test files exercise a symbol, and atlas_hot_fragile to rank files by churn × untested-symbol count.',
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
				.enum([
					'function',
					'class',
					'method',
					'interface',
					'type',
					'variable',
					'module',
					'enum',
					'property',
				])
				.optional()
				.describe('filter by symbol kind'),
			limit: z.number().optional().describe('max results (default 20)'),
		},
		({ query, kind, limit }) =>
			safe(() => {
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
		({ query, limit }) =>
			safe(async () => {
				const result = await engine.semanticSearch(query, { limit })
				if (!result.embeddingsAvailable) {
					return {
						content: [
							{
								type: 'text' as const,
								text: 'embeddings not available. run `atlas index` with Ollama running.',
							},
						],
					}
				}
				return {
					content: [
						{
							type: 'text' as const,
							text: formatSearch({ query, total: result.results.length, results: result.results }),
						},
					],
				}
			}),
	)

	// --- atlas_resolve_symbol ---
	server.tool(
		'atlas_resolve_symbol',
		'get detailed info about a specific symbol including signature, location, and relationship counts',
		{
			symbol: z.string().describe('symbol name or file:name reference'),
		},
		({ symbol }) =>
			safe(() => {
				const result = engine.resolveSymbol(symbol)
				if (!result)
					return {
						content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }],
						isError: true,
					}
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
			direction: z
				.enum(['upstream', 'downstream', 'both'])
				.optional()
				.describe('dependency direction (default: both)'),
			depth: z.number().optional().describe('max traversal depth (default 3)'),
		},
		({ symbol, direction, depth }) =>
			safe(() => {
				const result = engine.deps(symbol, { direction, depth })
				if (!result)
					return {
						content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }],
						isError: true,
					}
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
		({ target, depth }) =>
			safe(() => {
				const result = engine.blast(target, { depth })
				if (!result)
					return {
						content: [{ type: 'text' as const, text: `symbol not found: ${target}` }],
						isError: true,
					}
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
		({ from, to, maxPaths, maxDepth }) =>
			safe(() => {
				const result = engine.trace(from, to, { maxPaths, maxDepth })
				if (!result)
					return {
						content: [
							{
								type: 'text' as const,
								text: `could not resolve both symbols: "${from}" and "${to}"`,
							},
						],
						isError: true,
					}
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
				.enum([
					'function',
					'class',
					'method',
					'interface',
					'type',
					'variable',
					'module',
					'enum',
					'property',
				])
				.optional()
				.describe('filter by symbol kind'),
		},
		({ path, kind }) =>
			safe(() => {
				const result = engine.deadCode({ path, kind })
				return { content: [{ type: 'text' as const, text: formatDeadCode(result) }] }
			}),
	)

	// --- atlas_history ---
	server.tool(
		'atlas_history',
		'git commit history for a file (most recent first)',
		{
			file: z.string().describe('repo-relative file path'),
			limit: z.number().optional().describe('max commits to return (default 20)'),
		},
		({ file, limit }) =>
			safe(() => {
				const rows = engine.fileHistory(file).slice(0, limit ?? 20)
				if (rows.length === 0) {
					return { content: [{ type: 'text' as const, text: `no history for ${file}` }] }
				}
				const lines = rows.map((r) => {
					const date = new Date(r.authoredAt).toISOString().slice(0, 10)
					return `${date}  ${r.hash.slice(0, 7)}  ${r.authorName}  ${r.status}  ${r.subject}`
				})
				return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
			}),
	)

	// --- atlas_subsystems ---
	server.tool(
		'atlas_subsystems',
		'list detected subsystems (high-level modules from graph clustering)',
		{},
		() =>
			safe(() => {
				const rows = engine.subsystems()
				if (rows.length === 0) {
					return { content: [{ type: 'text' as const, text: 'no subsystems detected' }] }
				}
				const lines = rows.map((r) => {
					const desc = r.description ? ` — ${r.description}` : ''
					return `${r.id}  ${String(r.fileCount).padStart(3)} files  conductance=${r.conductance.toFixed(2)}  ${r.name}${desc}`
				})
				return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
			}),
	)

	// --- atlas_subsystem ---
	server.tool(
		'atlas_subsystem',
		'detail for one subsystem (member files, top exported symbols)',
		{
			id: z.string().describe('subsystem id (16-hex content hash)'),
		},
		({ id }) =>
			safe(() => {
				const detail = engine.subsystem(id)
				if (!detail) {
					return {
						content: [{ type: 'text' as const, text: `subsystem ${id} not found` }],
						isError: true,
					}
				}
				const parts: string[] = []
				parts.push(`subsystem: ${detail.name}`)
				if (detail.description) parts.push(`description: ${detail.description}`)
				parts.push(`conductance: ${detail.conductance.toFixed(2)}`)
				parts.push(`\nfiles (${detail.files.length}):`)
				for (const f of detail.files) parts.push(`  ${f.path}`)
				if (detail.topSymbols.length > 0) {
					parts.push(`\ntop exported symbols:`)
					for (const s of detail.topSymbols) parts.push(`  ${s.kind.padEnd(10)} ${s.name}  (${s.filePath})`)
				}
				return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
			}),
	)

	// --- atlas_churn ---
	server.tool(
		'atlas_churn',
		'hot files ranked by commit count (optionally filtered by path prefix)',
		{
			path: z.string().optional().describe('only files starting with this path prefix'),
			limit: z.number().optional().describe('max files to return (default 20)'),
			sinceDays: z
				.number()
				.optional()
				.describe('only count commits from the last N days'),
		},
		({ path, limit, sinceDays }) =>
			safe(() => {
				const since = sinceDays ? Date.now() - sinceDays * 86400_000 : undefined
				const rows = engine.churn({ pathPrefix: path, limit: limit ?? 20, since })
				if (rows.length === 0) {
					return { content: [{ type: 'text' as const, text: 'no churn data available' }] }
				}
				const lines = rows.map((r) => {
					const date = new Date(r.lastTouchedAt).toISOString().slice(0, 10)
					return `${String(r.commits).padStart(4)} commits  ${date}  ${r.topAuthor.padEnd(20)}  ${r.filePath}`
				})
				return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
			}),
	)

	// --- atlas_test_coverage ---
	server.tool(
		'atlas_test_coverage',
		'show test files that cover a symbol (imported or called)',
		{
			symbol: z.string().describe('symbol name or qualifiedName'),
		},
		({ symbol }) =>
			safe(() => {
				const result = engine.testCoverage(symbol)
				if (!result) {
					return { content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }], isError: true }
				}
				if (result.tests.length === 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: `${result.target.name} (${result.target.filePath}:${result.target.lineStart})\ncoverage: none`,
							},
						],
					}
				}
				const lines = [
					`${result.target.name} (${result.target.filePath}:${result.target.lineStart})`,
					`coverage: ${result.coveredBy}`,
					'',
					...result.tests.map((t) => `  ${t.confidence.padEnd(8)}  ${t.testFilePath}`),
				]
				return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
			}),
	)

	// --- atlas_hot_fragile ---
	server.tool(
		'atlas_hot_fragile',
		'rank files by churn × untested-symbol count (high-risk refactor candidates)',
		{
			limit: z.number().optional().describe('max files to return (default 20)'),
		},
		({ limit }) =>
			safe(() => {
				const rows = engine.hotFragile({ limit: limit ?? 20 })
				if (rows.length === 0) {
					return { content: [{ type: 'text' as const, text: 'no hot-fragile files (need git history + test_links)' }] }
				}
				const lines = rows.map((r) => {
					// render from the explicit score fields (#43) — no ad hoc
					// commits * untestedCount math here anymore. preview shows
					// the file's own first-3 untested callables (#24).
					const preview = r.previewNames.length > 0 ? `  [${r.previewNames.join(', ')}]` : ''
					return `${String(r.fragilityScore).padStart(5)}  ${String(r.churnScore).padStart(4)}c ${String(r.untestedCount).padStart(3)}/${String(r.symbolCount).padStart(3)} untested  ${r.filePath}${preview}`
				})
				return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
			}),
	)

	return server
}

export async function startMcpServer(projectRoot: string) {
	// route through the engine pool so `atlas use <id>` steers the stdio
	// MCP server the same way it steers the CLI and web surfaces. falls
	// back to projectRoot when no project is registered.
	const engine = getOrCreateEngine(undefined, projectRoot)
	const server = createMcpServer(engine)
	const transport = new StdioServerTransport()
	await server.connect(transport)
}
