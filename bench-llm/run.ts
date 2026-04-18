#!/usr/bin/env bun
// bench-llm phase 2 runner. drives baseline (text tools) and with-atlas
// (text + atlas tools) agents through the curated subset of bench-eval
// tasks via openrouter, scores them with bench-eval's judge, and emits
// per-task + per-capability deltas.
//
// usage:
//   OPENROUTER_API_KEY=... bun run bench-llm --ci                 ~5 cheapest tasks
//   OPENROUTER_API_KEY=... bun run bench-llm --full               full curated subset
//   bun run bench-llm --ci --model openai/gpt-4o-mini             cheaper model
//   bun run bench-llm --task ripgrep-02-discovery                 one task
//   bun run bench-llm --full --trials 3                           3 trials per task
//   bun run bench-llm --full --concurrency 8                      8 agents in flight
//
// the task source is bench-eval/tasks/<corpus>/. that's the same task
// set the deterministic bench-eval/run.ts uses, so we're answering the
// SAME questions as the structural eval — just with an LLM in the loop.
//
// concurrency: every (task, trial, agent) combination is an independent
// job. they're dispatched through a simple async pool with a configurable
// worker count (default 5). openrouter gateways upstream rate limits, so
// bumping beyond ~10 on a free-tier key usually starts producing 429s
// that show up as error rows in the results.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import pc from 'picocolors'
import { resolve as resolvePath } from 'node:path'
import { ensureCorpus, listCorpora, loadManifest } from '../bench-eval/lib/corpus.js'
import { judge, type Expected, type AgentAnswer } from '../bench-eval/lib/judge.js'
import type { Task } from '../bench-eval/agents/text-search.js'
import { getOrCreateEngine } from '../src/core/engine-pool.js'
import { runBaselineAgent } from './agents/baseline.js'
import { runWithAtlasAgent } from './agents/with-atlas.js'
import { runWithCbmAgent, closeCbmAgents } from './agents/with-cbm.js'
import { runWithChunkhoundAgent, closeChunkhoundAgents } from './agents/with-chunkhound.js'
import type { LlmAgentResult } from './lib/llm-agent.js'
import { runPool } from './lib/pool.js'
import { preconfigure, closePreconfiguredHandles } from './lib/preconfigure.js'
import { judgeWithLlm } from './lib/llm-judge.js'

const CHUNKHOUND_CONFIG = process.env.CHUNKHOUND_CONFIG_FILE
	|| resolvePath(import.meta.dir, 'config', 'chunkhound.json')

const REPO_ROOT = resolve(import.meta.dir, '..')
const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5'
const DEFAULT_CONCURRENCY = 5

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

type AgentName = 'baseline' | 'atlas' | 'cbm' | 'chunkhound'
const ALL_AGENTS: AgentName[] = ['baseline', 'atlas', 'cbm', 'chunkhound']
const DEFAULT_AGENTS: AgentName[] = ['baseline', 'atlas']
const DEFAULT_JUDGE_MODEL = 'openai/gpt-5.4-nano'

interface CliOptions {
	mode: 'ci' | 'full' | 'task'
	taskFilter: string | null
	model: string
	trials: number
	corpora: string[] | null
	concurrency: number
	agents: AgentName[]
	llmJudge: boolean
	judgeModel: string
	skipPreconfig: boolean
}

function parseCli(argv: string[]): CliOptions {
	const opts: CliOptions = {
		mode: 'ci', taskFilter: null, model: DEFAULT_MODEL, trials: 1,
		corpora: null, concurrency: DEFAULT_CONCURRENCY, agents: [...DEFAULT_AGENTS],
		llmJudge: false, judgeModel: DEFAULT_JUDGE_MODEL, skipPreconfig: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--ci') opts.mode = 'ci'
		else if (a === '--full') opts.mode = 'full'
		else if (a === '--task') { opts.mode = 'task'; opts.taskFilter = argv[++i] }
		else if (a === '--model') opts.model = argv[++i]
		else if (a === '--trials') opts.trials = Math.max(1, Number(argv[++i]))
		else if (a === '--corpus') (opts.corpora ??= []).push(argv[++i])
		else if (a === '--concurrency') opts.concurrency = Math.max(1, Number(argv[++i]))
		else if (a === '--agents') {
			const list = argv[++i].split(',').map((x) => x.trim()) as AgentName[]
			for (const a of list) {
				if (!ALL_AGENTS.includes(a)) throw new Error(`unknown agent '${a}'. valid: ${ALL_AGENTS.join(',')}`)
			}
			opts.agents = list
		}
		else if (a === '--judge-with-llm') opts.llmJudge = true
		else if (a === '--judge-model') opts.judgeModel = argv[++i]
		else if (a === '--skip-preconfig') opts.skipPreconfig = true
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
	agent: AgentName
	trial: number
	score: number
	llmScore?: number | null
	llmRationale?: string
	llmJudgeTokens?: number
	llmJudgeCost?: number
	tokens: number
	cost: number
	toolCalls: number
	wallMs: number
	stoppedReason: string
	error?: string
	rawAnswer?: AgentAnswer
}

// one unit of work for the pool: a single (task, trial, agent) run.
interface Job {
	corpus: string
	corpusRoot: string
	task: Task
	trial: number
	agent: AgentName
	model: string
	llmJudge: boolean
	judgeModel: string
}

function toTrial(job: Job, r: LlmAgentResult, score: number): TrialResult {
	return {
		taskId: job.task.id,
		corpus: job.corpus,
		capability: job.task.capability,
		agent: job.agent,
		trial: job.trial,
		score,
		tokens: r.tokens.total,
		cost: r.cost,
		toolCalls: r.toolCallCount,
		wallMs: r.wallMs,
		stoppedReason: r.stoppedReason,
		error: r.error,
	}
}

async function runJob(job: Job): Promise<TrialResult> {
	const taskInput = {
		id: job.task.id,
		capability: job.task.capability,
		intent: (job.task as any).intent ?? '',
		expectedShape: expectedShape(job.task),
	}
	let r: LlmAgentResult
	switch (job.agent) {
		case 'baseline':
			r = await runBaselineAgent({ model: job.model, task: taskInput, corpusRoot: job.corpusRoot })
			break
		case 'atlas': {
			const engine = getOrCreateEngine(undefined, job.corpusRoot)
			r = await runWithAtlasAgent({ model: job.model, task: taskInput, corpusRoot: job.corpusRoot, engine })
			break
		}
		case 'cbm':
			r = await runWithCbmAgent({ model: job.model, task: taskInput, corpusRoot: job.corpusRoot })
			break
		case 'chunkhound':
			r = await runWithChunkhoundAgent({ model: job.model, task: taskInput, corpusRoot: job.corpusRoot })
			break
	}
	const score = judge(job.task.expected as Expected, r.answer)
	const trial = toTrial(job, r, score)
	trial.rawAnswer = r.answer

	if (job.llmJudge) {
		try {
			const j = await judgeWithLlm({
				judgeModel: job.judgeModel,
				taskIntent: taskInput.intent || job.task.id,
				expected: job.task.expected as Expected,
				answer: r.answer,
			})
			trial.llmScore = j.score
			trial.llmRationale = j.rationale
			trial.llmJudgeTokens = j.tokens
			trial.llmJudgeCost = j.cost
		} catch (e) {
			trial.llmScore = null
			trial.llmRationale = `judge call failed: ${e instanceof Error ? e.message : String(e)}`
		}
	}
	return trial
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length) }
function padNum(n: number, w: number, dec = 2): string { return n.toFixed(dec).padStart(w, ' ') }

function summarize(rows: TrialResult[]): void {
	console.log('\n=== llm head-to-head ===')
	console.log(`${pad('task', 38)}  ${pad('agent', 12)}  trial  score   tokens   cost    tools  ms`)
	const sorted = [...rows].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.agent.localeCompare(b.agent) || a.trial - b.trial)
	for (const r of sorted) {
		console.log(
			pad(r.taskId, 38), '',
			pad(r.agent, 12), '',
			pad(String(r.trial + 1), 5), '',
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
		if (!byAgent.has(r.agent)) byAgent.set(r.agent, [])
		byAgent.get(r.agent)!.push(r)
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
	if (baseline.length === 0) return
	const meanB = baseline.reduce((s, r) => s + r.score, 0) / baseline.length
	const tokB = baseline.reduce((s, r) => s + r.tokens, 0) / baseline.length

	console.log(`\ndelta vs baseline:`)
	for (const [agent, trs] of byAgent) {
		if (agent === 'baseline') continue
		const meanA = trs.reduce((s, r) => s + r.score, 0) / trs.length
		const tokA = trs.reduce((s, r) => s + r.tokens, 0) / trs.length
		const dScore = meanA - meanB
		const dTok = tokA - tokB
		const tokPct = tokB > 0 ? ((dTok / tokB) * 100).toFixed(0) : '—'
		console.log(
			`  ${pad(agent, 12)}  score=${dScore >= 0 ? '+' : ''}${dScore.toFixed(3)}  tokens=${dTok >= 0 ? '+' : ''}${Math.round(dTok)} per task (${dTok >= 0 ? '+' : ''}${tokPct}%)`,
		)
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

	// pre-ensure every corpus serially. cheap — a no-op when cached.
	// doing this up front means the parallel pool doesn't race on
	// clone + checkout.
	const corpusRoots = new Map<string, string>()
	for (const corpus of new Set(filtered.map((f) => f.corpus))) {
		const ensured = ensureCorpus(loadManifest(corpus), { freshClone: false })
		corpusRoots.set(corpus, ensured.rootPath)
	}

	// header
	const header = [
		pc.bold(pc.cyan('bench-llm')),
		`model=${pc.yellow(opts.model)}`,
		`agents=${pc.green(opts.agents.join(','))}`,
		`tasks=${filtered.length}`,
		`trials=${opts.trials}`,
		`concurrency=${opts.concurrency}`,
	]
	if (opts.llmJudge) header.push(`llm-judge=${pc.magenta(opts.judgeModel)}`)
	console.log(header.join('  '))

	// preconfigure: ensure each non-baseline agent has indexed every
	// corpus before any LLM jobs start. without this the FIRST task per
	// (agent, corpus) absorbs all the indexing cost and looks
	// artificially slow + expensive in the per-task table.
	if (!opts.skipPreconfig) {
		console.log(`\n${pc.bold('preconfigure')}`)
		const corpusList = [...corpusRoots.entries()].map(([name, root]) => ({ name, root }))
		const preSteps = await preconfigure(opts.agents, corpusList, CHUNKHOUND_CONFIG)
		const failed = preSteps.filter((s) => !s.ok)
		if (failed.length > 0) {
			console.log(`\n${pc.red(`${failed.length} preconfigure step(s) failed`)} — affected agents will produce error rows below.`)
		}
	}

	// build the full job list: (task × trial × agent). run all in parallel
	// up to `concurrency`. openrouter handles rate limiting upstream.
	const jobs: Job[] = []
	for (const { corpus, task } of filtered) {
		const corpusRoot = corpusRoots.get(corpus)!
		for (let trial = 0; trial < opts.trials; trial++) {
			for (const agent of opts.agents) {
				jobs.push({ corpus, corpusRoot, task, trial, agent, model: opts.model, llmJudge: opts.llmJudge, judgeModel: opts.judgeModel })
			}
		}
	}

	console.log(`\n${pc.bold('running')}  total=${jobs.length}\n`)

	const startAll = performance.now()
	const poolResults = await runPool(jobs, opts.concurrency, runJob, (done, total, last) => {
		const job = jobs[last.index]
		const idx = `[${String(done).padStart(String(total).length, ' ')}/${total}]`
		const taskId = pc.dim(job.task.id.padEnd(28))
		const agent = colorAgent(job.agent).padEnd(20)
		const trialTag = `t${job.trial + 1}`
		if (last.error) {
			console.log(`  ${pc.red('✗')} ${pc.dim(idx)} ${taskId} ${agent} ${trialTag}  ${pc.red('ERROR')}: ${pc.dim(last.error.message.slice(0, 60))}`)
			return
		}
		const r = last.value!
		const tag = scoreColor(r.score)
		const llmTag = r.llmScore !== undefined && r.llmScore !== null
			? `  llm=${scoreColor(r.llmScore)}`
			: ''
		console.log(
			`  ${pc.green('✓')} ${pc.dim(idx)} ${taskId} ${agent} ${trialTag}  score=${tag}${llmTag}  ${pc.dim(`${r.tokens}t  $${r.cost.toFixed(4)}  ${r.toolCalls}c  ${r.wallMs}ms`)}`,
		)
	})
	const wallSec = ((performance.now() - startAll) / 1000).toFixed(1)

	const allRows: TrialResult[] = []
	let errored = 0
	for (const pr of poolResults) {
		if (pr.value) allRows.push(pr.value)
		else errored++
	}
	if (errored > 0) console.log(`\n(${errored} job(s) errored, excluded from aggregates)`)
	console.log(`(wall: ${wallSec}s across ${opts.concurrency} concurrent workers)`)

	summarize(allRows)

	mkdirSync(join(REPO_ROOT, 'bench-llm', 'results'), { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const outFile = join(REPO_ROOT, 'bench-llm', 'results', `${commitSha()}-${stamp}.json`)
	writeFileSync(outFile, JSON.stringify({
		commit: commitSha(),
		model: opts.model,
		trials: opts.trials,
		concurrency: opts.concurrency,
		wallSec: Number(wallSec),
		agents: opts.agents,
		results: allRows,
	}, null, 2))
	console.log(`\nwrote ${outFile}`)

	// tear down spawned mcp clients (cbm + chunkhound + preconfigured
	// handles). harmless when neither was used in this run.
	await Promise.allSettled([closeCbmAgents(), closeChunkhoundAgents(), closePreconfiguredHandles()])
}

function colorAgent(name: AgentName): string {
	switch (name) {
		case 'baseline':   return pc.gray(name)
		case 'atlas':      return pc.cyan(name)
		case 'cbm':        return pc.magenta(name)
		case 'chunkhound': return pc.yellow(name)
	}
}

function scoreColor(s: number): string {
	const t = s.toFixed(2)
	if (s >= 0.99) return pc.green(t)
	if (s >= 0.5)  return pc.yellow(t)
	if (s > 0)     return pc.yellow(pc.dim(t))
	return pc.red(t)
}

main().catch((e) => { console.error(e); process.exit(1) })
