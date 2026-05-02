import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getOrCreateEngine } from '../core/engine-pool.js'
import type { AtlasEngine } from '../core/engine.js'
import { log } from '../shared/logger.js'
import { EDGE_KINDS, type EdgeKind, SYMBOL_KINDS, type SymbolKind } from '../shared/types.js'
import {
	formatBlast,
	formatCallSites,
	formatDeadCode,
	formatDeps,
	formatFileOutline,
	formatFiles,
	formatHotspots,
	formatOverview,
	formatSearch,
	formatSignature,
	formatStatus,
	formatTrace,
} from './formatters.js'

type ToolResult = {
	content: { type: 'text'; text: string }[]
	structuredContent?: Record<string, unknown>
	isError?: boolean
}

const FAST_TRACE_EDGE_KINDS: EdgeKind[] = ['calls', 'passed_as', 'dispatches_to', 'instantiates']
const FULL_TRACE_EDGE_KINDS: EdgeKind[] = [...EDGE_KINDS]

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback
	return Math.min(Math.max(Math.trunc(value), min), max)
}

function traceEdgeKinds(
	preset: 'fast' | 'full' | undefined,
	edgeKinds: EdgeKind[] | undefined,
): EdgeKind[] | undefined {
	if (edgeKinds && edgeKinds.length > 0) return edgeKinds
	if (preset === 'fast') return FAST_TRACE_EDGE_KINDS
	if (preset === 'full') return FULL_TRACE_EDGE_KINDS
	return undefined
}

// detect whether the index's recorded git commit matches the project's
// current HEAD. returns a machine-readable prefix that agents can parse
// (or ignore) when mismatched, and null otherwise. atlas_status is
// exempt because it already exposes the raw lastCommit field and a
// duplicate prefix would just be noise. see #82.
//
// uses the narrow engine.getLastIndexedCommit() instead of engine.status()
// so a freshness check does not pay for 6 table counts + a statSync per
// MCP tool call. getCurrentCommit is cached with a short TTL so agent
// sessions with dozens of tool calls do not fork `git rev-parse` for
// every one. see deep-review pass 5 findings.
const STALE_HEAD_TTL_MS = 5_000
const headCache = new WeakMap<AtlasEngine, { sha: string | null; ts: number }>()

function readHead(engine: AtlasEngine): string | null {
	const now = Date.now()
	const hit = headCache.get(engine)
	if (hit && now - hit.ts < STALE_HEAD_TTL_MS) return hit.sha
	const sha = engine.getCurrentCommit()
	headCache.set(engine, { sha, ts: now })
	return sha
}

// test hook: tests that swap engine.getCurrentCommit between cases
// need the TTL cache cleared so the next readHead() actually calls the
// stub. not exported for production consumers.
export function _resetStalenessCacheForTests(engine: AtlasEngine) {
	headCache.delete(engine)
}

function stalenessPrefix(engine: AtlasEngine): string | null {
	try {
		const indexed = engine.getLastIndexedCommit()
		if (!indexed) return null
		const current = readHead(engine)
		if (!current) return null
		if (indexed === current) return null
		return `[atlas-index-stale: indexed at ${indexed.slice(0, 7)}, HEAD at ${current.slice(0, 7)}. results may be out of date; run \`atlas index\` to refresh.]\n`
	} catch (e) {
		// CLAUDE.md: "don't catch and log.debug() failures from pipelines
		// that users care about. use log.warn so silent failures are
		// visible." the staleness signal is user-facing; if the check
		// itself breaks, the user needs to know it went quiet.
		log.warn(`stalenessPrefix: check failed (${e instanceof Error ? e.message : e})`)
		return null
	}
}

function withStaleness(engine: AtlasEngine, result: ToolResult): ToolResult {
	const prefix = stalenessPrefix(engine)
	if (!prefix) return result
	// prepend to the first text block so JSON consumers still get a
	// single combined payload. subsequent blocks are left untouched.
	if (result.content.length === 0) {
		return { ...result, content: [{ type: 'text' as const, text: prefix }] }
	}
	const [first, ...rest] = result.content
	return {
		...result,
		content: [{ type: 'text' as const, text: prefix + first.text }, ...rest],
	}
}

async function safe(
	fn: () => ToolResult | Promise<ToolResult>,
	engine?: AtlasEngine,
): Promise<ToolResult> {
	try {
		const result = await fn()
		return engine ? withStaleness(engine, result) : result
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
				'atlas indexes codebases and answers structural questions. routing rules:\n' +
				'  - "tell me about symbol X" → atlas_overview (one call returns identity + callers + callees + blast + tests + subsystem)\n' +
				'  - "find symbol by name" → atlas_search (exact/fuzzy name match; NOT content search)\n' +
				'  - "where does the parser handle errors" (intent, no exact name) → atlas_semantic_search (needs Ollama)\n' +
				'  - "how many files mention pcre2 / TODO / some string" → atlas_content_search (literal text, fixed-string)\n' +
				'  - "list files under X" → atlas_files (indexed file list with symbol counts)\n' +
				'  - "what is in file X" → atlas_file_outline (path or filePath, symbols + imports + importers, no source body)\n' +
				'  - "show me metadata for X" → atlas_symbol_detail; pass includeSource=true only when source is needed\n' +
				'  - "what depends on X / what does X call" → atlas_deps, atlas_call_sites, atlas_trace (preset=fast for low-latency traces, preset=full for structural traces)\n' +
				'  - "impact of changing X" → atlas_blast_radius\n' +
				'  - "which tests exercise X" → atlas_test_coverage\n' +
				'  - "is this symbol used" → atlas_dead_code\n' +
				'  - "which symbols are risky" → atlas_hotspots (fanin * churn * coverage)\n' +
				'  - "which files are risky" → atlas_hot_fragile (churn × untested-symbol count)\n' +
				'always call atlas_status first to check if the index is fresh.',
		},
	)

	// wrap passes the engine so withStaleness can prepend a warning
	// when the index's recorded commit drifts from current HEAD. see #82.
	const wrap = (fn: () => ToolResult | Promise<ToolResult>) => safe(fn, engine)

	// --- atlas_status ---
	// status intentionally skips the staleness prefix: lastCommit is
	// already part of the formatted body, and a duplicate prefix would
	// just clutter the tool whose job is to surface freshness.
	server.registerTool(
		'atlas_status',
		{
			description: 'check index health, freshness, and statistics',
			inputSchema: {},
			outputSchema: {
				projectRoot: z.string(),
				dbPath: z.string(),
				dbSizeBytes: z.number(),
				lastIndexedAt: z.number().nullable(),
				lastCommit: z.string().nullable(),
				lastBranch: z.string().nullable(),
				health: z.string(),
				staleFileCount: z.number(),
				stats: z.object({
					files: z.number(),
					symbols: z.number(),
					edges: z.number(),
				}),
				languages: z.record(z.string(), z.number()),
			},
		},
		() =>
			safe(() => {
				const result = engine.status()
				return {
					content: [{ type: 'text' as const, text: formatStatus(result) }],
					structuredContent: { ...result },
				}
			}),
	)

	// --- atlas_search ---
	// name-based symbol lookup. this tool ONLY matches symbol identifiers
	// (function/class/type/variable names). it does NOT search file contents,
	// comments, string literals, or arbitrary substrings; use atlas_content_search
	// for those. prefer atlas_overview when you want rich context on a single
	// known symbol rather than a list of candidates.
	server.registerTool(
		'atlas_search',
		{
			description:
				'Find symbols (functions, classes, types, variables) by exact or fuzzy name match. Only matches identifiers; for content/comment/substring search use atlas_content_search. For rich context on one known symbol use atlas_overview.',
			inputSchema: {
				query: z
					.string()
					.describe(
						'symbol identifier (e.g. "safeParse", "ZodObject"). NOT a file-content substring',
					),
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
			outputSchema: {
				query: z.string(),
				kind: z.string().nullable(),
				limit: z.number().nullable(),
				total: z.number(),
				results: z.array(z.unknown()),
			},
		},
		({ query, kind, limit }) =>
			wrap(() => {
				const result = engine.search(query, { kind, limit })
				return {
					content: [{ type: 'text' as const, text: formatSearch(result) }],
					structuredContent: {
						query,
						kind: kind ?? null,
						limit: limit ?? null,
						total: result.total,
						results: result.results,
					},
				}
			}),
	)

	// --- atlas_semantic_search ---
	// embedding-similarity search on symbol metadata + source body. use ONLY
	// when you don't know the exact symbol name and want to find by intent
	// (e.g. "where is the parser handling errors?"). does NOT search comments
	// or arbitrary substrings; for content search use atlas_content_search.
	server.registerTool(
		'atlas_semantic_search',
		{
			description:
				"Find symbols by meaning when you don't know an exact name. Uses embedding similarity. Does NOT search comments or substrings; use atlas_content_search for that. Requires Ollama with nomic-embed-text.",
			inputSchema: {
				query: z.string().describe('natural-language intent (e.g. "parser error handling")'),
				limit: z.number().optional().describe('max results (default 10)'),
			},
			outputSchema: {
				query: z.string(),
				limit: z.number().nullable(),
				embeddingsAvailable: z.boolean(),
				count: z.number(),
				results: z.array(z.unknown()),
			},
		},
		({ query, limit }) =>
			wrap(async () => {
				const result = await engine.semanticSearch(query, { limit })
				if (!result.embeddingsAvailable) {
					return {
						content: [
							{
								type: 'text' as const,
								text: 'embeddings not available. run `atlas index` with Ollama running.',
							},
						],
						structuredContent: {
							query: result.query,
							limit: limit ?? null,
							embeddingsAvailable: false,
							count: 0,
							results: [],
						},
					}
				}
				return {
					content: [
						{
							type: 'text' as const,
							text: formatSearch({ query, total: result.results.length, results: result.results }),
						},
					],
					structuredContent: {
						query: result.query,
						limit: limit ?? null,
						embeddingsAvailable: true,
						count: result.results.length,
						results: result.results,
					},
				}
			}),
	)

	// --- atlas_content_search ---
	// literal text search across indexed source files. this is the tool for
	// "how many files mention X as a substring" or "find TODOs / comments /
	// magic strings". backed by ripgrep; always fixed-string (no regex).
	server.registerTool(
		'atlas_content_search',
		{
			description:
				"Search indexed source files for a literal text substring (TODOs, comments, magic strings, any text that isn't a symbol name). Fixed-string only. Returns matching file paths + line numbers + text snippets and aggregate counts. For symbol-name lookup use atlas_search.",
			inputSchema: {
				query: z.string().describe('literal substring (no regex)'),
				pathPrefix: z
					.string()
					.optional()
					.describe('restrict search to files under this path prefix'),
				language: z
					.string()
					.optional()
					.describe('restrict to files of this language (e.g. "typescript", "rust")'),
				maxMatches: z.number().optional().describe('cap total matches (default 200)'),
			},
			outputSchema: {
				query: z.string(),
				pathPrefix: z.string().nullable(),
				language: z.string().nullable(),
				maxMatches: z.number().nullable(),
				counts: z.object({
					files: z.number(),
					matches: z.number(),
					returned: z.number(),
				}),
				matches: z.array(z.unknown()),
				warning: z.string().nullable(),
			},
		},
		({ query, pathPrefix, language, maxMatches }) =>
			wrap(() => {
				const result = engine.searchContent(query, { pathPrefix, language, maxMatches })
				const returnedMatches = result.matches.slice(0, 80)
				const lines: string[] = []
				lines.push(`query: ${result.query}`)
				lines.push(`files matched: ${result.fileCount} | total matches: ${result.matchCount}`)
				if (result.warning) lines.push(`warning: ${result.warning}`)
				for (const m of returnedMatches) {
					lines.push(`  ${m.file}:${m.line}  ${m.text}`)
				}
				if (result.matches.length > 80) lines.push(`  ... (+${result.matches.length - 80} more)`)
				return {
					content: [{ type: 'text' as const, text: lines.join('\n') }],
					structuredContent: {
						query: result.query,
						pathPrefix: pathPrefix ?? null,
						language: language ?? null,
						maxMatches: maxMatches ?? null,
						counts: {
							files: result.fileCount,
							matches: result.matchCount,
							returned: returnedMatches.length,
						},
						matches: returnedMatches,
						warning: result.warning ?? null,
					},
				}
			}),
	)

	// --- atlas_files ---
	server.registerTool(
		'atlas_files',
		{
			description:
				'List indexed files with language, symbol count, and size. Use before reading files when browsing by path prefix.',
			inputSchema: {
				pathPrefix: z
					.string()
					.optional()
					.describe('only files under this repo-relative path prefix'),
				language: z.string().optional().describe('filter by indexed language'),
				includeTests: z.boolean().optional().describe('include test files (default true)'),
				limit: z.number().optional().describe('max files to return (default 200, max 1000)'),
			},
			outputSchema: {
				files: z.array(z.unknown()),
				counts: z.object({ total: z.number(), returned: z.number() }),
				pathPrefix: z.string().nullable(),
				language: z.string().nullable(),
				includeTests: z.boolean(),
			},
		},
		({ pathPrefix, language, includeTests, limit }) =>
			wrap(() => {
				const maxFiles = clampInt(limit, 200, 1, 1000)
				const all = engine
					.files({ includeTests: includeTests ?? true })
					.filter((f) => !pathPrefix || f.path.startsWith(pathPrefix))
					.filter((f) => !language || f.language === language)
					.sort((a, b) => a.path.localeCompare(b.path))
				const files = all.slice(0, maxFiles)
				return {
					content: [
						{
							type: 'text' as const,
							text: formatFiles(files, {
								total: all.length,
								limit: maxFiles,
								pathPrefix,
								language,
							}),
						},
					],
					structuredContent: {
						files,
						counts: { total: all.length, returned: files.length },
						pathPrefix: pathPrefix ?? null,
						language: language ?? null,
						includeTests: includeTests ?? true,
					},
				}
			}),
	)

	// --- atlas_file_outline ---
	server.registerTool(
		'atlas_file_outline',
		{
			description:
				'Read a compact indexed outline for one file: symbols, imports, importers, and optional history. Does not include source.',
			inputSchema: {
				path: z.string().optional().describe('repo-relative file path'),
				filePath: z.string().optional().describe('alias for path'),
				symbolLimit: z
					.number()
					.optional()
					.describe('max symbols to list (default 80, max 300, 0 hides symbols)'),
				importLimit: z
					.number()
					.optional()
					.describe('max imports and importers to list (default 40, max 200, 0 hides them)'),
				includeHistory: z
					.boolean()
					.optional()
					.describe('include recent git/churn context (default false)'),
				kinds: z.array(z.enum(SYMBOL_KINDS)).optional().describe('only list these symbol kinds'),
				exportedOnly: z.boolean().optional().describe('only list exported symbols'),
			},
			outputSchema: {
				path: z.string(),
				language: z.string(),
				sizeBytes: z.number(),
				isTest: z.boolean(),
				counts: z.object({
					symbols: z.number(),
					totalSymbols: z.number(),
					imports: z.number(),
					importers: z.number(),
				}),
				filters: z.object({
					kinds: z.array(z.string()),
					exportedOnly: z.boolean(),
				}),
				symbols: z.array(z.unknown()),
				imports: z.array(z.unknown()),
				importers: z.array(z.unknown()),
				historyIncluded: z.boolean(),
				lastChanged: z.unknown().nullable(),
				contributors: z.array(z.unknown()),
				coChanged: z.array(z.unknown()),
			},
		},
		({ path, filePath, symbolLimit, importLimit, includeHistory, kinds, exportedOnly }) =>
			wrap(() => {
				const targetPath = path ?? filePath
				if (!targetPath) {
					return {
						content: [{ type: 'text' as const, text: 'file path required' }],
						isError: true,
					}
				}
				const result = engine.fileArticle(targetPath)
				if (!result) {
					return {
						content: [{ type: 'text' as const, text: `file not found: ${targetPath}` }],
						isError: true,
					}
				}
				const maxSymbols = clampInt(symbolLimit, 80, 0, 300)
				const maxImports = clampInt(importLimit, 40, 0, 200)
				const historyIncluded = includeHistory === true
				const kindFilter = kinds && kinds.length > 0 ? new Set<SymbolKind>(kinds) : null
				const filteredSymbols = result.symbols.filter(
					(sym) =>
						(exportedOnly !== true || sym.isExported) &&
						(kindFilter === null || kindFilter.has(sym.kind)),
				)
				const filters = [
					exportedOnly === true ? 'exportedOnly=true' : '',
					kindFilter ? `kinds=${[...kindFilter].join('|')}` : '',
				].filter(Boolean)
				return {
					content: [
						{
							type: 'text' as const,
							text: formatFileOutline(
								{ ...result, symbols: filteredSymbols },
								{
									symbolLimit: maxSymbols,
									importLimit: maxImports,
									includeHistory: historyIncluded,
									totalSymbols: result.symbols.length,
									filters,
								},
							),
						},
					],
					structuredContent: {
						path: result.path,
						language: result.language,
						sizeBytes: result.sizeBytes,
						isTest: result.isTest,
						counts: {
							symbols: filteredSymbols.length,
							totalSymbols: result.symbols.length,
							imports: result.imports.length,
							importers: result.importers.length,
						},
						filters: {
							kinds: kindFilter ? [...kindFilter] : [],
							exportedOnly: exportedOnly === true,
						},
						symbols: filteredSymbols.slice(0, maxSymbols),
						imports: result.imports.slice(0, maxImports),
						importers: result.importers.slice(0, maxImports),
						historyIncluded,
						lastChanged: historyIncluded ? result.lastChanged : null,
						contributors: historyIncluded ? result.contributors : [],
						coChanged: historyIncluded ? result.coChanged : [],
					},
				}
			}),
	)

	// --- atlas_symbol_detail ---
	// code-bearing lookup: returns symbol metadata, direct deps, cached LLM
	// summary (if any), AND the actual source body. use when you need to
	// "read" a symbol's code in one call rather than atlas_search + read_file.
	server.registerTool(
		'atlas_symbol_detail',
		{
			description:
				'Read compact symbol metadata, relationship counts, optional cached LLM summary, and optionally source. Defaults to metadata only; pass includeSource=true when code is needed.',
			inputSchema: {
				symbol: z.string().describe('symbol name or file::name reference'),
				includeSource: z
					.boolean()
					.optional()
					.describe('include source body (default false to save tokens)'),
				maxSourceChars: z
					.number()
					.optional()
					.describe('max source chars when includeSource=true (default 12000, max 50000)'),
			},
			outputSchema: {
				symbol: z.unknown(),
				upstreamCount: z.number(),
				downstreamCount: z.number(),
				sourceIncluded: z.boolean(),
				sourceTruncated: z.boolean(),
			},
		},
		({ symbol, includeSource, maxSourceChars }) =>
			wrap(async () => {
				const result = await engine.symbolDetail(symbol)
				if (!result) {
					return {
						content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }],
						isError: true,
					}
				}
				const s = result.symbol
				const sourceCap = clampInt(maxSourceChars, 12_000, 200, 50_000)
				const source = result.sourceCode ?? '(source unavailable)'
				const sourceTruncated = includeSource === true && source.length > sourceCap
				const sourceText = sourceTruncated
					? `${source.slice(0, sourceCap)}\n[truncated at ${sourceCap} chars]`
					: source
				const lines = [
					`${s.kind} ${s.name}  (${s.qualifiedName})`,
					`  ${s.filePath}:${s.lineStart}-${s.lineEnd}`,
					s.signature ? `  signature: ${formatSignature(s.signature, 180)}` : '',
					s.docComment ? `  doc: ${s.docComment.slice(0, 200)}` : '',
					result.summary ? `  summary: ${result.summary}` : '',
					`  upstream=${result.upstream.length} downstream=${result.downstream.length}`,
					includeSource === true ? '' : '  source: omitted (pass includeSource=true)',
					includeSource === true ? '--- source ---' : '',
					includeSource === true ? sourceText : '',
				].filter(Boolean)
				return {
					content: [{ type: 'text' as const, text: lines.join('\n') }],
					structuredContent: {
						symbol: s,
						upstreamCount: result.upstream.length,
						downstreamCount: result.downstream.length,
						sourceIncluded: includeSource === true,
						sourceTruncated,
					},
				}
			}),
	)

	// --- atlas_resolve_symbol ---
	server.registerTool(
		'atlas_resolve_symbol',
		{
			description:
				'get detailed info about a specific symbol including signature, location, and relationship counts',
			inputSchema: {
				symbol: z.string().describe('symbol name or file:name reference'),
			},
			outputSchema: {
				query: z.string(),
				symbol: z.unknown(),
			},
		},
		({ symbol }) =>
			wrap(() => {
				const result = engine.resolveSymbol(symbol)
				if (!result)
					return {
						content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }],
						isError: true,
					}
				const signature = result.signature ? formatSignature(result.signature, 180) : 'none'
				const text = `${result.kind} ${result.name}\n  file: ${result.filePath}:${result.lineStart}\n  signature: ${signature}\n  exported: ${result.isExported}\n  usages: ${result.usageCount}, dependents: ${result.dependentCount}`
				return {
					content: [{ type: 'text' as const, text }],
					structuredContent: {
						query: symbol,
						symbol: result,
					},
				}
			}),
	)

	// --- atlas_overview ---
	// one-shot bundle for "tell me about X" queries. returns identity +
	// upstream callers + downstream callees + blast radius count +
	// test coverage + subsystem in a single tool call, so an agent
	// doesn't chain resolve/deps/blast/test_coverage/subsystem. lists
	// are capped to `limit` (default 10) so the payload stays bounded.
	server.registerTool(
		'atlas_overview',
		{
			description:
				'comprehensive overview of a symbol: identity, callers, callees, blast radius, test coverage, subsystem (single tool call instead of chaining 5+)',
			inputSchema: {
				symbol: z.string().describe('symbol name or file:name reference'),
				depth: z.number().optional().describe('max traversal depth for deps and blast (default 2)'),
				limit: z.number().optional().describe('max entries per list section (default 10)'),
			},
			outputSchema: {
				query: z.string(),
				depth: z.number().nullable(),
				limit: z.number().nullable(),
				symbol: z.unknown(),
				upstream: z.array(z.unknown()),
				downstream: z.array(z.unknown()),
				blastRadius: z.unknown(),
				testCoverage: z.object({}).passthrough().nullable(),
				subsystem: z.object({}).passthrough().nullable(),
			},
		},
		({ symbol, depth, limit }) =>
			wrap(() => {
				const result = engine.overview(symbol, { depth, limit })
				if (!result) {
					return {
						content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }],
						isError: true,
					}
				}
				return {
					content: [{ type: 'text' as const, text: formatOverview(result) }],
					structuredContent: {
						query: symbol,
						depth: depth ?? null,
						limit: limit ?? null,
						symbol: result.symbol,
						upstream: result.upstream,
						downstream: result.downstream,
						blastRadius: result.blastRadius,
						testCoverage: result.testCoverage,
						subsystem: result.subsystem,
					},
				}
			}),
	)

	// --- atlas_deps ---
	server.registerTool(
		'atlas_deps',
		{
			description: 'get dependency graph for a symbol (what it depends on and what depends on it)',
			inputSchema: {
				symbol: z.string().describe('symbol name or file:name reference'),
				direction: z
					.enum(['upstream', 'downstream', 'both'])
					.optional()
					.describe('dependency direction (default: both)'),
				depth: z.number().optional().describe('max traversal depth (default 3)'),
			},
			outputSchema: {
				symbol: z.unknown(),
				direction: z.enum(['upstream', 'downstream', 'both']),
				depth: z.number().nullable(),
				upstream: z.array(z.unknown()),
				downstream: z.array(z.unknown()),
				stats: z.unknown(),
				truncated: z.boolean(),
				truncationReason: z.string().optional(),
			},
		},
		({ symbol, direction, depth }) =>
			wrap(() => {
				const result = engine.deps(symbol, { direction, depth })
				if (!result)
					return {
						content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }],
						isError: true,
					}
				return {
					content: [{ type: 'text' as const, text: formatDeps(result) }],
					structuredContent: {
						symbol: result.symbol,
						direction: direction ?? 'both',
						depth: depth ?? null,
						upstream: result.upstream,
						downstream: result.downstream,
						stats: result.stats,
						truncated: result.truncated,
						truncationReason: result.truncationReason,
					},
				}
			}),
	)

	// --- atlas_call_sites ---
	// per-call-site listing: one entry per edge row, so the same source
	// symbol appears multiple times when it calls the target from
	// multiple lines. pairs with atlas_deps, which collapses by source.
	// use this when you need grep-granularity (e.g. "list every line
	// that calls X, with file:line") rather than "which symbols call X".
	server.registerTool(
		'atlas_call_sites',
		{
			description:
				'list every call-site (one entry per edge row, preserving multiplicity). pairs with atlas_deps which collapses by source symbol',
			inputSchema: {
				symbol: z.string().describe('symbol name or file:name reference'),
				direction: z
					.enum(['inbound', 'outbound'])
					.optional()
					.describe('inbound=who calls this, outbound=what this calls (default inbound)'),
				kind: z.enum(EDGE_KINDS).optional().describe('filter by edge kind'),
				limit: z.number().optional().describe('max entries returned (default 50)'),
			},
			outputSchema: {
				query: z.string(),
				direction: z.enum(['inbound', 'outbound']),
				kind: z.union([z.enum(EDGE_KINDS), z.null()]),
				limit: z.number().nullable(),
				count: z.number(),
				callSites: z.array(z.unknown()),
			},
		},
		({ symbol, direction, kind, limit }) =>
			wrap(() => {
				const dir = direction ?? 'inbound'
				const result = engine.callSites(symbol, { direction: dir, kind, limit })
				if (!result) {
					return {
						content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }],
						isError: true,
					}
				}
				return {
					content: [{ type: 'text' as const, text: formatCallSites(symbol, dir, result) }],
					structuredContent: {
						query: symbol,
						direction: dir,
						kind: kind ?? null,
						limit: limit ?? null,
						count: result.length,
						callSites: result,
					},
				}
			}),
	)

	// --- atlas_blast_radius ---
	server.registerTool(
		'atlas_blast_radius',
		{
			description: 'analyze what code would be affected if a symbol or file changes',
			inputSchema: {
				target: z.string().describe('symbol name, file path, or file:line'),
				depth: z.number().optional().describe('max propagation depth (default 5)'),
			},
			outputSchema: {
				query: z.string(),
				depth: z.number().nullable(),
				target: z.unknown(),
				direct: z.array(z.unknown()),
				transitive: z.array(z.unknown()),
				affectedTests: z.array(z.unknown()),
				summary: z.unknown(),
				truncated: z.boolean(),
				truncationReason: z.string().optional(),
			},
		},
		({ target, depth }) =>
			wrap(() => {
				const result = engine.blast(target, { depth })
				if (!result)
					return {
						content: [{ type: 'text' as const, text: `symbol not found: ${target}` }],
						isError: true,
					}
				return {
					content: [{ type: 'text' as const, text: formatBlast(result) }],
					structuredContent: {
						query: target,
						depth: depth ?? null,
						target: result.target,
						direct: result.direct,
						transitive: result.transitive,
						affectedTests: result.affectedTests,
						summary: result.summary,
						truncated: result.truncated,
						truncationReason: result.truncationReason,
					},
				}
			}),
	)

	// --- atlas_trace ---
	server.registerTool(
		'atlas_trace',
		{
			description:
				'find execution paths between two symbols. use preset=fast for low-latency call-flow tracing; use preset=full or explicit edgeKinds when structural contains/type edges are required.',
			inputSchema: {
				from: z.string().describe('source symbol name'),
				to: z.string().describe('target symbol name'),
				maxPaths: z.number().optional().describe('max paths to return (default 5)'),
				maxDepth: z.number().optional().describe('max path depth (default 10)'),
				preset: z
					.enum(['fast', 'full'])
					.optional()
					.describe('fast excludes high-fanout structural edges; full uses the engine default'),
				edgeKinds: z
					.array(z.enum(EDGE_KINDS))
					.optional()
					.describe('exact edge kinds to traverse; overrides preset when provided'),
			},
			outputSchema: {
				source: z.unknown(),
				target: z.unknown(),
				stats: z.unknown(),
				edgeKinds: z.union([z.array(z.string()), z.literal('auto')]),
				preset: z.string(),
			},
		},
		({ from, to, maxPaths, maxDepth, preset, edgeKinds }) =>
			wrap(() => {
				const resolvedEdgeKinds = traceEdgeKinds(preset, edgeKinds)
				const result = engine.trace(from, to, {
					maxPaths,
					maxDepth,
					edgeKinds: resolvedEdgeKinds,
				})
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
				return {
					content: [{ type: 'text' as const, text: formatTrace(result) }],
					structuredContent: {
						source: result.source,
						target: result.target,
						stats: result.stats,
						edgeKinds: resolvedEdgeKinds ?? 'auto',
						preset: preset ?? 'auto',
					},
				}
			}),
	)

	// --- atlas_dead_code ---
	server.registerTool(
		'atlas_dead_code',
		{
			description:
				'find unreferenced symbols (potential dead code). pass callersWithin to instead list symbols whose only callers live under a path prefix (refactor-candidate query, see #86)',
			inputSchema: {
				path: z.string().optional().describe('filter by file path'),
				kind: z.enum(SYMBOL_KINDS).optional().describe('filter by symbol kind'),
				callersWithin: z
					.string()
					.optional()
					.describe(
						'switch to internal-only mode: return symbols with callers all within this prefix (refactor-candidate query)',
					),
			},
			outputSchema: {
				mode: z.enum(['dead-code', 'internal-only']),
				filters: z.object({
					path: z.string().nullable(),
					kind: z.union([z.enum(SYMBOL_KINDS), z.null()]),
					callersWithin: z.string().nullable(),
				}),
				symbols: z.array(z.unknown()),
				stats: z.unknown(),
			},
		},
		({ path, kind, callersWithin }) =>
			wrap(() => {
				const result = engine.deadCode({ path, kind, callersWithin })
				return {
					content: [{ type: 'text' as const, text: formatDeadCode(result) }],
					structuredContent: {
						mode: callersWithin ? 'internal-only' : 'dead-code',
						filters: {
							path: path ?? null,
							kind: kind ?? null,
							callersWithin: callersWithin ?? null,
						},
						symbols: result.symbols,
						stats: result.stats,
					},
				}
			}),
	)

	// --- atlas_history ---
	server.registerTool(
		'atlas_history',
		{
			description: 'git commit history for a file (most recent first)',
			inputSchema: {
				file: z.string().describe('repo-relative file path'),
				limit: z.number().optional().describe('max commits to return (default 20)'),
			},
			outputSchema: {
				file: z.string(),
				limit: z.number().nullable(),
				commits: z.array(
					z.object({
						hash: z.string(),
						authorName: z.string(),
						authorEmail: z.string(),
						authoredAt: z.number(),
						subject: z.string(),
						status: z.enum(['A', 'M', 'D', 'R']),
						renameFrom: z.string().nullable(),
					}),
				),
			},
		},
		({ file, limit }) =>
			wrap(() => {
				const rows = engine.fileHistory(file).slice(0, limit ?? 20)
				if (rows.length === 0) {
					return {
						content: [{ type: 'text' as const, text: `no history for ${file}` }],
						structuredContent: {
							file,
							limit: limit ?? null,
							commits: rows,
						},
					}
				}
				const lines = rows.map((r) => {
					const date = new Date(r.authoredAt).toISOString().slice(0, 10)
					return `${date}  ${r.hash.slice(0, 7)}  ${r.authorName}  ${r.status}  ${r.subject}`
				})
				return {
					content: [{ type: 'text' as const, text: lines.join('\n') }],
					structuredContent: {
						file,
						limit: limit ?? null,
						commits: rows,
					},
				}
			}),
	)

	// --- atlas_subsystems ---
	server.tool(
		'atlas_subsystems',
		'list detected subsystems (high-level modules from graph clustering)',
		{},
		() =>
			wrap(() => {
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
			wrap(() => {
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
					parts.push('\ntop exported symbols:')
					for (const s of detail.topSymbols)
						parts.push(`  ${s.kind.padEnd(10)} ${s.name}  (${s.filePath})`)
				}
				return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
			}),
	)

	// --- atlas_churn ---
	server.registerTool(
		'atlas_churn',
		{
			description: 'hot files ranked by commit count (optionally filtered by path prefix)',
			inputSchema: {
				path: z.string().optional().describe('only files starting with this path prefix'),
				limit: z.number().optional().describe('max files to return (default 20)'),
				sinceDays: z.number().optional().describe('only count commits from the last N days'),
			},
			outputSchema: {
				filters: z.object({
					path: z.string().nullable(),
					limit: z.number(),
					sinceDays: z.number().nullable(),
					since: z.number().nullable(),
				}),
				files: z.array(
					z.object({
						filePath: z.string(),
						commits: z.number(),
						contributors: z.number(),
						lastTouchedAt: z.number(),
						topAuthor: z.string(),
					}),
				),
			},
		},
		({ path, limit, sinceDays }) =>
			wrap(() => {
				const since = sinceDays ? Date.now() - sinceDays * 86400_000 : undefined
				const effectiveLimit = limit ?? 20
				const rows = engine.churn({ pathPrefix: path, limit: effectiveLimit, since })
				if (rows.length === 0) {
					return {
						content: [{ type: 'text' as const, text: 'no churn data available' }],
						structuredContent: {
							filters: {
								path: path ?? null,
								limit: effectiveLimit,
								sinceDays: sinceDays ?? null,
								since: since ?? null,
							},
							files: rows,
						},
					}
				}
				const lines = rows.map((r) => {
					const date = new Date(r.lastTouchedAt).toISOString().slice(0, 10)
					return `${String(r.commits).padStart(4)} commits  ${date}  ${r.topAuthor.padEnd(20)}  ${r.filePath}`
				})
				return {
					content: [{ type: 'text' as const, text: lines.join('\n') }],
					structuredContent: {
						filters: {
							path: path ?? null,
							limit: effectiveLimit,
							sinceDays: sinceDays ?? null,
							since: since ?? null,
						},
						files: rows,
					},
				}
			}),
	)

	// --- atlas_test_coverage ---
	server.registerTool(
		'atlas_test_coverage',
		{
			description: 'show test files that cover a symbol (imported or called)',
			inputSchema: {
				symbol: z.string().describe('symbol name or qualifiedName'),
			},
			outputSchema: {
				query: z.string(),
				target: z.unknown(),
				coveredBy: z.enum(['imported', 'called', 'none']),
				count: z.number(),
				tests: z.array(z.unknown()),
			},
		},
		({ symbol }) =>
			wrap(() => {
				const result = engine.testCoverage(symbol)
				if (!result) {
					return {
						content: [{ type: 'text' as const, text: `symbol not found: ${symbol}` }],
						isError: true,
					}
				}
				if (result.tests.length === 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: `${result.target.name} (${result.target.filePath}:${result.target.lineStart})\ncoverage: none`,
							},
						],
						structuredContent: {
							query: symbol,
							target: result.target,
							coveredBy: result.coveredBy,
							count: 0,
							tests: [],
						},
					}
				}
				const lines = [
					`${result.target.name} (${result.target.filePath}:${result.target.lineStart})`,
					`coverage: ${result.coveredBy}`,
					'',
					...result.tests.map((t) => `  ${t.confidence.padEnd(8)}  ${t.testFilePath}`),
				]
				return {
					content: [{ type: 'text' as const, text: lines.join('\n') }],
					structuredContent: {
						query: symbol,
						target: result.target,
						coveredBy: result.coveredBy,
						count: result.tests.length,
						tests: result.tests,
					},
				}
			}),
	)

	// --- atlas_hotspots ---
	server.registerTool(
		'atlas_hotspots',
		{
			description:
				'rank exported symbols by fanin * churn * test coverage. use this before reading files to pick the highest-risk symbols.',
			inputSchema: {
				limit: z.number().optional().describe('max symbols to return (default 20)'),
				coverage: z
					.enum(['called', 'imported', 'none'])
					.optional()
					.describe('filter by coverage level'),
			},
			outputSchema: {
				rows: z.array(z.unknown()),
			},
		},
		({ limit, coverage }) =>
			wrap(() => {
				const rows = engine.hotspots({ limit: limit ?? 20, coverage })
				return {
					content: [{ type: 'text' as const, text: formatHotspots(rows) }],
					structuredContent: { rows },
				}
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
			wrap(() => {
				const rows = engine.hotFragile({ limit: limit ?? 20 })
				if (rows.length === 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: 'no hot-fragile files (need git history + test_links)',
							},
						],
					}
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

	// --- atlas_channels_list ---
	// surfaces cross-language channel groups (#31). first channel is
	// sql_table (#10); future channels (graphql, queue_topic, env_var,
	// openapi) reuse the same table so this one tool serves them all.
	server.tool(
		'atlas_channels_list',
		'list (kind, value) groups with 2+ symbols touching the same channel value',
		{
			kind: z.string().optional().describe('channel kind to list (default sql_table)'),
		},
		({ kind }) =>
			wrap(() => {
				const actualKind = kind ?? 'sql_table'
				const groups = engine.listChannels(actualKind)
				if (groups.length === 0) {
					return {
						content: [
							{ type: 'text' as const, text: `no ${actualKind} groups. run atlas index first.` },
						],
					}
				}
				const lines = groups.map(
					(g) => `${String(g.symbolStableIds.length).padStart(3)} symbols  ${g.value}`,
				)
				return {
					content: [
						{
							type: 'text' as const,
							text: `${actualKind} groups (${groups.length}):\n${lines.join('\n')}`,
						},
					],
				}
			}),
	)

	// --- atlas_channels_show ---
	server.tool(
		'atlas_channels_show',
		'list every symbol that touches a given channel value (kind + value lookup)',
		{
			kind: z.string().describe('channel kind (e.g. sql_table)'),
			value: z.string().describe('channel value (e.g. users for a sql_table query)'),
		},
		({ kind, value }) =>
			wrap(() => {
				const result = engine.showChannel(kind, value)
				if (result.symbols.length === 0) {
					return {
						content: [{ type: 'text' as const, text: `no symbols touch ${kind}:${value}` }],
					}
				}
				const lines = [
					`${kind}:${value} (${result.symbols.length} symbols)`,
					...result.symbols.map((s) => `  ${s.name.padEnd(30)}  ${s.filePath}:${s.lineStart}`),
				]
				// metadata (#70): queue pub/sub direction, graphql kind,
				// openapi schemaPath. skip the whole block when every row
				// is sql (metadata=null) so we don't spam empty lines.
				const metaRows = result.hits.filter((h) => h.metadata)
				if (metaRows.length > 0) {
					lines.push('', 'hits:')
					for (const h of result.hits) {
						const pieces = h.metadata
							? Object.entries(h.metadata)
									.filter(([, v]) => v !== null && v !== undefined)
									.map(([k, v]) => `${k}=${String(v)}`)
									.join(' ')
							: ''
						lines.push(`  ${h.filePath}:${h.line}${pieces ? `  ${pieces}` : ''}`)
					}
				}
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
