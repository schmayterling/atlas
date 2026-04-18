// text-search baseline. NOT a "neutral" baseline — explicitly named
// throughout because it's a lower bound on what an LLM-free grep agent
// can do. for tasks that text-search can't reasonably attempt
// (call-tracing, blast-radius), the runner skips them and they don't
// feed the comparable aggregate.
//
// strategy: shells out to ripgrep (rg) when available; falls back to
// Bun.glob + readFile for the few rg flags we use. no LLM, no tree-sitter.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { AgentAnswer } from '../lib/judge.js'

export interface Task {
	id: string
	capability: string
	atlas_method: string
	atlas_args?: Record<string, unknown>
	expected: unknown
	comparable_to_text_search: boolean
	text_search_strategy?: TextSearchStrategy
}

export type TextSearchStrategy =
	| { mode: 'rg-files-with-matches'; pattern: string; glob?: string }
	| { mode: 'rg-count'; pattern: string; glob?: string }
	| { mode: 'rg-symbols'; pattern: string; glob?: string; capture?: number }
	| { mode: 'glob'; pattern: string }

export function runTextSearchAgent(task: Task, corpusRoot: string): AgentAnswer {
	if (!task.comparable_to_text_search || !task.text_search_strategy) {
		return { skipped: true }
	}
	const s = task.text_search_strategy
	try {
		switch (s.mode) {
			case 'rg-files-with-matches': return rgFilesWithMatches(corpusRoot, s.pattern, s.glob)
			case 'rg-count':              return rgCount(corpusRoot, s.pattern, s.glob)
			case 'rg-symbols':            return rgSymbols(corpusRoot, s.pattern, s.glob, s.capture ?? 1)
			case 'glob':                  return globOnly(corpusRoot, s.pattern)
		}
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) }
	}
}

function rgFilesWithMatches(cwd: string, pattern: string, glob?: string): AgentAnswer {
	const args = ['--files-with-matches', '--no-messages']
	if (glob) args.push('--glob', glob)
	args.push(pattern)
	const r = spawnSync('rg', args, { cwd, encoding: 'utf-8' })
	if (r.status !== 0 && r.status !== 1) return { error: `rg exit ${r.status}: ${r.stderr ?? ''}` }
	const files = (r.stdout ?? '').split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, ''))
	return { files }
}

function rgCount(cwd: string, pattern: string, glob?: string): AgentAnswer {
	const args = ['--count-matches', '--no-messages']
	if (glob) args.push('--glob', glob)
	args.push(pattern)
	const r = spawnSync('rg', args, { cwd, encoding: 'utf-8' })
	if (r.status !== 0 && r.status !== 1) return { error: `rg exit ${r.status}` }
	const total = (r.stdout ?? '').split('\n').filter(Boolean).reduce((sum, line) => {
		const n = Number(line.split(':').pop())
		return Number.isFinite(n) ? sum + n : sum
	}, 0)
	return { count: total }
}

// extract a captured group from each matching line. used for "find symbol
// names matching pattern X" — the capture group pulls out just the name.
function rgSymbols(cwd: string, pattern: string, glob: string | undefined, capture: number): AgentAnswer {
	const args = ['--no-heading', '--with-filename', '--no-line-number', '--no-messages']
	if (glob) args.push('--glob', glob)
	args.push('-o', '-r', `$${capture}`, pattern)
	const r = spawnSync('rg', args, { cwd, encoding: 'utf-8' })
	if (r.status !== 0 && r.status !== 1) return { error: `rg exit ${r.status}` }
	const lines = (r.stdout ?? '').split('\n').filter(Boolean)
	const symbols = lines.map((line) => {
		const idx = line.indexOf(':')
		const file = idx > 0 ? line.slice(0, idx).replace(/^\.\//, '') : ''
		const name = idx > 0 ? line.slice(idx + 1) : line
		return file ? `${file}::${name}` : name
	})
	return { symbols: dedupe(symbols) }
}

function globOnly(cwd: string, pattern: string): AgentAnswer {
	const glob = new Bun.Glob(pattern)
	const files: string[] = []
	for (const f of glob.scanSync({ cwd })) files.push(f)
	return { files }
}

function dedupe<T>(xs: T[]): T[] {
	return [...new Set(xs)]
}

export function isTextSearchAvailable(): boolean {
	const r = spawnSync('rg', ['--version'], { stdio: 'ignore' })
	return r.status === 0
}

void join // tree-shake guard
