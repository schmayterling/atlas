#!/usr/bin/env bun
// bench-eval runner. iterates corpora and tasks, runs both agents,
// scores, prints two tables (comparable + capability), writes a
// timestamped results json.
//
// usage:
//   bun run bench-eval --corpus ripgrep        run one corpus
//   bun run bench-eval --all                   every corpus
//   bun run bench-eval --capabilities          atlas-only tasks across all corpora
//   bun run bench-eval --corpus X --no-clone   skip clone (use cached only)

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { initSqliteExtensions } from '../src/core/storage/sqlite-ext.js'
initSqliteExtensions()
import { ensureCorpus, listCorpora, loadManifest } from './lib/corpus.js'
import { judge, type Expected } from './lib/judge.js'
import { runTextSearchAgent, isTextSearchAvailable, type Task } from './agents/text-search.js'
import { runAtlasAgent } from './agents/atlas.js'
import { getOrCreateEngine } from '../src/core/engine-pool.js'

const REPO_ROOT = resolve(import.meta.dir, '..')

interface CliOptions {
	corpora: string[] | null   // null = all
	capabilitiesOnly: boolean
	noClone: boolean
}

function parseCli(argv: string[]): CliOptions {
	const opts: CliOptions = { corpora: null, capabilitiesOnly: false, noClone: false }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--all') opts.corpora = null
		else if (a === '--corpus') {
			opts.corpora = opts.corpora ?? []
			opts.corpora.push(argv[++i])
		}
		else if (a === '--capabilities') opts.capabilitiesOnly = true
		else if (a === '--no-clone') opts.noClone = true
	}
	if (opts.corpora === null && !opts.capabilitiesOnly) {
		// default = all when nothing specified
	}
	return opts
}

interface TaskResult {
	taskId: string
	corpus: string
	capability: string
	comparable: boolean
	atlasScore: number
	textSearchScore: number | null
	atlasMs: number
	textSearchMs: number | null
}

function loadTasksForCorpus(corpus: string): Task[] {
	const dir = join(REPO_ROOT, 'bench-eval', 'tasks', corpus)
	if (!existsSync(dir)) return []
	const tasks: Task[] = []
	for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
		const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Task
		tasks.push(raw)
	}
	return tasks
}

async function runOne(task: Task, corpusName: string, corpusRoot: string): Promise<TaskResult> {
	const engine = getOrCreateEngine(undefined, corpusRoot)

	const aStart = performance.now()
	const aAns = await runAtlasAgent(task, engine)
	const aMs = performance.now() - aStart
	const aScore = judge(task.expected as Expected, aAns)

	let tScore: number | null = null
	let tMs: number | null = null
	if (task.comparable_to_text_search && isTextSearchAvailable()) {
		const tStart = performance.now()
		const tAns = runTextSearchAgent(task, corpusRoot)
		tMs = performance.now() - tStart
		tScore = judge(task.expected as Expected, tAns)
	}

	return {
		taskId: task.id,
		corpus: corpusName,
		capability: task.capability,
		comparable: task.comparable_to_text_search,
		atlasScore: aScore,
		textSearchScore: tScore,
		atlasMs: Math.round(aMs * 100) / 100,
		textSearchMs: tMs !== null ? Math.round(tMs * 100) / 100 : null,
	}
}

function pad(s: string, n: number): string {
	return s.length >= n ? s : s + ' '.repeat(n - s.length)
}
function padNum(n: number | null, width: number, decimals = 2): string {
	const s = n === null ? '—' : n.toFixed(decimals)
	return s.padStart(width, ' ')
}

function printComparableTable(results: TaskResult[]): void {
	const comp = results.filter((r) => r.comparable)
	if (comp.length === 0) return
	console.log('\n=== comparable (atlas vs text-search) ===')
	console.log(`${pad('task', 38)}  ${pad('cap', 18)}  ${pad('atlas', 7)}  ${pad('grep', 7)}  delta`)
	for (const r of comp) {
		const delta = r.textSearchScore !== null ? r.atlasScore - r.textSearchScore : null
		console.log(
			`${pad(r.taskId, 38)}  ${pad(r.capability, 18)}  ${padNum(r.atlasScore, 7)}  ${padNum(r.textSearchScore, 7)}  ${delta === null ? '   —' : padNum(delta, 6)}`,
		)
	}
	const aMean = avg(comp.map((r) => r.atlasScore))
	const tMean = avg(comp.filter((r) => r.textSearchScore !== null).map((r) => r.textSearchScore as number))
	console.log(`\n${pad('AGGREGATE', 38)}  ${pad('', 18)}  ${padNum(aMean, 7)}  ${padNum(tMean, 7)}  ${padNum(aMean - tMean, 6)}`)
}

function printCapabilityTable(results: TaskResult[]): void {
	const atlasOnly = results.filter((r) => !r.comparable)
	if (atlasOnly.length === 0) return
	console.log('\n=== atlas-only capabilities (no baseline) ===')
	console.log(`${pad('task', 38)}  ${pad('cap', 18)}  ${pad('score', 7)}  ms`)
	for (const r of atlasOnly) {
		console.log(`${pad(r.taskId, 38)}  ${pad(r.capability, 18)}  ${padNum(r.atlasScore, 7)}  ${padNum(r.atlasMs, 6)}`)
	}
	const mean = avg(atlasOnly.map((r) => r.atlasScore))
	console.log(`\n${pad('AGGREGATE', 38)}  ${pad('', 18)}  ${padNum(mean, 7)}`)
}

function avg(xs: number[]): number {
	return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length
}

function commitSha(): string {
	const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' })
	return r.status === 0 ? (r.stdout ?? '').trim() : 'nogit'
}

async function main() {
	const opts = parseCli(process.argv.slice(2))
	const all = listCorpora()
	const corpora = opts.corpora ?? all
	if (corpora.length === 0) {
		console.error('no corpora found. add bench-eval/corpora/<name>/manifest.json first.')
		process.exit(1)
	}

	if (!isTextSearchAvailable()) {
		console.warn('warn: ripgrep (rg) not on PATH — text-search baseline will be skipped on every task.')
	}

	const results: TaskResult[] = []
	for (const corpus of corpora) {
		const tasks = loadTasksForCorpus(corpus)
		if (tasks.length === 0) {
			console.warn(`skip ${corpus}: no tasks under bench-eval/tasks/${corpus}/`)
			continue
		}
		const filtered = opts.capabilitiesOnly ? tasks.filter((t) => !t.comparable_to_text_search) : tasks
		if (filtered.length === 0) continue

		console.log(`\n--- ${corpus}: ${filtered.length} tasks ---`)
		const manifest = loadManifest(corpus)
		const ensured = ensureCorpus(manifest, { freshClone: false })
		console.log(`  corpus root: ${ensured.rootPath}${ensured.cached ? ' (cached)' : ''}`)

		// ensure the corpus is indexed. skip when status already matches
		// the manifest's pinned commit — atlas's indexer otherwise re-runs
		// the post-processing pipelines (flow / duplicate / subsystem
		// detection) on every invocation, which is many minutes on a
		// 5k-symbol corpus and contributes nothing to scoring.
		const engine = getOrCreateEngine(undefined, ensured.rootPath)
		const status = (() => { try { return engine.status() } catch { return null } })()
		const fresh = status?.lastCommit?.startsWith(manifest.ref.slice(0, 8)) && status.stats.symbols > 0
		if (fresh) {
			console.log(`  index: cached at ${status?.lastCommit?.slice(0, 8)} (${status?.stats.files} files, ${status?.stats.symbols} symbols)`)
		} else {
			const indexStart = performance.now()
			const indexResult = await engine.index({
				noEmbed: true,
				noSummarize: true,
				withGitHub: false,
			})
			const indexMs = Math.round(performance.now() - indexStart)
			console.log(`  index: ${indexResult.filesTotal} files (${indexResult.symbols} symbols, ${indexResult.edges} edges) in ${indexMs}ms`)
		}

		for (const task of filtered) {
			const r = await runOne(task, corpus, ensured.rootPath)
			results.push(r)
			const cmp = r.textSearchScore !== null
				? `atlas ${r.atlasScore.toFixed(2)} vs grep ${r.textSearchScore.toFixed(2)}`
				: `atlas ${r.atlasScore.toFixed(2)} (capability-only)`
			console.log(`  ${pad(task.id, 38)} ${cmp}`)
		}
	}

	printComparableTable(results)
	printCapabilityTable(results)

	// write results json
	const resultsDir = join(REPO_ROOT, 'bench-eval', 'results')
	mkdirSync(resultsDir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const outFile = join(resultsDir, `${commitSha()}-${stamp}.json`)
	writeFileSync(outFile, `${JSON.stringify({ commit: commitSha(), timestamp: Date.now(), results }, null, 2)}\n`)
	console.log(`\nwrote ${outFile}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
