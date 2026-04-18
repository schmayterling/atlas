import { describe, expect, test } from 'bun:test'
import '../helpers/setup.js'
import { getFixtureEngine } from '../helpers/fixture-engine.js'

// the rg subprocess path is exercised by integration dogfood; these unit
// tests cover the shape + boundary contract the LLM agents see in the bench
// harness (empty query, warning propagation, fileCount/matchCount math).

describe('engine.searchContent', () => {
	test('empty query returns warning without invoking rg', async () => {
		const engine = await getFixtureEngine()
		const r = engine.searchContent('')
		expect(r.matches).toEqual([])
		expect(r.fileCount).toBe(0)
		expect(r.matchCount).toBe(0)
		expect(r.warning).toBe('empty query')
	})

	test('finds fixture content with a known identifier', async () => {
		const engine = await getFixtureEngine()
		// the tiny-project fixture includes a handful of .ts files. any
		// identifier common enough to appear at least once will do, and
		// "export" appears in nearly every module.
		const r = engine.searchContent('export')
		// either rg returned hits, or it's not installed on this machine
		// (graceful degradation path). both are valid; we're checking the
		// shape contract, not the exact count.
		expect(['number', 'undefined']).toContain(typeof r.warning)
		if (!r.warning) {
			expect(r.matchCount).toBeGreaterThan(0)
			expect(r.fileCount).toBeGreaterThan(0)
			for (const m of r.matches) {
				expect(typeof m.file).toBe('string')
				expect(m.line).toBeGreaterThan(0)
				expect(typeof m.text).toBe('string')
			}
		}
	})

	test('pathPrefix with no matching files short-circuits before rg', async () => {
		const engine = await getFixtureEngine()
		const narrow = engine.searchContent('return', { pathPrefix: 'nonexistent-prefix/' })
		expect(narrow.warning).toBe('no indexed files match filters')
		expect(narrow.matchCount).toBe(0)
	})

	test('respects maxMatches cap when rg is available', async () => {
		const engine = await getFixtureEngine()
		const r = engine.searchContent('const', { maxMatches: 2 })
		if (!r.warning) {
			expect(r.matches.length).toBeLessThanOrEqual(2)
		}
	})
})
