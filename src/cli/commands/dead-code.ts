import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { listProjects } from '../../core/registry.js'
import type { SymbolKind } from '../../shared/types.js'
import { badge, fileRef, heading, outputJson } from '../formatters/common.js'

export function deadCodeCommand(
	projectRoot: string,
	json: boolean,
	opts: { kind?: string; path?: string; includeTests?: boolean; allProjects?: boolean },
) {
	if (opts.allProjects) {
		deadCodeAllProjects(json, opts)
		return
	}

	const engine = getOrCreateEngine(undefined, projectRoot)

	try {
		const result = engine.deadCode({
			kind: opts.kind as SymbolKind | undefined,
			path: opts.path,
			includeTests: opts.includeTests,
		})

		if (json) {
			outputJson(result)
			return
		}

		heading(`unreferenced symbols (${result.stats.total} found)`)

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
		const store = engine.getStoreForCrossProject()
		for (const sym of result.symbols) {
			// filter: a symbol is only dead if no other project depends on it.
			// dead-code's SymbolResult doesn't carry stable_id, so look up
			// by qualified_name + file path which is unique within a project
			// db. cheap because dead-code lists are typically small (<100s).
			const stableRow = store.queryRawWithParams<{ stable_id: string }>(
				`SELECT s.stable_id FROM symbols s
				 JOIN files f ON f.id = s.file_id
				 WHERE s.qualified_name = ? AND f.path = ? LIMIT 1`,
				sym.qualifiedName,
				sym.filePath,
			)
			const stableId = stableRow[0]?.stable_id
			if (stableId) {
				const inbound = store.queryRawWithParams<{ n: number }>(
					'SELECT COUNT(*) AS n FROM cross_project_edges WHERE target_project = ? AND target_stable_id = ?',
					p.id,
					stableId,
				)
				if ((inbound[0]?.n ?? 0) > 0) continue
			}
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
