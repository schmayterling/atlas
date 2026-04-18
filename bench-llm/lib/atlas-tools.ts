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
			description: 'Search atlas\'s symbol index by name. Returns up to N exact + fuzzy hits with kind, file path, and line number. Use this instead of grep when looking for a function/class/type by name.',
			parameters: {
				type: 'object', required: ['q'],
				properties: {
					q: { type: 'string' },
					kind: { type: 'string', description: 'optional: function/class/method/interface/type/variable/module/enum/property' },
					limit: { type: 'integer' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_overview',
			description: 'Get a one-shot bundle for a symbol: identity + callers + callees + blast radius summary + test coverage + subsystem. Use this when you want the whole structural picture of a symbol in one call.',
			parameters: {
				type: 'object', required: ['q'],
				properties: { q: { type: 'string', description: 'symbol qualified name' } },
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_deps',
			description: 'Show the dependency graph for a symbol up to a given depth. Returns upstream callers and/or downstream callees with edge kinds.',
			parameters: {
				type: 'object', required: ['symbol'],
				properties: {
					symbol: { type: 'string', description: 'qualified name' },
					direction: { type: 'string', enum: ['upstream', 'downstream', 'both'] },
					depth: { type: 'integer' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_blast_radius',
			description: 'Compute the blast radius of changing a symbol — every transitively affected symbol up to the given depth.',
			parameters: {
				type: 'object', required: ['target'],
				properties: {
					target: { type: 'string' },
					depth: { type: 'integer' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_trace',
			description: 'Trace at most N execution paths from one symbol to another, walking the call graph.',
			parameters: {
				type: 'object', required: ['from', 'to'],
				properties: {
					from: { type: 'string' },
					to: { type: 'string' },
					maxPaths: { type: 'integer' },
					maxDepth: { type: 'integer' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_call_sites',
			description: 'List per-edge call sites for a symbol (one row per call, with source name + line). Use when you need finer granularity than atlas_deps.',
			parameters: {
				type: 'object', required: ['symbol'],
				properties: {
					symbol: { type: 'string' },
					direction: { type: 'string', enum: ['inbound', 'outbound'] },
					limit: { type: 'integer' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'atlas_test_coverage',
			description: 'Find test files that exercise a given symbol (via direct call or transitive import).',
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
			description: 'List indexed source files. Optionally filter by path prefix and/or include test files.',
			parameters: {
				type: 'object',
				properties: {
					pathPrefix: { type: 'string' },
					includeTests: { type: 'boolean' },
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
		case 'atlas_search':       return engine.search(args.q, { kind: args.kind, limit: args.limit ?? 20 })
		case 'atlas_overview':     return engine.overview(args.q, { depth: args.depth ?? 2, limit: args.limit ?? 10 })
		case 'atlas_deps':         return engine.deps(args.symbol, { direction: args.direction ?? 'both', depth: args.depth ?? 2 })
		case 'atlas_blast_radius': return engine.blast(args.target, { depth: args.depth ?? 3 })
		case 'atlas_trace':        return engine.trace(args.from, args.to, { maxPaths: args.maxPaths ?? 5, maxDepth: args.maxDepth ?? 5 })
		case 'atlas_call_sites':   return engine.callSites(args.symbol, { direction: args.direction ?? 'inbound', limit: args.limit ?? 50 })
		case 'atlas_test_coverage':return engine.testCoverage(args.symbol)
		case 'atlas_files': {
			const all = engine.files({ includeTests: args.includeTests })
			return args.pathPrefix ? all.filter((f) => f.path.startsWith(args.pathPrefix)) : all
		}
		default: throw new Error(`unknown atlas tool '${name}'`)
	}
}
