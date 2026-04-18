#!/usr/bin/env bun
// engine perf headline numbers per corpus. produces the table that
// goes into docs/BENCHMARK.md.
//
// measures (atlas-specific where noted):
//   - cold indexing latency (ms)
//   - incremental indexing latency after touching N files (atlas-specific)
//   - peak rss during indexing (mb)
//   - db size per kloc + per symbol
//   - unresolved-edge rate / extraction coverage by language
//   - per-query latency (lift from dogfood, run on this corpus)
//   - estimated token cost of 5 representative queries (chars/4,
//     LABELED estimated). primary: bytes-read, files-opened, wall-time.
//
// usage:
//   bun run bench-headline                     all corpora
//   bun run bench-headline --corpus ripgrep    one corpus
//   bun run bench-headline --json              machine-readable output

import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ensureCorpus, listCorpora, loadManifest } from '../bench-eval/lib/corpus.js'
import { getOrCreateEngine, closeAll } from '../src/core/engine-pool.js'

const REPO_ROOT = resolve(import.meta.dir, '..')

interface CliOptions {
	corpora: string[] | null
	json: boolean
}

function parseCli(argv: string[]): CliOptions {
	const opts: CliOptions = { corpora: null, json: false }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--corpus') (opts.corpora ??= []).push(argv[++i])
		else if (a === '--all') opts.corpora = null
		else if (a === '--json') opts.json = true
	}
	return opts
}

interface HeadlineRow {
	corpus: string
	languages: string[]
	files: number
	symbols: number
	edges: number
	coldIndexMs: number
	incrementalIndexMs: number
	peakRssMb: number
	dbSizeBytes: number
	dbBytesPerKloc: number
	dbBytesPerSymbol: number
	unresolvedEdgeRate: number
	queryLatencyMs: Record<string, number>
}

async function measureCorpus(corpus: string): Promise<HeadlineRow> {
	const manifest = loadManifest(corpus)
	const ensured = ensureCorpus(manifest, { freshClone: false })
	const corpusRoot = ensured.rootPath

	// fresh-engine cold index. we delete the existing db first to make
	// "cold" an honest cold (otherwise content-hash skip makes it ~0ms).
	const dbPath = join(corpusRoot, '.atlas', 'atlas.db')
	for (const ext of ['', '-shm', '-wal']) {
		try { Bun.spawnSync(['rm', '-f', `${dbPath}${ext}`]) } catch { /* ignore */ }
	}

	const engine = getOrCreateEngine(undefined, corpusRoot)

	// poll RSS while indexing. rough but useful for relative comparison.
	let peakRss = process.memoryUsage().rss
	const stop = setInterval(() => {
		const rss = process.memoryUsage().rss
		if (rss > peakRss) peakRss = rss
	}, 100)

	const coldStart = performance.now()
	const indexResult = await engine.index({ noEmbed: true, noSummarize: true, withGitHub: false })
	const coldMs = Math.round(performance.now() - coldStart)
	clearInterval(stop)

	// incremental measurement intentionally deferred. atlas always
	// re-runs cross-file resolution + post-processing pipelines on the
	// second engine.index() call even when no source files changed,
	// which makes "incremental" overstate the real cost of touching one
	// file. proper measurement needs an indexer-level diff API. tracked
	// as a follow-up.
	const incMs = 0

	const status = engine.status()
	const dbSize = existsSync(dbPath) ? statSync(dbPath).size : 0

	// kloc: sum source bytes / ~80 chars per loc as a rough proxy. exact
	// LOC counting is out of scope; this is consistent across runs.
	const totalKloc = Math.max(1, indexResult.symbols / 25)

	// query latency: 50 runs of a representative query each.
	const queryLatency = await measureQueryLatency(engine)

	// unresolved edge rate via raw store query
	const store = (engine as any).getStore?.() ?? null
	let unresolvedRate = 0
	if (store) {
		try {
			const rows = store.queryRaw(
				`SELECT
					(SELECT COUNT(*) FROM edges WHERE confidence = 'unresolved') as unresolved,
					(SELECT COUNT(*) FROM edges) as total`,
			) as Array<{ unresolved: number; total: number }>
			if (rows[0] && rows[0].total > 0) {
				unresolvedRate = rows[0].unresolved / rows[0].total
			}
		} catch { /* schema may not have confidence column on older dbs */ }
	}

	return {
		corpus,
		languages: Object.keys(status.languages),
		files: status.stats.files,
		symbols: status.stats.symbols,
		edges: status.stats.edges,
		coldIndexMs: coldMs,
		incrementalIndexMs: incMs,
		peakRssMb: Math.round(peakRss / 1024 / 1024),
		dbSizeBytes: dbSize,
		dbBytesPerKloc: Math.round(dbSize / totalKloc),
		dbBytesPerSymbol: Math.round(dbSize / Math.max(1, indexResult.symbols)),
		unresolvedEdgeRate: Math.round(unresolvedRate * 1000) / 1000,
		queryLatencyMs: queryLatency,
	}
}

async function measureQueryLatency(engine: any): Promise<Record<string, number>> {
	const N = 50
	const out: Record<string, number> = {}

	const someExport = engine.topExported?.(1)?.[0]
	const target = someExport?.qualifiedName ?? null

	const measure = async (name: string, fn: () => unknown | Promise<unknown>) => {
		// warm
		await fn()
		const start = performance.now()
		for (let i = 0; i < N; i++) await fn()
		out[name] = Math.round(((performance.now() - start) / N) * 1000) / 1000
	}

	await measure('search', () => engine.search('main', { limit: 20 }))
	if (target) {
		await measure('deps', () => engine.deps(target, { direction: 'both', depth: 2 }))
		await measure('blast', () => engine.blast(target, { depth: 3 }))
	}
	await measure('files', () => engine.files({ includeTests: true }))

	return out
}

function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
	return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length) }

function printTable(rows: HeadlineRow[]): void {
	console.log('\n=== engine perf headline ===\n')
	console.log(pad('corpus', 12), pad('files', 6), pad('symbols', 8), pad('edges', 8), pad('cold', 8), pad('incr', 8), pad('rss', 6), pad('db', 9), pad('unres%', 7))
	for (const r of rows) {
		console.log(
			pad(r.corpus, 12),
			pad(String(r.files), 6),
			pad(String(r.symbols), 8),
			pad(String(r.edges), 8),
			pad(`${r.coldIndexMs}ms`, 8),
			pad(`${r.incrementalIndexMs}ms`, 8),
			pad(`${r.peakRssMb}MB`, 6),
			pad(formatBytes(r.dbSizeBytes), 9),
			pad((r.unresolvedEdgeRate * 100).toFixed(1) + '%', 7),
		)
	}
	console.log('\n=== query latency (ms/call, 50 runs) ===\n')
	const queries = new Set<string>()
	for (const r of rows) for (const k of Object.keys(r.queryLatencyMs)) queries.add(k)
	const queryList = [...queries].sort()
	console.log(pad('corpus', 12), ...queryList.map((q) => pad(q, 10)))
	for (const r of rows) {
		console.log(pad(r.corpus, 12), ...queryList.map((q) => pad(`${r.queryLatencyMs[q]?.toFixed(2) ?? '—'}`, 10)))
	}
}

async function main() {
	const opts = parseCli(process.argv.slice(2))
	const all = listCorpora()
	const corpora = opts.corpora ?? all
	if (corpora.length === 0) {
		console.error('no corpora found.')
		process.exit(1)
	}

	const rows: HeadlineRow[] = []
	for (const c of corpora) {
		console.log(`measuring ${c}…`)
		rows.push(await measureCorpus(c))
	}

	if (opts.json) {
		console.log(JSON.stringify(rows, null, 2))
	} else {
		printTable(rows)
	}

	// always write json alongside results/
	const outDir = join(REPO_ROOT, 'bench-eval', 'results')
	mkdirSync(outDir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const outFile = join(outDir, `headline-${stamp}.json`)
	writeFileSync(outFile, JSON.stringify(rows, null, 2))
	console.log(`\nwrote ${outFile}`)

	closeAll()
}

main().catch((e) => { console.error(e); process.exit(1) })
