// deterministic scorers for bench-llm phase 1. phase 2 plugs an llm
// judge in for open-ended questions; the symbol-set path stays exact.
// see #84.

import type { AgentAnswer } from './run.js'

export type Expected =
	| { type: 'symbol-set'; symbols: string[]; locations?: string[] }
	| { type: 'open-ended'; mustInclude: string[] }

export function judge(expected: Expected, answer: AgentAnswer): number {
	if (expected.type === 'symbol-set') {
		return symbolSetF1(expected.symbols, answer.symbols ?? [])
	}
	if (expected.type === 'open-ended') {
		return openEndedLocal(expected.mustInclude, answer.text ?? '')
	}
	throw new Error(`unknown expected.type: ${(expected as { type: string }).type}`)
}

// F1 over predicted vs expected identifier set. identifiers compared
// by exact string match; callers that want looser matching (e.g. ignore
// case, strip file-prefix) should normalize before judging.
export function symbolSetF1(expected: string[], predicted: string[]): number {
	if (expected.length === 0 && predicted.length === 0) return 1
	const exp = new Set(expected)
	const pred = new Set(predicted)
	let tp = 0
	for (const p of pred) if (exp.has(p)) tp++
	if (tp === 0) return 0
	const precision = tp / pred.size
	const recall = tp / exp.size
	return (2 * precision * recall) / (precision + recall)
}

// phase 1 stub: 1 when every mustInclude phrase is present in the
// text, else the fraction present. phase 2 replaces with an llm judge
// that reads the rubric_notes.
export function openEndedLocal(mustInclude: string[], text: string): number {
	if (mustInclude.length === 0) return 1
	const lower = text.toLowerCase()
	let hits = 0
	for (const phrase of mustInclude) {
		if (lower.includes(phrase.toLowerCase())) hits++
	}
	return hits / mustInclude.length
}
