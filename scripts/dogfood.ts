#!/usr/bin/env bun

// dogfood regression + baseline + comparison script
// run: bun run scripts/dogfood.ts
// saves baseline to .atlas/baseline.json, compares against it on subsequent runs

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = import.meta.dir + '/..'
const BASELINE_PATH = join(ROOT, '.atlas', 'baseline.json')
// dedicated dogfood db path so we never race atlas watch on .atlas/atlas.db
const DB_PATH = join(ROOT, '.atlas', 'dogfood.db')

// decides whether the current run is allowed to (over)write the baseline file.
// rules:
//   - never write when checks failed (the old behaviour blessed failing runs as
//     the new baseline whenever baseline.json was absent)
//   - write an initial baseline only when there was no baseline AND every check
//     passed (first-run case)
//   - overwrite an existing baseline only when --refresh-baseline is set AND
//     every check passed
// kept as a pure helper so tests can pin the branch table without running the
// full indexer.
export function shouldWriteBaseline(opts: {
	allPass: boolean
	hasBaseline: boolean
	refreshFlag: boolean
}): boolean {
	if (!opts.allPass) return false
	if (!opts.hasBaseline) return true
	return opts.refreshFlag
}

interface Metrics {
	timestamp: string
	commit: string
	files: number
	symbols: number
	edges: number
	indexMs: number
	warnings: number
	depsDown: number
	depsEdges: number
	tracePaths: number
	deadCode: number
	searchResults: number
	queryMs: {
		deps: number
		blast: number
		search: number
		trace: number
		deadCode: number
	}
}

async function run(): Promise<void> {
	const refreshFlag = process.argv.includes('--refresh-baseline')

	const { initSqliteExtensions } = await import('../src/core/storage/sqlite-ext.js')
	initSqliteExtensions()

	const { AtlasEngine } = await import('../src/core/engine.js')

	// get commit hash
	const gitResult = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
		cwd: ROOT,
		stdout: 'pipe',
	})
	const commit = gitResult.stdout.toString().trim()

	// fresh dogfood db (separate from production .atlas/atlas.db so we never race
	// a concurrent `atlas watch`). safe to unlink because only dogfood writes here.
	if (existsSync(DB_PATH)) unlinkSync(DB_PATH)
	const engine = new AtlasEngine(ROOT, { dbPath: DB_PATH })
	const indexResult = await engine.index({ noEmbed: true, noSummarize: true })

	// queries
	const depsResult = engine.deps('blastCommand')
	const traceResult = engine.trace('blastCommand', 'blast')
	const searchResult = engine.search('AtlasEngine', { limit: 10 })
	const deadResult = engine.deadCode()

	// benchmarks (50 runs each)
	const bench = (fn: () => void, runs = 50): number => {
		fn() // warm up
		const start = performance.now()
		for (let i = 0; i < runs; i++) fn()
		return (performance.now() - start) / runs
	}

	const queryMs = {
		deps: bench(() => engine.deps('blastCommand')),
		blast: bench(() => engine.blast('blastCommand')),
		search: bench(() => engine.search('AtlasEngine')),
		trace: bench(() => engine.trace('blastCommand', 'blast')),
		deadCode: bench(() => engine.deadCode()),
	}

	engine.close()

	const current: Metrics = {
		timestamp: new Date().toISOString(),
		commit,
		files: indexResult.filesTotal,
		symbols: indexResult.symbols,
		edges: indexResult.edges,
		indexMs: Math.round(indexResult.duration),
		warnings: indexResult.warnings.length,
		depsDown: depsResult?.downstream.length ?? 0,
		depsEdges: depsResult?.stats.totalEdges ?? 0,
		tracePaths: traceResult?.stats.totalPaths ?? 0,
		deadCode: deadResult.stats.total,
		searchResults: searchResult.total,
		queryMs: {
			deps: round(queryMs.deps),
			blast: round(queryMs.blast),
			search: round(queryMs.search),
			trace: round(queryMs.trace),
			deadCode: round(queryMs.deadCode),
		},
	}

	// load baseline if exists
	let baseline: Metrics | null = null
	if (existsSync(BASELINE_PATH)) {
		baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
	}

	// print results
	console.log()
	console.log(`atlas dogfood @ ${commit}`)
	console.log('─'.repeat(60))

	const checks: { name: string; value: number; min: number; baseline?: number }[] = [
		{ name: 'files', value: current.files, min: 35, baseline: baseline?.files },
		{ name: 'symbols', value: current.symbols, min: 400, baseline: baseline?.symbols },
		{ name: 'edges', value: current.edges, min: 800, baseline: baseline?.edges },
		{ name: 'warnings', value: current.warnings, min: -1, baseline: baseline?.warnings },
		{ name: 'search results', value: current.searchResults, min: 3, baseline: baseline?.searchResults },
		{ name: 'deps downstream', value: current.depsDown, min: 1, baseline: baseline?.depsDown },
		{ name: 'deps edges', value: current.depsEdges, min: 1, baseline: baseline?.depsEdges },
		{ name: 'trace paths', value: current.tracePaths, min: 1, baseline: baseline?.tracePaths },
		{ name: 'dead code', value: current.deadCode, min: 0, baseline: baseline?.deadCode },
	]

	let allPass = true
	for (const check of checks) {
		const pass = check.name === 'warnings' ? check.value === 0 : check.value >= check.min
		const icon = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
		if (!pass) allPass = false

		let delta = ''
		if (check.baseline !== undefined && check.baseline !== check.value) {
			const diff = check.value - check.baseline
			const sign = diff > 0 ? '+' : ''
			delta = `  (${sign}${diff} from baseline)`
		}

		console.log(`  ${icon}  ${check.name.padEnd(18)} ${String(check.value).padStart(6)}${delta}`)
	}

	console.log()
	console.log('  query performance (ms/call, 50 runs):')
	const perfChecks = [
		{ name: 'deps', value: current.queryMs.deps, baseline: baseline?.queryMs.deps },
		{ name: 'blast', value: current.queryMs.blast, baseline: baseline?.queryMs.blast },
		{ name: 'search', value: current.queryMs.search, baseline: baseline?.queryMs.search },
		{ name: 'trace', value: current.queryMs.trace, baseline: baseline?.queryMs.trace },
		{ name: 'dead-code', value: current.queryMs.deadCode, baseline: baseline?.queryMs.deadCode },
	]

	for (const p of perfChecks) {
		let delta = ''
		if (p.baseline !== undefined) {
			const diff = p.value - p.baseline
			const pct = ((diff / p.baseline) * 100).toFixed(0)
			const sign = diff > 0 ? '+' : ''
			const color = diff > p.baseline * 0.5 ? '\x1b[31m' : diff < -p.baseline * 0.1 ? '\x1b[32m' : ''
			delta = `  ${color}(${sign}${pct}% from baseline)\x1b[0m`
		}
		console.log(`    ${p.name.padEnd(12)} ${String(p.value).padStart(8)} ms${delta}`)
	}

	console.log()
	console.log(`  index time: ${current.indexMs}ms${baseline ? ` (baseline: ${baseline.indexMs}ms)` : ''}`)

	// baseline write is gated on allPass. a failing run must never overwrite
	// baseline.json, otherwise `rm baseline.json && bun run dogfood` blesses
	// a regression as the new target.
	const writeBaseline = shouldWriteBaseline({
		allPass,
		hasBaseline: baseline !== null,
		refreshFlag,
	})
	if (writeBaseline) {
		writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2))
		console.log()
		console.log(`  baseline ${baseline ? 'refreshed' : 'saved'} at ${BASELINE_PATH}`)
	} else if (refreshFlag && !allPass) {
		console.log()
		console.log('\x1b[31m  --refresh-baseline refused: some checks failed\x1b[0m')
	}

	console.log()
	if (allPass) {
		console.log('\x1b[32mall checks passed\x1b[0m')
	} else {
		console.log('\x1b[31msome checks failed\x1b[0m')
		process.exit(1)
	}
}

function round(n: number): number {
	return Math.round(n * 1000) / 1000
}

run().catch((e) => {
	console.error('dogfood failed:', e)
	process.exit(1)
})
