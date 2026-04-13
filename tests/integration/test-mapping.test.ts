import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-test-mapping-'))
	mkdirSync(join(projectRoot, 'src'))
	mkdirSync(join(projectRoot, 'tests'))

	writeFileSync(
		join(projectRoot, 'src/math.ts'),
		`export function add(a: number, b: number): number {
	return a + b
}

export function multiply(a: number, b: number): number {
	return a * b
}

export function unused(): number {
	return 0
}
`,
	)

	writeFileSync(
		join(projectRoot, 'tests/math.test.ts'),
		`import { add, multiply } from '../src/math.js'

function checkAdd(): boolean {
	return add(2, 3) === 5
}

function checkMultiply(): boolean {
	return multiply(2, 3) === 6
}

checkAdd()
checkMultiply()
`,
	)

	engine = new AtlasEngine(projectRoot)
	await engine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false, withCoChange: false })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('test-mapping ingestion', () => {
	test('discovery flags test files via testPatterns', () => {
		const status = engine.status()
		expect(status.stats.files).toBe(2)
	})

	test('test_links has both imported and called rows for the test file', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ confidence: string; count: number }>(
			`SELECT confidence, COUNT(*) as count FROM test_links GROUP BY confidence`,
		)
		const counts = Object.fromEntries(rows.map((r) => [r.confidence, r.count]))
		expect(counts.imported ?? 0).toBeGreaterThan(0)
		expect(counts.called ?? 0).toBeGreaterThan(0)
	})

	test('called rows upgrade imported rows on PK collision', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ stableId: string; confidence: string }>(
			`SELECT source_symbol_stable_id as stableId, confidence FROM test_links`,
		)
		const seen = new Map<string, string>()
		for (const r of rows) seen.set(r.stableId, r.confidence)
		// each (testFile, sourceSymbol) pair appears at most once because of
		// the composite primary key
		expect(rows.length).toBe(seen.size)
	})

	test('engine.testCoverage returns coveredBy=called for tested symbol', () => {
		const result = engine.testCoverage('add')
		expect(result).not.toBeNull()
		expect(result?.coveredBy).toBe('called')
		expect(result?.tests.some((t) => t.testFilePath.endsWith('math.test.ts'))).toBe(true)
	})

	test('engine.untestedSymbols excludes covered symbols', () => {
		const result = engine.untestedSymbols()
		const names = result.map((s) => s.name)
		expect(names).toContain('unused')
		expect(names).not.toContain('add')
		expect(names).not.toContain('multiply')
	})

	test('dead-code excludes symbols referenced from test files', () => {
		const result = engine.deadCode()
		const names = result.symbols.map((s) => s.name)
		// `unused` is exported (not eligible for dead-code which only finds
		// unexported symbols). the helper functions `checkAdd`/`checkMultiply`
		// in the test file would normally appear, but are now suppressed
		// because the test file itself is filtered by is_test = 0.
		expect(names).not.toContain('checkAdd')
		expect(names).not.toContain('checkMultiply')
	})

	test('search default-hides test-file symbols', () => {
		const result = engine.search('checkAdd')
		expect(result.results).toHaveLength(0)
		const withTests = engine.search('checkAdd', { includeTests: true })
		expect(withTests.results.length).toBeGreaterThan(0)
	})
})
