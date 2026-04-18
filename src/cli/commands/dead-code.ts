import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { listProjects } from '../../core/registry.js'
import type { SymbolKind } from '../../shared/types.js'
import { badge, fileRef, heading, outputJson } from '../formatters/common.js'

export function deadCodeCommand(
	projectRoot: string,
	json: boolean,
	opts: {
		kind?: string
		path?: string
		includeTests?: boolean
		allProjects?: boolean
		callersWithin?: string
	},
) {
	if (opts.allProjects) {
		if (opts.callersWithin) {
			console.error(
				pc.red('--callers-within is not supported with --all-projects (federation semantics are per-project).'),
			)
			process.exit(1)
		}
		deadCodeAllProjects(json, opts)
		return
	}

	const engine = getOrCreateEngine(undefined, projectRoot)

	try {
		const result = engine.deadCode({
			kind: opts.kind as SymbolKind | undefined,
			path: opts.path,
			includeTests: opts.includeTests,
			callersWithin: opts.callersWithin,
		})

		if (json) {
			outputJson(result)
			return
		}

		const headingText = opts.callersWithin
			? `internal-only symbols within ${opts.callersWithin} (${result.stats.total} found)`
			: `unreferenced symbols (${result.stats.total} found)`
		heading(headingText)

		if (result.stats.total === 0) {
			console.log(pc.green('  no dead code found'))
			return
		}

		console.log()
		for (const sym of result.symbols) {
			const kindBadge = badge(sym.kind)
			const name = pc.bold(sym.name)
			const ref = fileRef(sym.filePath, sym.lineStart)
			console.log(`  ${kindBadge} ${name}`)
			console.log(`  ${' '.repeat(12)} ${ref}`)
		}

		console.log()
		console.log(pc.dim('by kind:'))
		for (const [kind, count] of Object.entries(result.stats.byKind)) {
			console.log(pc.dim(`  ${kind}: ${count}`))
		}
	} finally {
		engine.close()
	}
}

// federated dead-code: union local-dead symbols across every registered
// project, then filter out anything that has at least one inbound
// cross_project_edges row (meaning some other project consumes it, so
// it isn't actually dead). matches the #32 spec: a symbol is dead only
// if it's locally unreferenced AND has no cross-project consumers.
function deadCodeAllProjects(
	json: boolean,
	opts: { kind?: string; path?: string; includeTests?: boolean },
) {
	const projects = listProjects()
	if (projects.length === 0) {
		console.error(pc.red('no registered projects. run `atlas projects add <path>` first.'))
		process.exit(1)
	}

	const merged: Array<{
		project: string
		name: string
		kind: string
		filePath: string
		lineStart: number
	}> = []
	for (const p of projects) {
		const engine = getOrCreateEngine(p.id, p.root)
		const result = engine.deadCode({
			kind: opts.kind as SymbolKind | undefined,
			path: opts.path,
			includeTests: opts.includeTests,
		})
		for (const sym of result.symbols) {
			// filter: a symbol is only dead if no other project depends on
			// it via a non-heuristic cross_project_edges row. the engine
			// does the uniqueness lookup using (qualifiedName, kind, path)
			// because stable_id is derived from all three; using only
			// qualifiedName + path can collide on merged symbols.
			const stableId = engine.resolveStableIdFromResult(sym)
			if (stableId && engine.hasCrossProjectInbound(p.id, stableId)) continue
			merged.push({
				project: p.id,
				name: sym.name,
				kind: sym.kind,
				filePath: sym.filePath,
				lineStart: sym.lineStart,
			})
		}
	}

	if (json) {
		outputJson({ total: merged.length, symbols: merged })
		return
	}

	heading(`unreferenced symbols across ${projects.length} projects (${merged.length} found, cross-project consumers excluded)`)
	if (merged.length === 0) {
		console.log(pc.green('  no dead code found'))
		return
	}
	console.log()
	for (const sym of merged) {
		const kindBadge = badge(sym.kind)
		const tag = pc.magenta(`[${sym.project}]`)
		const ref = fileRef(sym.filePath, sym.lineStart)
		console.log(`  ${tag} ${kindBadge} ${pc.bold(sym.name)} ${ref}`)
	}
}
