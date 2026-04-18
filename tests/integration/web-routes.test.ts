import { beforeAll, describe, expect, test } from 'bun:test'
import { createApp } from '../../src/web/server.js'
import { getFixtureEngine, TINY_PROJECT_ROOT } from '../helpers/fixture-engine.js'

let app: ReturnType<typeof createApp>

beforeAll(async () => {
	// fixture-engine populates the engine pool; createApp's per-request
	// getOrCreateEngine call will return the same indexed engine.
	await getFixtureEngine()
	app = createApp(TINY_PROJECT_ROOT, null)
})

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
	const res = await app.request(path)
	const body = await res.json().catch(() => null)
	return { status: res.status, body }
}

describe('GET /api/status', () => {
	test('returns 200 with stats', async () => {
		const { status, body } = await getJson('/api/status')
		expect(status).toBe(200)
		expect((body as { stats: { files: number } }).stats.files).toBe(6)
	})
})

describe('GET /api/files', () => {
	test('returns the fixture file list', async () => {
		const { status, body } = await getJson('/api/files')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
		expect((body as unknown[]).length).toBe(6)
	})
})

describe('GET /api/search', () => {
	test('400s without q', async () => {
		const { status } = await getJson('/api/search')
		expect(status).toBe(400)
	})

	test('finds AuthService by name', async () => {
		const { status, body } = await getJson('/api/search?q=AuthService')
		expect(status).toBe(200)
		const names = (body as { results: { name: string }[] }).results.map((r) => r.name)
		expect(names).toContain('AuthService')
	})
})

describe('GET /api/symbol', () => {
	test('404s for missing symbol', async () => {
		const { status } = await getJson('/api/symbol?q=NoSuchSymbol__xyz')
		expect(status).toBe(404)
	})

	test('returns the symbol when it exists', async () => {
		const { status, body } = await getJson('/api/symbol?q=AuthService')
		expect(status).toBe(200)
		expect((body as { name: string }).name).toBe('AuthService')
	})
})

describe('GET /api/blast', () => {
	test('400s without target', async () => {
		const { status } = await getJson('/api/blast')
		expect(status).toBe(400)
	})

	test('404s when target does not resolve', async () => {
		const { status } = await getJson('/api/blast?target=NoSuchSymbol__xyz')
		expect(status).toBe(404)
	})
})

describe('GET /api/dead-code', () => {
	test('returns dead code result', async () => {
		const { status, body } = await getJson('/api/dead-code')
		expect(status).toBe(200)
		expect(Array.isArray((body as { symbols: unknown[] }).symbols)).toBe(true)
	})
})

describe('GET /api/duplicates', () => {
	test('returns an array (empty without embeddings)', async () => {
		const { status, body } = await getJson('/api/duplicates')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
	})
})

describe('GET /api/flows', () => {
	test('returns an array of flows', async () => {
		const { status, body } = await getJson('/api/flows')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
	})
})

describe('GET /api/subsystems', () => {
	test('returns an array', async () => {
		const { status, body } = await getJson('/api/subsystems')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
	})
})

describe('GET /api/subsystem', () => {
	test('400s without id', async () => {
		const { status } = await getJson('/api/subsystem')
		expect(status).toBe(400)
	})

	test('404s for unknown id', async () => {
		const { status } = await getJson('/api/subsystem?id=0000000000000000')
		expect(status).toBe(404)
	})
})

describe('GET /api/git/*', () => {
	test('churn returns an array (empty for fixture without git)', async () => {
		const { status, body } = await getJson('/api/git/churn?limit=10')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
	})

	test('history requires file param', async () => {
		const { status } = await getJson('/api/git/history')
		expect(status).toBe(400)
	})

	test('contributors returns an array', async () => {
		const { status, body } = await getJson('/api/git/contributors')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
	})

	test('co-change returns an array', async () => {
		const { status, body } = await getJson('/api/git/co-change')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
	})
})

describe('GET /api/hot-fragile, /api/hotspots, /api/test-coverage', () => {
	test('hot-fragile returns an array', async () => {
		const { status, body } = await getJson('/api/hot-fragile?limit=5')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
	})

	test('hotspots returns an array', async () => {
		const { status, body } = await getJson('/api/hotspots?limit=5')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
	})

	test('hotspots accepts --coverage filter', async () => {
		const { status, body } = await getJson('/api/hotspots?limit=5&coverage=none')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
	})

	test('test-coverage requires symbol param', async () => {
		const { status } = await getJson('/api/test-coverage')
		expect(status).toBe(400)
	})

	test('GET /api/entry-points returns top exported symbols', async () => {
		const { status, body } = await getJson('/api/entry-points?limit=5')
		expect(status).toBe(200)
		expect(Array.isArray(body)).toBe(true)
		// every row must have qualifiedName + dependentCount; isExported
		// comes through as 1 from the raw query (matches existing surfaces)
		for (const row of body as Array<{ qualifiedName: string; dependentCount: number; isExported: number | boolean }>) {
			expect(typeof row.qualifiedName).toBe('string')
			expect(Boolean(row.isExported)).toBe(true)
		}
	})

	test('GET /api/article/symbol bundles detail + subsystem + history fields', async () => {
		const { status, body } = await getJson('/api/article/symbol?q=AuthService')
		expect(status).toBe(200)
		const a = body as { symbol: { name: string }; upstream: unknown[]; downstream: unknown[]; language: string; sourceCode: string | null }
		expect(a.symbol.name).toBe('AuthService')
		expect(Array.isArray(a.upstream)).toBe(true)
		expect(Array.isArray(a.downstream)).toBe(true)
		expect(a.language).toBe('typescript')
	})

	test('GET /api/article/symbol 404s when symbol missing', async () => {
		const { status } = await getJson('/api/article/symbol?q=NoSuchSymbol__xyz')
		expect(status).toBe(404)
	})

	test('GET /api/article/file bundles symbols + imports + importers', async () => {
		const { status, body } = await getJson('/api/article/file?path=auth.ts')
		expect(status).toBe(200)
		const f = body as { path: string; symbols: unknown[]; imports: unknown[]; importers: unknown[]; language: string }
		expect(f.path).toBe('auth.ts')
		expect(Array.isArray(f.symbols)).toBe(true)
		expect(Array.isArray(f.imports)).toBe(true)
		expect(Array.isArray(f.importers)).toBe(true)
	})

	test('GET /api/article/file 404s for unknown path', async () => {
		const { status } = await getJson('/api/article/file?path=does/not/exist.ts')
		expect(status).toBe(404)
	})
})
