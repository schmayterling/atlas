// atlas agent. dispatches a task's atlas_method against the engine and
// projects the result into the AgentAnswer shape the judge consumes.
// no LLM. one shape per method, normalized per below.

import type { AtlasEngine } from '../../src/core/engine.js'
import type { AgentAnswer } from '../lib/judge.js'
import type { Task } from './text-search.js'

export type AtlasMethod =
	| 'search'
	| 'resolveSymbol'
	| 'symbolDetail'
	| 'fileSymbols'
	| 'files'
	| 'deps'
	| 'blast'
	| 'trace'
	| 'callSites'
	| 'overview'
	| 'deadCode'
	| 'hotFragile'
	| 'hotspots'
	| 'subsystems'
	| 'subsystem'
	| 'testCoverage'
	| 'fileArticle'
	| 'symbolArticle'
	| 'searchContent'

export async function runAtlasAgent(task: Task, engine: AtlasEngine): Promise<AgentAnswer> {
	const args = (task.atlas_args ?? {}) as any
	try {
		switch (task.atlas_method as AtlasMethod) {
			case 'search': {
				const r = engine.search(args.q, { kind: args.kind, limit: args.limit ?? 50 })
				return { symbols: r.results.map(qnFor), count: r.total, raw: r }
			}
			case 'resolveSymbol': {
				const r = engine.resolveSymbol(args.q)
				return r ? { symbols: [qnFor(r)], raw: r } : { symbols: [] }
			}
			case 'symbolDetail': {
				const r = await engine.symbolDetail(args.q)
				return r ? { symbols: [qnFor(r.symbol)], raw: r } : { symbols: [] }
			}
			case 'fileSymbols': {
				const r = engine.fileSymbols(args.path)
				return { symbols: r.map(qnFor), count: r.length, raw: r }
			}
			case 'files': {
				const r = engine.files({ includeTests: args.includeTests })
				const filtered = args.pathPrefix
					? r.filter((f) => f.path.startsWith(args.pathPrefix))
					: r
				return { files: filtered.map((f) => f.path), count: filtered.length, raw: filtered }
			}
			case 'deps': {
				const r = engine.deps(args.symbol, { direction: args.direction, depth: args.depth })
				if (!r) return { symbols: [] }
				const all = [...r.upstream, ...r.downstream].map((d) => qnFor(d.symbol))
				return { symbols: all, count: r.stats?.totalNodes, raw: r }
			}
			case 'blast': {
				const r = engine.blast(args.target, { depth: args.depth })
				if (!r) return { symbols: [] }
				const all = [...r.direct, ...r.transitive].map((d) => qnFor(d.symbol))
				return { symbols: all, count: r.summary.totalSymbols, raw: r }
			}
			case 'trace': {
				const r = engine.trace(args.from, args.to, { maxPaths: args.maxPaths, maxDepth: args.maxDepth })
				if (!r) return { symbols: [] }
				const all = r.paths.flatMap((p) => p.nodes.map(qnFor))
				return { symbols: dedupe(all), count: r.paths.length, raw: r }
			}
			case 'callSites': {
				const r = engine.callSites(args.symbol, { direction: args.direction ?? 'inbound', kind: args.kind, limit: args.limit })
				if (!r) return { symbols: [], count: 0 }
				return { symbols: r.map((c) => `${c.sourceFilePath}::${c.sourceName}`), count: r.length, raw: r }
			}
			case 'overview': {
				const r = engine.overview(args.q, { depth: args.depth, limit: args.limit })
				if (!r) return { symbols: [] }
				return { symbols: [qnFor(r.symbol)], raw: r }
			}
			case 'deadCode': {
				const r = engine.deadCode({ kind: args.kind, path: args.path })
				return { symbols: r.symbols.map(qnFor), count: r.symbols.length, raw: r }
			}
			case 'hotFragile': {
				const r = engine.hotFragile({ limit: args.limit })
				return { files: r.map((x) => x.filePath), count: r.length, raw: r }
			}
			case 'hotspots': {
				const r = engine.hotspots({ limit: args.limit, coverage: args.coverage })
				return { symbols: r.map((x) => x.qualifiedName), count: r.length, raw: r }
			}
			case 'subsystems': {
				const r = engine.subsystems()
				return { count: r.length, raw: r }
			}
			case 'subsystem': {
				const r = engine.subsystem(args.id)
				return { count: r?.files.length ?? 0, files: r?.files.map((f) => f.path), raw: r }
			}
			case 'testCoverage': {
				const r = engine.testCoverage(args.symbol)
				return { files: r?.tests.map((t) => t.testFilePath) ?? [], count: r?.tests.length ?? 0, raw: r }
			}
			case 'fileArticle': {
				const r = engine.fileArticle(args.path)
				return r ? { symbols: r.symbols.map(qnFor), count: r.symbols.length, raw: r } : { symbols: [] }
			}
			case 'symbolArticle': {
				const r = await engine.symbolArticle(args.q)
				return r ? { symbols: [qnFor(r.symbol)], raw: r } : { symbols: [] }
			}
			case 'searchContent': {
				const r = engine.searchContent(args.q, { pathPrefix: args.pathPrefix, language: args.language, maxMatches: args.maxMatches })
				const files = [...new Set(r.matches.map((m) => m.file))]
				return { files, count: r.fileCount, raw: r }
			}
			default: return { error: `unknown atlas_method: ${task.atlas_method}` }
		}
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) }
	}
}

function qnFor(s: { qualifiedName: string }): string {
	return s.qualifiedName
}

function dedupe<T>(xs: T[]): T[] {
	return [...new Set(xs)]
}
