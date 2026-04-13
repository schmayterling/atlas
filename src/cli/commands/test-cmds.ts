import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import type { SymbolKind } from '../../shared/types.js'
import { badge, fileRef, heading, outputJson } from '../formatters/common.js'

export function testsCommand(projectRoot: string, json: boolean, query: string) {
	const engine = getOrCreateEngine(undefined, projectRoot)
	try {
		const result = engine.testCoverage(query)
		if (!result) {
			if (json) {
				outputJson({ error: `symbol not found: ${query}` })
			} else {
				console.error(pc.red(`symbol not found: ${query}`))
			}
			process.exitCode = 1
			return
		}
		if (json) {
			outputJson(result)
			return
		}
		heading(`tests covering ${result.target.name}`)
		console.log(`  ${badge(result.target.kind)} ${pc.bold(result.target.name)}`)
		console.log(`  ${' '.repeat(12)} ${fileRef(result.target.filePath, result.target.lineStart)}`)
		console.log(`  ${' '.repeat(12)} coverage: ${pc.bold(result.coveredBy)}`)
		console.log()
		if (result.tests.length === 0) {
			console.log(pc.yellow('  no tests reference this symbol'))
			return
		}
		for (const t of result.tests) {
			const conf = t.confidence === 'called' ? pc.green('called  ') : pc.dim('imported')
			console.log(`  ${conf}  ${t.testFilePath}`)
		}
	} finally {
		engine.close()
	}
}

const CALLABLE_KINDS_MSG = 'function, method'

export function untestedCommand(
	projectRoot: string,
	json: boolean,
	opts: { kind?: string; limit?: number },
) {
	const engine = getOrCreateEngine(undefined, projectRoot)
	try {
		// the underlying query only counts callable kinds because only
		// function/method symbols can produce 'called' coverage edges. tell
		// the user explicitly when they ask for an unsupported kind rather
		// than returning a misleading "all covered" message.
		if (opts.kind && opts.kind !== 'function' && opts.kind !== 'method') {
			if (json) {
				outputJson([])
			} else {
				console.log(
					pc.yellow(
						`  '${opts.kind}' coverage isn't tracked. atlas only resolves 'called' edges for ${CALLABLE_KINDS_MSG}.`,
					),
				)
			}
			return
		}
		const result = engine.untestedSymbols({
			kind: opts.kind as SymbolKind | undefined,
			limit: opts.limit,
		})
		if (json) {
			outputJson(result)
			return
		}
		heading(`untested ${opts.kind ? opts.kind : 'callable'} symbols (${result.length})`)
		if (result.length === 0) {
			console.log(pc.green('  every callable exported symbol is exercised by at least one test'))
			return
		}
		console.log()
		for (const sym of result) {
			console.log(`  ${badge(sym.kind)} ${pc.bold(sym.name)}`)
			console.log(`  ${' '.repeat(12)} ${fileRef(sym.filePath, sym.lineStart)}`)
		}
	} finally {
		engine.close()
	}
}

export function hotspotsCommand(
	projectRoot: string,
	json: boolean,
	opts: { limit?: number; coverage?: 'called' | 'imported' | 'none' },
) {
	const engine = getOrCreateEngine(undefined, projectRoot)
	try {
		const rows = engine.hotspots({ limit: opts.limit, coverage: opts.coverage })
		if (json) {
			outputJson(rows)
			return
		}
		heading(`hotspots (${rows.length})`)
		if (rows.length === 0) {
			console.log(pc.dim('  no hotspots found. run `atlas index` first.'))
			return
		}
		console.log()
		console.log(`  ${pc.dim('SCORE  FANIN  COMMITS  COVERAGE   SYMBOL')}`)
		for (const r of rows) {
			const coverage =
				r.coverage === 'called'
					? pc.green('called  ')
					: r.coverage === 'imported'
						? pc.yellow('imported')
						: pc.red('none    ')
			console.log(
				`  ${pc.bold(String(Math.round(r.score)).padStart(5))}  ${String(r.fanin).padStart(5)}  ${String(r.commits).padStart(7)}  ${coverage}   ${pc.bold(r.name)}  ${pc.dim(`${r.filePath}:${r.lineStart}`)}`,
			)
		}
	} finally {
		engine.close()
	}
}

export function hotFragileCommand(
	projectRoot: string,
	json: boolean,
	opts: { limit?: number },
) {
	const engine = getOrCreateEngine(undefined, projectRoot)
	try {
		const rows = engine.hotFragile({ limit: opts.limit })
		if (json) {
			outputJson(rows)
			return
		}
		heading(`hot-fragile files (${rows.length})`)
		if (rows.length === 0) {
			// distinguish "no git history" from "fully covered". the
			// underlying query INNER JOINs file_changes, so an empty result
			// either means no commits exist for any file or every callable
			// symbol has called coverage.
			const status = engine.status()
			const haveHistory = status.lastCommit !== null
			if (!haveHistory) {
				console.log(pc.dim('  no git history. run `atlas index` in a git repo to enable hot-fragile.'))
			} else {
				console.log(pc.green('  no callable exported symbols are simultaneously high-churn and untested. nice.'))
			}
			return
		}
		console.log()
		for (const r of rows) {
			const fragility = r.commits * r.untestedCount
			console.log(
				`  ${pc.red(String(fragility).padStart(5))}  ${pc.dim(`${r.commits} commits`.padEnd(12))} ${pc.yellow(`${r.untestedCount}/${r.symbolCount} untested`.padEnd(20))} ${r.filePath}`,
			)
			if (r.subsystem) console.log(`  ${' '.repeat(7)} ${pc.dim(`subsystem: ${r.subsystem}`)}`)
		}
	} finally {
		engine.close()
	}
}
