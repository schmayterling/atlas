#!/usr/bin/env bun
// bench-llm phase 1 runner. iterates every question json, runs each
// configured agent against it, scores the answer, and reports a table
// of per-question + aggregate scores. no llm calls in phase 1; the
// agents are local stubs. see #84.

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runBaselineAgent } from './agents/baseline.js'
import { runWithAtlasAgent } from './agents/with-atlas.js'
import { judge, type Expected } from './judge.js'

export type Capability =
	| 'symbol-locate'
	| 'symbol-set'
	| 'dependency-trace'
	| 'impact-analysis'
	| 'cross-language'
	| 'test-coverage'
	| 'architecture'

export interface Question {
	id: string
	corpus: string
	ref: string
	capability: Capability
	question: string
	expected: Expected
	rubric_notes?: string
	budget?: { toolCalls?: number; tokens?: number }
}

export interface AgentAnswer {
	symbols?: string[]
	text?: string
	toolCalls?: number
}

export type AgentFn = (q: Question, corpusRoot: string) => Promise<AgentAnswer>

interface CliOptions {
	agent: 'baseline' | 'with-atlas' | 'all'
	question: string | null
	corpus: string
}

function parseCli(argv: string[]): CliOptions {
	const opts: CliOptions = { agent: 'all', question: null, corpus: 'atlas-pinned' }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--agent') opts.agent = argv[++i] as CliOptions['agent']
		else if (a === '--question') opts.question = argv[++i]
		else if (a === '--corpus') opts.corpus = argv[++i]
	}
	return opts
}

function loadQuestions(dir: string, filter: string | null): Question[] {
	const entries = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
	const qs: Question[] = []
	for (const entry of entries) {
		const raw = readFileSync(resolve(dir, entry), 'utf-8')
		const q = JSON.parse(raw) as Question
		if (filter && q.id !== filter) continue
		qs.push(q)
	}
	return qs
}

function resolveCorpusRoot(corpus: string): string {
	// phase 1: atlas-pinned resolves to the repo root. phase 2 will
	// clone/checkout pinned refs into a cache dir.
	if (corpus !== 'atlas-pinned') {
		throw new Error(`unknown corpus: ${corpus}. phase 1 only supports atlas-pinned.`)
	}
	return resolve(import.meta.dir, '..')
}

async function runAgent(name: string, fn: AgentFn, q: Question, corpusRoot: string) {
	const start = Date.now()
	const answer = await fn(q, corpusRoot)
	const score = judge(q.expected, answer)
	return { name, score, elapsed: Date.now() - start, toolCalls: answer.toolCalls ?? 0 }
}

async function main() {
	const opts = parseCli(process.argv.slice(2))
	const questionsDir = resolve(import.meta.dir, 'questions')
	const corpusRoot = resolveCorpusRoot(opts.corpus)
	const questions = loadQuestions(questionsDir, opts.question)
	if (questions.length === 0) {
		console.error(`no questions found (filter=${opts.question ?? '<all>'})`)
		process.exit(1)
	}

	const agents: Array<{ name: 'baseline' | 'with-atlas'; fn: AgentFn }> = []
	if (opts.agent === 'baseline' || opts.agent === 'all') {
		agents.push({ name: 'baseline', fn: runBaselineAgent })
	}
	if (opts.agent === 'with-atlas' || opts.agent === 'all') {
		agents.push({ name: 'with-atlas', fn: runWithAtlasAgent })
	}

	const totals: Record<string, { sum: number; n: number }> = {}
	for (const a of agents) totals[a.name] = { sum: 0, n: 0 }

	console.log(`bench-llm phase 1: corpus=${opts.corpus} questions=${questions.length}`)
	console.log('')
	for (const q of questions) {
		console.log(`[${q.id}] ${q.capability}  ${q.question.slice(0, 80)}${q.question.length > 80 ? '…' : ''}`)
		for (const a of agents) {
			const r = await runAgent(a.name, a.fn, q, corpusRoot)
			totals[a.name].sum += r.score
			totals[a.name].n += 1
			console.log(`  ${a.name.padEnd(11)}  score=${r.score.toFixed(2)}  tools=${r.toolCalls}  ${r.elapsed}ms`)
		}
	}
	console.log('')
	console.log('aggregate:')
	for (const a of agents) {
		const t = totals[a.name]
		const mean = t.n > 0 ? t.sum / t.n : 0
		console.log(`  ${a.name.padEnd(11)}  mean=${mean.toFixed(2)}  (n=${t.n})`)
	}
	if (agents.length === 2) {
		const baseline = totals.baseline
		const withAtlas = totals['with-atlas']
		const delta =
			(withAtlas.sum / withAtlas.n) - (baseline.sum / baseline.n)
		console.log(`  delta (with-atlas − baseline) = ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`)
	}
}

if (import.meta.main) {
	await main()
}
