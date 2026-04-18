// smoke test for bench-eval. validates that:
// - the corpus loader can resolve a manifest
// - the judge scores against typed expecteds
// - the atlas agent dispatches without throwing
// - the text-search agent skips correctly when not flagged comparable
//
// does NOT clone external repos (network-dependent, slow). uses the
// tiny-project fixture as a stand-in for a "corpus".

import { describe, expect, test } from 'bun:test'
import { judge, type Expected } from '../../bench-eval/lib/judge.js'
import { runAtlasAgent } from '../../bench-eval/agents/atlas.js'
import { runTextSearchAgent, type Task } from '../../bench-eval/agents/text-search.js'
import { getFixtureEngine } from '../helpers/fixture-engine.js'

describe('bench-eval/lib/judge', () => {
	test('symbol-set F1 on exact match', () => {
		const exp: Expected = { type: 'symbol-set', symbols: ['a::b', 'c::d'] }
		expect(judge(exp, { symbols: ['a::b', 'c::d'] })).toBe(1)
	})

	test('symbol-set F1 on partial', () => {
		const exp: Expected = { type: 'symbol-set', symbols: ['a::b', 'c::d'] }
		const score = judge(exp, { symbols: ['a::b'] })
		// precision 1, recall 0.5, F1 = 2/3
		expect(score).toBeCloseTo(2 / 3, 2)
	})

	test('count within tolerance', () => {
		const exp: Expected = { type: 'count', value: 100, tolerance: 5 }
		expect(judge(exp, { count: 98 })).toBe(1)
		expect(judge(exp, { count: 110 })).toBe(0)
		expect(judge(exp, { count: 107 })).toBeCloseTo(0.6, 1)
	})

	test('file-path set match', () => {
		const exp: Expected = { type: 'file-path', paths: ['a.rs', 'b.rs'] }
		expect(judge(exp, { files: ['a.rs', 'b.rs'] })).toBe(1)
		expect(judge(exp, { files: ['a.rs'] })).toBeCloseTo(2 / 3, 2)
	})

	test('structural min-results counts qualifiedName occurrences', () => {
		const exp: Expected = { type: 'structural', predicates: [{ kind: 'min-results', n: 2 }] }
		expect(judge(exp, { raw: { results: [{ qualifiedName: 'a' }, { qualifiedName: 'b' }] } })).toBe(1)
		expect(judge(exp, { raw: { results: [{ qualifiedName: 'a' }] } })).toBe(0)
	})

	test('structural min-array uses raw array length', () => {
		const exp: Expected = { type: 'structural', predicates: [{ kind: 'min-array', n: 3 }] }
		expect(judge(exp, { raw: [1, 2, 3, 4] })).toBe(1)
		expect(judge(exp, { raw: [1, 2] })).toBe(0)
		// also verifies it doesn't false-pass on non-arrays
		expect(judge(exp, { raw: { results: [1, 2, 3] } })).toBe(0)
	})

	test('skipped answer always scores 0', () => {
		const exp: Expected = { type: 'symbol-set', symbols: ['a'] }
		expect(judge(exp, { skipped: true, symbols: ['a'] })).toBe(0)
	})
})

describe('bench-eval/agents/atlas dispatcher', () => {
	test('files dispatches and returns count', async () => {
		const engine = await getFixtureEngine()
		const task: Task = {
			id: 't', capability: 'indexing', atlas_method: 'files',
			atlas_args: { includeTests: true },
			expected: { type: 'count', value: 6, tolerance: 1 },
			comparable_to_text_search: false,
		}
		const ans = await runAtlasAgent(task, engine)
		expect(ans.count).toBeGreaterThan(0)
		expect(judge(task.expected as Expected, ans)).toBe(1)
	})

	test('search dispatches and returns symbols', async () => {
		const engine = await getFixtureEngine()
		const task: Task = {
			id: 't', capability: 'discovery', atlas_method: 'search',
			atlas_args: { q: 'AuthService', limit: 5 },
			expected: { type: 'symbol-set', symbols: ['auth.ts::AuthService'] },
			comparable_to_text_search: false,
		}
		const ans = await runAtlasAgent(task, engine)
		expect(ans.symbols ?? []).toContain('auth.ts::AuthService')
	})

	test('unknown atlas_method returns error', async () => {
		const engine = await getFixtureEngine()
		const task: Task = {
			id: 't', capability: 'indexing', atlas_method: 'nonexistent' as any,
			expected: { type: 'count', value: 0 },
			comparable_to_text_search: false,
		}
		const ans = await runAtlasAgent(task, engine)
		expect(ans.error).toBeDefined()
	})
})

describe('bench-eval/agents/text-search', () => {
	test('skips when task is not comparable', () => {
		const task: Task = {
			id: 't', capability: 'graph-querying', atlas_method: 'blast',
			expected: { type: 'count', value: 0 },
			comparable_to_text_search: false,
		}
		const ans = runTextSearchAgent(task, '/tmp')
		expect(ans.skipped).toBe(true)
	})
})
