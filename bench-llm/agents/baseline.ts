// baseline agent: grep/read/glob, no atlas. phase 1 stub that runs a
// deterministic regex over the corpus and returns whatever names match.
// phase 2 replaces with a real llm-driven agent using the anthropic
// sdk. see #84.

import type { AgentAnswer, Question } from '../run.js'

export async function runBaselineAgent(q: Question, corpusRoot: string): Promise<AgentAnswer> {
	// phase 1: no llm. derive a cheap "grep-like" symbol set so the
	// scoring pipeline is exercised end-to-end. callers should read this
	// as a deterministic placeholder, not a meaningful measurement.
	const { spawnSync } = await import('node:child_process')
	// extract a first-pass target name from the question. biased toward
	// the phrase "function X" or "symbol X" or an explicit identifier in
	// the question text. falls back to empty.
	const target = extractTarget(q.question)
	if (!target) return { symbols: [], toolCalls: 0 }
	const result = spawnSync(
		'grep',
		['-rnE', `\\b${target}\\b`, '--include=*.ts', '--include=*.go', '--include=*.py', corpusRoot],
		{ encoding: 'utf-8' },
	)
	const matches = (result.stdout ?? '').split('\n').filter(Boolean)
	// return a small set of distinct file:target pairs as symbols. this
	// is intentionally naive; real agents will call checker.findSymbol
	// or atlas_resolve_symbol and return precise stable ids.
	const symbols = Array.from(
		new Set(
			matches
				.map((line) => line.split(':')[0])
				.filter((f) => f.includes(corpusRoot))
				.map((f) => `${f.slice(corpusRoot.length + 1)}::${target}`),
		),
	).slice(0, 20)
	return { symbols, toolCalls: 1 }
}

function extractTarget(question: string): string | null {
	const patterns = [/\bfunction\s+(\w+)/, /\bsymbol\s+(\w+)/, /`(\w+)`/, /\b([A-Z][A-Za-z0-9]{3,})\b/]
	for (const p of patterns) {
		const m = question.match(p)
		if (m) return m[1]
	}
	return null
}
