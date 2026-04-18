// atlas tools exposed to the LLM in OpenAI function-calling format.
// the with-atlas agent gets these in addition to the text tools.
// each tool is a thin wrapper over an engine method that the bench-eval
// agent dispatcher already covers.
//
// the LLM sees these named the same as the MCP tool names (atlas_*)
// so prompts that reference "use atlas_search" work identically.

import type { AtlasEngine } from '../../src/core/engine.js'
import type { OpenRouterTool, ToolCall } from './openrouter.js'

export const ATLAS_TOOLS: OpenRouterTool[] = [
	{
		type: 'function',
		function: {
			name: 'atlas_search',
			description: 'Find symbols (functions, classes, types, variables) by EXACT or FUZZY NAME. Only matches identifiers , does NOT search file contents, comments, or arbitrary substrings. For file-content search use atlas_content_search. For rich context on one known symbol use atlas_overview. For intent-based discovery when you don\'t know the name use atlas_semantic_search.',
			parameters: {
				type: 'object', required: ['q'],
				properties: {
					q: { type: 'string', description: 'symbol identifier (e.g. "safeParse", "ZodObject") , NOT a file-content substring' },
					kind: { type: 'string', description: 'optional: function/class/method/interface/type/variable/module/enum/property' },
					limit: { type: 'integer' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_semantic_search',
			description: 'Find symbols by MEANING when you do NOT know the exact name. Uses embedding similarity on symbol metadata + source body. Use for intent questions like "where does the parser handle errors". Does NOT search comments or substrings , use atlas_content_search for that. Does NOT replace atlas_search when you know the name.',
			parameters: {
				type: 'object', required: ['q'],
				properties: {
					q: { type: 'string', description: 'natural-language intent' },
					limit: { type: 'integer' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_content_search',
			description: 'Literal text search across indexed source files. Use when the question is about file contents , "how many files contain TODO", "find mentions of pcre2", "comments matching iso8601". Fixed-string only (no regex). Returns matching file paths + line numbers + text snippets with aggregate fileCount and matchCount. Use the returned counts directly; do not estimate.',
			parameters: {
				type: 'object', required: ['q'],
				properties: {
					q: { type: 'string', description: 'literal substring (no regex syntax)' },
					pathPrefix: { type: 'string', description: 'restrict to files under this prefix' },
					language: { type: 'string', description: 'restrict to "typescript", "python", "rust", "go", etc.' },
					maxMatches: { type: 'integer', description: 'cap total matches, default 200' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_overview',
			description: 'One-shot structural overview for a KNOWN symbol: identity + callers + callees + blast radius summary + test coverage + subsystem. Prefer this over atlas_search when you already know the symbol name and want the whole picture in ONE call instead of chaining search + deps + blast + test_coverage.',
			parameters: {
				type: 'object', required: ['q'],
				properties: {
					q: { type: 'string', description: 'symbol qualified name or simple name' },
					depth: { type: 'integer', description: 'default 2' },
					limit: { type: 'integer', description: 'max entries per section, default 10' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_symbol_detail',
			description: 'Read a symbol\'s FULL SOURCE CODE + metadata + direct deps + cached LLM summary (if indexed with summaries). Use when you need to SEE the code, not just find where a symbol is. Skip this if atlas_overview already answered the question.',
			parameters: {
				type: 'object', required: ['symbol'],
				properties: { symbol: { type: 'string', description: 'symbol name or file::name reference' } },
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_deps',
			description: 'Dependency graph for a symbol. Returns { target, summary{upstreamCount,downstreamCount}, upstreamQualifiedNames[], downstreamQualifiedNames[], upstreamSample, downstreamSample }. Use upstream for "what calls X", downstream for "what does X call". Prefer atlas_call_sites when you need per-edge granularity.',
			parameters: {
				type: 'object', required: ['symbol'],
				properties: {
					symbol: { type: 'string', description: 'qualified name' },
					direction: { type: 'string', enum: ['upstream', 'downstream', 'both'] },
					depth: { type: 'integer', description: 'default 3' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_blast_radius',
			description: 'Blast radius of CHANGING a symbol , every transitively affected symbol. Returns { target, summary{directCount,transitiveCount,affectedCount}, directQualifiedNames[], transitiveQualifiedNames[], samples }. Different from atlas_deps (which shows immediate graph): blast walks outward through all edge kinds to show impact.',
			parameters: {
				type: 'object', required: ['target'],
				properties: {
					target: { type: 'string' },
					depth: { type: 'integer', description: 'default 5' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_trace',
			description: 'Find execution paths between TWO symbols (how does code flow from A to B?). Returns { source, target, summary{pathCount,shortestLength}, paths[] }. Use when you need the path itself, not just "is there a connection".',
			parameters: {
				type: 'object', required: ['from', 'to'],
				properties: {
					from: { type: 'string' },
					to: { type: 'string' },
					maxPaths: { type: 'integer', description: 'default 5' },
					maxDepth: { type: 'integer', description: 'default 10' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_call_sites',
			description: 'Per-edge call-site listing. One entry per call location with source symbol + file + line + edge kind. Returns { summary{callSiteCount,byEdgeKind}, sample }. Use when you need grep-granularity (every line that calls X) rather than "which symbols call X" (atlas_deps).',
			parameters: {
				type: 'object', required: ['symbol'],
				properties: {
					symbol: { type: 'string' },
					direction: { type: 'string', enum: ['inbound', 'outbound'] },
					limit: { type: 'integer', description: 'default 100' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_test_coverage',
			description: 'Find test files that exercise a given symbol via direct call or transitive import. Use for "which tests cover X" questions.',
			parameters: {
				type: 'object', required: ['symbol'],
				properties: { symbol: { type: 'string' } },
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_files',
			description: 'List every indexed source file. By default INCLUDES test files , pass includeTests: false to exclude them. Use the returned array length directly for file-count questions; do not estimate.',
			parameters: {
				type: 'object',
				properties: {
					pathPrefix: { type: 'string', description: 'optional path prefix filter (e.g. "packages/zod/src/v4/")' },
					includeTests: { type: 'boolean', description: 'default true , tests are part of the file inventory unless explicitly excluded' },
				},
			},
		},
	},
]

const RESPONSE_LIMIT = 24_000  // cap each tool response to keep context usable

export function makeAtlasHandler(engine: AtlasEngine) {
	return async (call: ToolCall): Promise<string> => {
		const args = (() => { try { return JSON.parse(call.function.arguments) } catch { return {} } })() as Record<string, any>
		try {
			const result = await dispatch(engine, call.function.name, args)
			const text = JSON.stringify(result, null, 2)
			return text.length > RESPONSE_LIMIT ? `${text.slice(0, RESPONSE_LIMIT)}\n[truncated at ${RESPONSE_LIMIT} chars]` : text
		} catch (e) {
			return `error: ${e instanceof Error ? e.message : String(e)}`
		}
	}
}

async function dispatch(engine: AtlasEngine, name: string, args: Record<string, any>): Promise<unknown> {
	switch (name) {
		// symbol-name search. returns SymbolResult objects (already rich:
		// name, qualifiedName, signature, filePath, lineStart, docComment,
		// usageCount, dependentCount).
		case 'atlas_search':
			return engine.search(args.q, { kind: args.kind, limit: args.limit ?? 20 })

		// semantic search. same shape as atlas_search results, plus distance.
		case 'atlas_semantic_search':
			return engine.semanticSearch(args.q, { limit: args.limit ?? 10 })

		// one-shot overview bundle. kept raw , the full identity + callers
		// + callees + blast + tests + subsystem payload IS the point.
		case 'atlas_overview':
			return engine.overview(args.q, { depth: args.depth ?? 2, limit: args.limit ?? 10 })

		// structural graph queries. distilled to { summary, qualifiedNames,
		// callers/callees/affected/paths, sample } so the agent emits a
		// clean count+names answer rather than a nested raw graph. defaults
		// also align with production MCP (depth 3/5/10 vs prior 2/3/5).
		case 'atlas_deps': {
			const result = engine.deps(args.symbol, { direction: args.direction ?? 'both', depth: args.depth ?? 3 })
			return distillDeps(result)
		}
		case 'atlas_blast_radius': {
			const result = engine.blast(args.target, { depth: args.depth ?? 5 })
			return distillBlast(result)
		}
		case 'atlas_trace': {
			const result = engine.trace(args.from, args.to, { maxPaths: args.maxPaths ?? 5, maxDepth: args.maxDepth ?? 10 })
			return distillTrace(result)
		}
		case 'atlas_call_sites': {
			const result = engine.callSites(args.symbol, { direction: args.direction ?? 'inbound', limit: args.limit ?? 100 })
			return distillCallSites(result)
		}

		// literal content search. fills the atlas_search gap on text/comment/
		// substring questions. rg-backed, fixed-string, scoped to indexed files.
		case 'atlas_content_search':
			return engine.searchContent(args.q, { pathPrefix: args.pathPrefix, language: args.language, maxMatches: args.maxMatches ?? 200 })

		// code-bearing symbol lookup. returns metadata + deps + source body.
		case 'atlas_symbol_detail':
			return engine.symbolDetail(args.symbol)

		case 'atlas_test_coverage':
			return engine.testCoverage(args.symbol)

		case 'atlas_files': {
			// default includeTests to true. engine.files() defaults to false which
			// makes atlas-pure lose counting tasks the rest of the world considers
			// obvious (zod-12, ripgrep-07): baseline's glob picks up test files,
			// atlas_files silently dropped them and the LLM reported half the real
			// count. see /Users/may/.claude/plans/atlas-bench-improvements-v3.md §2.
			const includeTests = args.includeTests ?? true
			const all = engine.files({ includeTests })
			return args.pathPrefix ? all.filter((f) => f.path.startsWith(args.pathPrefix)) : all
		}

		default: throw new Error(`unknown atlas tool '${name}'`)
	}
}

// --- distillers -------------------------------------------------------
// the agent was dumping raw nested graph objects into its finalMessage and
// the llm judge was flagging them as "not the expected predicate structure"
// even when the deterministic count threshold was met (see plan v3 §2).
// these distillers project each result into a flat summary shape that
// directly answers the typical questions asked of each tool. they keep a
// small `sample` array so the agent can still cite specific symbols.

type AnyObj = Record<string, unknown>
type SymLite = { qualifiedName: string; name?: string; kind?: string; filePath?: string; lineStart?: number }

function lightenSymbol(entry: AnyObj | undefined): SymLite | null {
	if (!entry) return null
	const sym = (entry as AnyObj).symbol as AnyObj | undefined ?? entry
	const qn = typeof sym.qualifiedName === 'string' ? sym.qualifiedName : null
	if (!qn) return null
	return {
		qualifiedName: qn,
		name: typeof sym.name === 'string' ? sym.name : undefined,
		kind: typeof sym.kind === 'string' ? sym.kind : undefined,
		filePath: typeof sym.filePath === 'string' ? sym.filePath : undefined,
		lineStart: typeof sym.lineStart === 'number' ? sym.lineStart : undefined,
	}
}

function distillDeps(result: unknown): AnyObj | null {
	if (!result) return null
	const r = result as AnyObj
	const target = lightenSymbol(r.symbol as AnyObj | undefined)
	const upstream = Array.isArray(r.upstream) ? r.upstream.map(lightenSymbol).filter(Boolean) as SymLite[] : []
	const downstream = Array.isArray(r.downstream) ? r.downstream.map(lightenSymbol).filter(Boolean) as SymLite[] : []
	return {
		target,
		summary: {
			upstreamCount: upstream.length,
			downstreamCount: downstream.length,
		},
		upstreamQualifiedNames: upstream.map((s) => s.qualifiedName),
		downstreamQualifiedNames: downstream.map((s) => s.qualifiedName),
		// first 10 of each side with enough detail to cite
		upstreamSample: upstream.slice(0, 10),
		downstreamSample: downstream.slice(0, 10),
	}
}

function distillBlast(result: unknown): AnyObj | null {
	if (!result) return null
	const r = result as AnyObj
	const target = lightenSymbol(r.target as AnyObj | undefined)
	const direct = Array.isArray(r.direct) ? r.direct.map(lightenSymbol).filter(Boolean) as SymLite[] : []
	const transitive = Array.isArray(r.transitive) ? r.transitive.map(lightenSymbol).filter(Boolean) as SymLite[] : []
	return {
		target,
		summary: {
			directCount: direct.length,
			transitiveCount: transitive.length,
			affectedCount: direct.length + transitive.length,
		},
		directQualifiedNames: direct.map((s) => s.qualifiedName),
		transitiveQualifiedNames: transitive.map((s) => s.qualifiedName),
		directSample: direct.slice(0, 10),
		transitiveSample: transitive.slice(0, 10),
	}
}

function distillTrace(result: unknown): AnyObj | null {
	if (!result) return null
	const r = result as AnyObj
	const paths = Array.isArray(r.paths) ? r.paths : []
	// hop count lives on FlowPath.length per src/shared/types.ts. nodes.length
	// is off-by-one (nodes includes both endpoints; a 1-hop path has 2 nodes).
	const pathLen = (p: AnyObj): number =>
		typeof p.length === 'number' ? p.length : (Array.isArray(p.nodes) ? Math.max(0, p.nodes.length - 1) : 0)
	return {
		source: lightenSymbol(r.source as AnyObj | undefined),
		target: lightenSymbol(r.target as AnyObj | undefined),
		summary: {
			pathCount: paths.length,
			shortestLength: paths.length > 0 ? Math.min(...paths.map(pathLen)) : 0,
		},
		paths: paths.slice(0, 5).map((p: AnyObj) => ({
			length: pathLen(p),
			qualifiedNames: Array.isArray(p.nodes) ? p.nodes.map((n: AnyObj) => n.qualifiedName).filter(Boolean) : [],
		})),
	}
}

function distillCallSites(result: unknown): AnyObj | null {
	if (!result) return null
	const rows = Array.isArray(result) ? result as AnyObj[] : []
	const byEdgeKind: Record<string, number> = {}
	for (const r of rows) {
		const k = typeof r.edgeKind === 'string' ? r.edgeKind : 'unknown'
		byEdgeKind[k] = (byEdgeKind[k] ?? 0) + 1
	}
	return {
		summary: {
			callSiteCount: rows.length,
			byEdgeKind,
		},
		sample: rows.slice(0, 30).map((r) => ({
			sourceQualifiedName: (r as AnyObj).sourceQualifiedName ?? (r as AnyObj).sourceName,
			sourceFilePath: r.sourceFilePath,
			callSiteLine: r.callSiteLine,
			edgeKind: r.edgeKind,
		})),
	}
}
