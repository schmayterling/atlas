// baseline agent: grep/read/glob, no atlas. phase 1 stub that runs a
// deterministic grep over the corpus and returns whatever names match.
// phase 2 replaces with a real llm-driven agent using the anthropic sdk.
// see #84.

import { spawnSync } from 'node:child_process'
import type { AgentAnswer, Question } from '../run.js'
import { extractTarget } from './shared.js'

export async function runBaselineAgent(q: Question, corpusRoot: string): Promise<AgentAnswer> {
	// phase 1: no llm. derive a cheap "grep-like" symbol set so the
	// scoring pipeline is exercised end-to-end. callers should read this
	// as a deterministic placeholder, not a meaningful measurement.
	const target = extractTarget(q.question)
	if (!target) return { symbols: [], toolCalls: 0 }
	const result = spawnSync(
		'grep',
		['-rnE', `\\b${target}\\b`, '--include=*.ts', '--include=*.go', '--include=*.py', corpusRoot],
		{ encoding: 'utf-8' },
	)
	// grep exits 0 on match, 1 on no match, >=2 on real errors. treat
	// >=2 as harness failure instead of an empty answer so a missing
	// grep binary or bad path doesn't silently degrade scores. deep-
	// review pass 4 codex flagged the silent degradation.
	if (result.status !== null && result.status >= 2) {
		throw new Error(
			`baseline: grep exited ${result.status} (${result.error?.message ?? result.stderr?.slice(0, 200) ?? 'unknown'})`,
		)
	}
	const matches = (result.stdout ?? '').split('\n').filter(Boolean)
	const symbols = Array.from(
		new Set(
			matches
				.map((line) => line.split(':')[0])
				.filter((f) => f.includes(corpusRoot))
				.map((f) => `${f.slice(corpusRoot.length + 1)}::${target}`),
		),
	).slice(0, 20)
	const text = symbols.join('\n')
	return { symbols, text, toolCalls: 1 }
}
