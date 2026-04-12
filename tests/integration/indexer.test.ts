import { describe, expect, test } from 'bun:test'
import { getFixtureEngine } from '../helpers/fixture-engine.js'

describe('indexer + tiny-project fixture', () => {
	test('indexes the expected number of files', async () => {
		const engine = await getFixtureEngine()
		const status = engine.status()
		// 6 .ts files in tiny-project (auth, db, api, utils, unused, nested/inner)
		expect(status.stats.files).toBe(6)
	})

	test('produces non-zero symbol and edge counts', async () => {
		const engine = await getFixtureEngine()
		const status = engine.status()
		expect(status.stats.symbols).toBeGreaterThan(10)
		expect(status.stats.edges).toBeGreaterThan(5)
	})

	test('files are listed under their relative paths', async () => {
		const engine = await getFixtureEngine()
		const files = engine.files()
		const paths = files.map((f) => f.path).sort()
		expect(paths).toContain('auth.ts')
		expect(paths).toContain('db.ts')
		expect(paths).toContain('api.ts')
		expect(paths).toContain('utils.ts')
		expect(paths).toContain('unused.ts')
		expect(paths).toContain('nested/inner.ts')
	})

	test('language stats include typescript', async () => {
		const engine = await getFixtureEngine()
		const status = engine.status()
		expect(status.languages.typescript).toBeGreaterThan(0)
	})

	test('re-indexing with no changes is a no-op', async () => {
		const engine = await getFixtureEngine()
		const result = await engine.index({ noEmbed: true, noSummarize: true })
		expect(result.filesAdded).toBe(0)
		expect(result.filesModified).toBe(0)
		expect(result.filesDeleted).toBe(0)
	})
})
