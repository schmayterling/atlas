// typed scorers for bench-eval. distinct from bench-llm/judge.ts which
// is the LLM-eval judge. four scorer types cover the deterministic
// capability tasks: symbol-set (F1), count (numeric ± tolerance),
// file-path (set match), structural (predicate over JSON shape).
//
// every scorer returns a number in [0, 1].

export type Expected =
	| { type: 'symbol-set'; symbols: string[] }
	| { type: 'count'; value: number; tolerance?: number }
	| { type: 'file-path'; paths: string[] }
	| { type: 'structural'; predicates: StructuralPredicate[] }

export type StructuralPredicate =
	| { kind: 'has-symbol'; qualifiedName: string }
	| { kind: 'min-depth'; n: number }
	| { kind: 'min-results'; n: number }
	| { kind: 'min-array'; n: number }
	| { kind: 'contains-file'; path: string }

export interface AgentAnswer {
	symbols?: string[]
	files?: string[]
	count?: number
	raw?: unknown
	skipped?: boolean
	error?: string
}

export function judge(expected: Expected, answer: AgentAnswer | null | undefined): number {
	if (!answer || answer.skipped || answer.error) return 0
	switch (expected.type) {
		case 'symbol-set': return scoreSymbolSet(expected.symbols, answer.symbols ?? [])
		case 'count':      return scoreCount(expected.value, expected.tolerance ?? 0, answer.count ?? 0)
		case 'file-path':  return scoreFilePath(expected.paths, answer.files ?? [])
		case 'structural': return scoreStructural(expected.predicates, answer.raw)
	}
}

// F1 over identifier sets. perfect on exact match, smoothly degrades for
// recall/precision misses.
function scoreSymbolSet(expected: string[], predicted: string[]): number {
	if (expected.length === 0) return predicted.length === 0 ? 1 : 0
	const exp = new Set(expected.map(normalize))
	const pred = new Set(predicted.map(normalize))
	let tp = 0
	for (const s of pred) if (exp.has(s)) tp++
	const precision = pred.size === 0 ? 0 : tp / pred.size
	const recall = exp.size === 0 ? 0 : tp / exp.size
	if (precision + recall === 0) return 0
	return (2 * precision * recall) / (precision + recall)
}

// numeric within tolerance: 1.0 if |actual - expected| <= tolerance,
// linearly degrades to 0 over the next tolerance unit, else 0.
function scoreCount(expected: number, tolerance: number, actual: number): number {
	const delta = Math.abs(actual - expected)
	if (delta <= tolerance) return 1
	if (delta <= tolerance * 2) return 1 - (delta - tolerance) / tolerance
	return 0
}

// file-path: same F1 shape as symbol-set, after normalizing leading slashes
// and trailing whitespace.
function scoreFilePath(expected: string[], predicted: string[]): number {
	const norm = (s: string) => s.replace(/^\/+/, '').trim()
	return scoreSymbolSet(expected.map(norm), predicted.map(norm))
}

// structural: every predicate must hold. each is a small JSON shape check
// over the raw agent response. score is 1.0 iff all hold, else 0.
function scoreStructural(predicates: StructuralPredicate[], raw: unknown): number {
	if (raw === null || raw === undefined) return 0
	for (const p of predicates) {
		if (!evalPredicate(p, raw)) return 0
	}
	return 1
}

function evalPredicate(p: StructuralPredicate, raw: unknown): boolean {
	const text = JSON.stringify(raw)
	switch (p.kind) {
		case 'has-symbol':    return text.includes(`"${p.qualifiedName}"`)
		case 'contains-file': return text.includes(`"${p.path}"`)
		case 'min-depth': {
			const matches = text.match(/"depth":\s*(\d+)/g) ?? []
			const max = matches.reduce((m, s) => Math.max(m, Number(s.split(':')[1])), 0)
			return max >= p.n
		}
		case 'min-results':   return countOccurrences(text, '"qualifiedName"') >= p.n
		case 'min-array':     return Array.isArray(raw) && raw.length >= p.n
	}
}

function countOccurrences(haystack: string, needle: string): number {
	let n = 0, i = 0
	while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length }
	return n
}

function normalize(id: string): string {
	return id.trim().replace(/\s+/g, '')
}
