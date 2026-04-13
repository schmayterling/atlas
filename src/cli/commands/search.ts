import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { listProjects } from '../../core/registry.js'
import { log } from '../../shared/logger.js'
import type { SymbolKind, SymbolResult } from '../../shared/types.js'
import { badge, fileRef, outputJson } from '../formatters/common.js'

interface SearchOpts {
	kind?: string
	exact?: boolean
	limit?: number
	semantic?: boolean
	includeTests?: boolean
	allProjects?: boolean
}

export async function searchCommand(
	projectRoot: string,
	query: string,
	json: boolean,
	opts: SearchOpts,
) {
	if (opts.allProjects) {
		await searchAllProjects(query, json, opts)
		return
	}

	const engine = getOrCreateEngine(undefined, projectRoot)
	try {
		if (opts.semantic) {
			await runSingleSemantic(engine, query, json, opts)
			return
		}

		const result = engine.search(query, {
			kind: opts.kind as SymbolKind | undefined,
			exact: opts.exact,
			limit: opts.limit,
			includeTests: opts.includeTests,
		})

		if (json) {
			outputJson(result)
			return
		}

		if (result.total === 0) {
			console.log(pc.dim(`no results for "${query}"`))
			return
		}

		console.log(
			`${pc.bold(String(result.total))} results for "${query}"`,
		)
		console.log()

		for (const sym of result.results) {
			printSymbol(sym)
		}
	} finally {
		engine.close()
	}
}

// fans search out across every registered project in the registry.
// covers #8: a minimal federation surface that resolves the
// collision-safe project id per hit and merges results client-side.
// kept as a plain function rather than a new FederatedEngine class
// because speculative abstraction is hard to justify until a second
// consumer appears — search is the only federated surface shipped
// in this branch.
//
// ranking: each per-project search is capped at 3x the requested
// limit to bound memory, all hits are unioned, then truncated to
// the final limit. there is no cross-project score merge yet; the
// single-project search.ts path does FTS ranking internally and
// this wrapper just preserves the relative order within each
// project, prefixed with [project-id] in the terminal output.
async function searchAllProjects(query: string, json: boolean, opts: SearchOpts) {
	const projects = listProjects()
	if (projects.length === 0) {
		if (json) {
			outputJson({ total: 0, results: [] })
		} else {
			console.log(pc.yellow('no registered projects. run `atlas projects add <path>` first.'))
		}
		return
	}

	const perProjectCap = (opts.limit ?? 20) * 3
	const merged: Array<SymbolResult & { project: string }> = []

	for (const project of projects) {
		const engine = getOrCreateEngine(project.id, project.root)
		try {
			if (opts.semantic) {
				const r = await engine.semanticSearch(query, {
					limit: perProjectCap,
					includeTests: opts.includeTests,
				})
				if (!r.embeddingsAvailable) {
					if (!json) {
						console.log(
							pc.dim(`  [${project.id}] embeddings not available, skipping`),
						)
					}
					continue
				}
				for (const sym of r.results) merged.push({ ...sym, project: project.id })
			} else {
				const r = engine.search(query, {
					kind: opts.kind as SymbolKind | undefined,
					exact: opts.exact,
					limit: perProjectCap,
					includeTests: opts.includeTests,
				})
				for (const sym of r.results) merged.push({ ...sym, project: project.id })
			}
		} catch (e) {
			// fail soft per project so one broken db doesn't kill the
			// whole query. log.warn always fires (to stderr) so json
			// consumers see the failure in logs even though stdout
			// stays clean.
			log.warn(`search: [${project.id}] query failed: ${e}`)
			if (!json) {
				console.log(pc.red(`  [${project.id}] query failed: ${e}`))
			}
		} finally {
			engine.close()
		}
	}

	const finalLimit = opts.limit ?? 20
	const truncated = merged.slice(0, finalLimit)

	if (json) {
		outputJson({ total: truncated.length, results: truncated })
		return
	}

	if (truncated.length === 0) {
		console.log(pc.dim(`no results for "${query}" across ${projects.length} projects`))
		return
	}

	console.log(
		`${pc.bold(String(truncated.length))} results for "${query}" across ${projects.length} projects`,
	)
	console.log()
	for (const sym of truncated) {
		const tag = pc.magenta(`[${sym.project}]`)
		console.log(`  ${tag}`)
		printSymbol(sym)
	}
}

async function runSingleSemantic(
	engine: ReturnType<typeof getOrCreateEngine>,
	query: string,
	json: boolean,
	opts: SearchOpts,
) {
	const result = await engine.semanticSearch(query, {
		limit: opts.limit,
		includeTests: opts.includeTests,
	})

	if (json) {
		outputJson(result)
		return
	}

	if (!result.embeddingsAvailable) {
		console.log(pc.yellow('embeddings not available. run `atlas index` with Ollama running.'))
		return
	}

	if (result.results.length === 0) {
		console.log(pc.dim(`no semantic results for "${query}"`))
		return
	}

	console.log(
		`${pc.bold(String(result.results.length))} semantic results for "${query}"`,
	)
	console.log()

	for (const sym of result.results) {
		const kindBadge = badge(sym.kind)
		const name = pc.bold(sym.name)
		const ref = fileRef(sym.filePath, sym.lineStart)
		const dist = pc.dim(`distance: ${sym.distance.toFixed(3)}`)
		console.log(`  ${kindBadge} ${name}`)
		console.log(`  ${' '.repeat(12)} ${ref}  ${dist}`)
		console.log()
	}
}

function printSymbol(sym: SymbolResult) {
	const kindBadge = badge(sym.kind)
	const name = pc.bold(sym.name)
	const sig = sym.signature ? pc.dim(` ${sym.signature}`) : ''
	const ref = fileRef(sym.filePath, sym.lineStart)
	const stats = pc.dim(`${sym.usageCount} uses | ${sym.dependentCount} dependents`)
	console.log(`  ${kindBadge} ${name}${sig}`)
	console.log(`  ${' '.repeat(12)} ${ref}`)
	console.log(`  ${' '.repeat(12)} ${stats}`)
	console.log()
}
