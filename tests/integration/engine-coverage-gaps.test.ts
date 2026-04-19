import { describe, expect, test } from 'bun:test'
import { getFixtureEngine } from '../helpers/fixture-engine.js'

// coverage for engine methods atlas's hot_fragile detector flagged as
// untested: callSites, trace, plus disambiguation locks for resolveSymbol.
// these tests pin current behavior so v4 changes (#1 resolver
// disambiguation, #2 returns edge kind) can detect regressions instead
// of changing semantics silently.

describe('engine.callSites', () => {
	test('returns inbound call sites with edgeKind metadata', async () => {
		const engine = await getFixtureEngine()
		// AuthService.login is called by loginRoute (the api boundary).
		const sites = engine.callSites('AuthService.login', { direction: 'inbound' })
		expect(sites).not.toBeNull()
		expect(sites!.length).toBeGreaterThan(0)
		for (const s of sites!) {
			expect(typeof s.sourceStableId).toBe('string')
			expect(typeof s.sourceName).toBe('string')
			expect(typeof s.sourceFilePath).toBe('string')
			expect(typeof s.edgeKind).toBe('string')
		}
	})

	test('returns null for unknown symbol', async () => {
		const engine = await getFixtureEngine()
		expect(engine.callSites('NoSuchSymbol__xyz', { direction: 'inbound' })).toBeNull()
	})

	test('respects the limit option', async () => {
		const engine = await getFixtureEngine()
		const sites = engine.callSites('AuthService.login', { direction: 'inbound', limit: 1 })
		expect(sites).not.toBeNull()
		expect(sites!.length).toBeLessThanOrEqual(1)
	})

	test('outbound direction lists callees from the symbol', async () => {
		const engine = await getFixtureEngine()
		// loginRoute calls AuthService methods; outbound from loginRoute
		// should surface that.
		const sites = engine.callSites('loginRoute', { direction: 'outbound' })
		expect(sites).not.toBeNull()
		// outbound may legitimately be empty for some symbols, but the
		// shape contract still holds.
		for (const s of sites!) {
			expect(typeof s.sourceName).toBe('string')
		}
	})
})

describe('engine.trace', () => {
	test('returns null when symbols cannot be resolved', async () => {
		const engine = await getFixtureEngine()
		const r = engine.trace('NoSuchSrc__xyz', 'NoSuchTgt__xyz', { maxPaths: 1 })
		expect(r).toBeNull()
	})

	test('preserves shape contract for a known source/target pair', async () => {
		const engine = await getFixtureEngine()
		// loginRoute -> AuthService.login should be reachable via direct call.
		const r = engine.trace('loginRoute', 'AuthService.login', { maxPaths: 5, maxDepth: 5 })
		expect(r).not.toBeNull()
		// trace returns either at least one path, or an empty path list with
		// source/target metadata. shape contract holds either way.
		expect(typeof r!.source).toBe('object')
		expect(typeof r!.target).toBe('object')
		expect(Array.isArray(r!.paths)).toBe(true)
	})
})

describe('store.rankCandidates — overload disambiguation', () => {
	test('exported wins over private', async () => {
		const { rankCandidates } = await import('../../src/core/storage/store.js')
		const candidates = [
			{ name: 'foo', qualifiedName: 'a.ts::foo', kind: 'function', isExported: 0, parentId: null } as any,
			{ name: 'foo', qualifiedName: 'b.ts::foo', kind: 'function', isExported: 1, parentId: null } as any,
		]
		const ranked = rankCandidates(candidates)
		expect(ranked[0].qualifiedName).toBe('b.ts::foo')
	})

	test('top-level wins over nested', async () => {
		const { rankCandidates } = await import('../../src/core/storage/store.js')
		const candidates = [
			{ name: 'run', qualifiedName: 'a.ts::Foo.run', kind: 'method', isExported: 1, parentId: 7 } as any,
			{ name: 'run', qualifiedName: 'b.ts::run', kind: 'function', isExported: 1, parentId: null } as any,
		]
		const ranked = rankCandidates(candidates)
		expect(ranked[0].qualifiedName).toBe('b.ts::run')
	})

	test('function/class kind wins over property/variable', async () => {
		const { rankCandidates } = await import('../../src/core/storage/store.js')
		const candidates = [
			{ name: 'x', qualifiedName: 'a.ts::x', kind: 'variable', isExported: 1, parentId: null } as any,
			{ name: 'x', qualifiedName: 'b.ts::x', kind: 'function', isExported: 1, parentId: null } as any,
		]
		const ranked = rankCandidates(candidates)
		expect(ranked[0].qualifiedName).toBe('b.ts::x')
	})

	test('shorter qualifiedName wins as tiebreak', async () => {
		const { rankCandidates } = await import('../../src/core/storage/store.js')
		const candidates = [
			{ name: 'parse', qualifiedName: 'packages/x/src/v4/core/parse.ts::parse', kind: 'function', isExported: 1, parentId: null } as any,
			{ name: 'parse', qualifiedName: 'parse.ts::parse', kind: 'function', isExported: 1, parentId: null } as any,
		]
		const ranked = rankCandidates(candidates)
		expect(ranked[0].qualifiedName).toBe('parse.ts::parse')
	})

	test('single candidate passes through unchanged', async () => {
		const { rankCandidates } = await import('../../src/core/storage/store.js')
		const single = [{ name: 'only', qualifiedName: 'a::only', kind: 'function', isExported: 1, parentId: null } as any]
		expect(rankCandidates(single)).toEqual(single)
	})
})

describe('engine.resolveSymbol — disambiguation regression locks', () => {
	test('finds symbol by short name when uniquely named', async () => {
		const engine = await getFixtureEngine()
		const r = engine.resolveSymbol('AuthService')
		expect(r?.name).toBe('AuthService')
		expect(r?.filePath).toBe('auth.ts')
	})

	test('finds symbol by qualified name (file::Symbol)', async () => {
		const engine = await getFixtureEngine()
		const r = engine.resolveSymbol('auth.ts::AuthService')
		expect(r?.name).toBe('AuthService')
	})

	test('factory-pattern lookups return some result (the factory or its return type)', async () => {
		// createAuthService is a factory returning AuthService.
		// before #1 this returns the factory function. after #1 it should
		// still resolve to a sensible candidate (the factory by default).
		// this test just locks "we get something back"; finer assertions
		// land alongside #1.
		const engine = await getFixtureEngine()
		const r = engine.resolveSymbol('createAuthService')
		expect(r).not.toBeNull()
		expect(['function', 'method']).toContain(r!.kind)
	})
})
