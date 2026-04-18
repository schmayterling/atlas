#!/usr/bin/env bun
// bench-llm phase 2 runner. drives baseline (text tools) and with-atlas
// (text + atlas tools) agents through the curated subset of bench-eval
// tasks via openrouter, scores them with bench-eval's judge, and emits
// per-task + per-capability deltas.
//
// usage:
//   OPENROUTER_API_KEY=... bun run bench-llm --ci          ~5 cheapest tasks (~$1)
//   OPENROUTER_API_KEY=... bun run bench-llm --full        full curated subset (~$5-10)
//   bun run bench-llm --ci --model openai/gpt-4o-mini      cheaper model
//   bun run bench-llm --task ripgrep-02-discovery          one task
//
// the task source is bench-eval/tasks/<corpus>/. that's the same task
// set the deterministic bench-eval/run.ts uses, so we're answering the
// SAME questions as the structural eval — just with an LLM in the loop.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureCorpus, listCorpora, loadManifest } from '../bench-eval/lib/corpus.js'
import { judge, type Expected } from '../bench-eval/lib/judge.js'
import type { Task } from '../bench-eval/agents/text-search.js'
import { getOrCreateEngine } from '../src/core/engine-pool.js'
import { runBaselineAgent } from './agents/baseline.js'
import { runWithAtlasAgent } from './agents/with-atlas.js'
import type { LlmAgentResult } from './lib/llm-agent.js'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5'

// ci subset: cheap tasks where one variant clearly beats the other or
// where the wall-time stays under a few iterations. expanded after the
// first published numbers prove the harness.
const CI_TASK_IDS = new Set([
	'ripgrep-02-discovery',
	'ripgrep-04-call-tracing',
	'ripgrep-05-graph-querying',
	'zod-02-discovery',
	'zod-04-call-tracing',
])

interface CliOptions {
	mode: 'ci' | 'full' | 'task'
	taskFilter: string | null
	model: string
	trials: number
	corpora: string[] | null
}

function parseCli(argv: string[]): CliOptions {
	const opts: CliOptions = { mode: 'ci', taskFilter: null, model: DEFAULT_MODEL, trials: 1, corpora: null }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--ci') opts.mode = 'ci'
		else if (a === '--full') opts.mode = 'full'
		else if (a === '--task') { opts.mode = 'task'; opts.taskFilter = argv[++i] }
		else if (a === '--model') opts.model = argv[++i]
		else if (a === '--trials') opts.trials = Math.max(1, Number(argv[++i]))
		else if (a === '--corpus') (opts.corpora ??= []).push(argv[++i])
	}
	return opts
}

interface CorpusTasks {
	corpus: string
	tasks: Task[]
}

function loadAllTasks(): CorpusTasks[] {
	const out: CorpusTasks[] = []
	for (const corpus of listCorpora()) {
		const dir = join(REPO_ROOT, 'bench-eval', 'tasks', corpus)
		const tasks: Task[] = []
		for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
			tasks.push(JSON.parse(readFileSync(join(dir, file), 'utf-8')))
		}
		if (tasks.length > 0) out.push({ corpus, tasks })
	}
	return out
}

function expectedShape(task: Task): 'symbols' | 'count' | 'files' | 'structural' {
	const t = (task.expected as { type: string }).type
	if (t === 'symbol-set')  return 'symbols'
	if (t === 'count')       return 'count'
	if (t === 'file-path')   return 'files'
	return 'structural'
}

interface TrialResult {
	taskId: string
	corpus: string
	capability: string
	agent: 'baseline' | 'with-atlas'
	score: number
	tokens: number
	cost: number
	toolCalls: number
	wallMs: number
	stoppedReason: string
	error?: string
}

async function runTask(corpus: string, corpusRoot: string, task: Task, model: string, trials: number): Promise<TrialResult[]> {
	const engine = getOrCreateEngine(undefined, corpusRoot)
	const taskInput = {
		id: task.id, capability: task.capability, intent: (task as any).intent ?? '',
		expectedShape: expectedShape(task),
	}

	const results: TrialResult[] = []
	for (let trial = 0; trial < trials; trial++) {
		const baseRun = await runBaselineAgent({ model, task: taskInput, corpusRoot })
		const baseScore = judge(task.expected as Expected, baseRun.answer)
		results.push(toTrial(corpus, task, 'baseline', baseRun, baseScore))

		const atlasRun = await runWithAtlasAgent({ model, task: taskInput, corpusRoot, engine })
		const atlasScore = judge(task.expected as Expected, atlasRun.answer)
		results.push(toTrial(corpus, task, 'with-atlas', atlasRun, atlasScore))
	}
	return results
}

function toTrial(corpus: string, task: Task, agent: 'baseline' | 'with-atlas', r: LlmAgentResult, score: number): TrialResult {
	return {
		taskId: task.id, corpus, capability: task.capability,
		agent,
		score,
		tokens: r.tokens.total,
		cost: r.cost,
		toolCalls: r.toolCallCount,
		wallMs: r.wallMs,
		stoppedReason: r.stoppedReason,
		error: r.error,
	}
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length) }
function padNum(n: number, w: number, dec = 2): string { return n.toFixed(dec).padStart(w, ' ') }

function summarize(rows: TrialResult[]): void {
	console.log('\n=== llm head-to-head ===')
	console.log(`${pad('task', 38)}  ${pad('agent', 12)}  score   tokens   cost    tools  ms`)
	for (const r of rows) {
		console.log(
			pad(r.taskId, 38), '',
			pad(r.agent, 12), '',
			padNum(r.score, 5), '',
			pad(String(r.tokens), 8), '',
			padNum(r.cost, 6, 4), '',
			pad(String(r.toolCalls), 5), '',
			pad(String(r.wallMs), 6),
			r.error ? `(${r.error.slice(0, 60)})` : '',
		)
	}

	const byAgent = new Map<string, TrialResult[]>()
	for (const r of rows) {
		const key = r.agent
		if (!byAgent.has(key)) byAgent.set(key, [])
		byAgent.get(key)!.push(r)
	}

	console.log('\naggregate per agent:')
	for (const [agent, trs] of byAgent) {
		const avg = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
		const sumTokens = trs.reduce((s, r) => s + r.tokens, 0)
		const sumCost = trs.reduce((s, r) => s + r.cost, 0)
		console.log(
			`  ${pad(agent, 12)}  mean-score=${avg(trs.map((r) => r.score)).toFixed(3)}  total-tokens=${sumTokens}  total-cost=$${sumCost.toFixed(4)}  mean-tool-calls=${avg(trs.map((r) => r.toolCalls)).toFixed(1)}`,
		)
	}

	const baseline = byAgent.get('baseline') ?? []
	const atlas = byAgent.get('with-atlas') ?? []
	if (baseline.length && atlas.length) {
		const meanB = baseline.reduce((s, r) => s + r.score, 0) / baseline.length
		const meanA = atlas.reduce((s, r) => s + r.score, 0) / atlas.length
		const tokB = baseline.reduce((s, r) => s + r.tokens, 0) / baseline.length
		const tokA = atlas.reduce((s, r) => s + r.tokens, 0) / atlas.length
		console.log(`\ndelta (with-atlas − baseline):`)
		console.log(`  score:  ${(meanA - meanB >= 0 ? '+' : '')}${(meanA - meanB).toFixed(3)}`)
		console.log(`  tokens: ${(tokA - tokB >= 0 ? '+' : '')}${Math.round(tokA - tokB)} per task (${tokB > 0 ? (((tokA - tokB) / tokB) * 100).toFixed(0) : '—'}%)`)
	}
}

function commitSha(): string {
	const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' })
	return r.status === 0 ? (r.stdout ?? '').trim() : 'nogit'
}

async function main() {
	const opts = parseCli(process.argv.slice(2))
	if (!process.env.OPENROUTER_API_KEY) {
		console.error('error: OPENROUTER_API_KEY env var required')
		process.exit(1)
	}

	const all = loadAllTasks()
	const filtered: { corpus: string; task: Task }[] = []
	for (const { corpus, tasks } of all) {
		if (opts.corpora && !opts.corpora.includes(corpus)) continue
		for (const t of tasks) {
			if (opts.mode === 'ci' && !CI_TASK_IDS.has(t.id)) continue
			if (opts.mode === 'task' && t.id !== opts.taskFilter) continue
			filtered.push({ corpus, task: t })
		}
	}
	if (filtered.length === 0) {
		console.error(`no tasks matched (mode=${opts.mode}${opts.taskFilter ? ` task=${opts.taskFilter}` : ''})`)
		process.exit(1)
	}

	console.log(`bench-llm: model=${opts.model} mode=${opts.mode} tasks=${filtered.length} trials=${opts.trials}`)

	const allRows: TrialResult[] = []
	const corpusEnsured = new Set<string>()

	for (const { corpus, task } of filtered) {
		if (!corpusEnsured.has(corpus)) {
			const m = loadManifest(corpus)
			ensureCorpus(m, { freshClone: false })
			corpusEnsured.add(corpus)
		}
		const root = join(REPO_ROOT, '.bench-cache', corpus, /* short */ '')
		// resolve to the actual cached path
		const ensured = ensureCorpus(loadManifest(corpus))
		const trials = await runTask(corpus, ensured.rootPath, task, opts.model, opts.trials)
		allRows.push(...trials)
		for (const t of trials) {
			const tag = t.agent.padEnd(12)
			console.log(`  ${task.id} ${tag} score=${t.score.toFixed(2)} tokens=${t.tokens} cost=$${t.cost.toFixed(4)} tools=${t.toolCalls}`)
		}
		void root
	}

	summarize(allRows)

	mkdirSync(join(REPO_ROOT, 'bench-llm', 'results'), { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const outFile = join(REPO_ROOT, 'bench-llm', 'results', `${commitSha()}-${stamp}.json`)
	writeFileSync(outFile, JSON.stringify({ commit: commitSha(), model: opts.model, trials: opts.trials, results: allRows }, null, 2))
	console.log(`\nwrote ${outFile}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
