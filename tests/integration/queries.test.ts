import { describe, expect, test } from 'bun:test'
import { getFixtureEngine } from '../helpers/fixture-engine.js'

describe('search', () => {
	test('finds a class by name', async () => {
		const engine = await getFixtureEngine()
		const result = engine.search('AuthService')
		const names = result.results.map((s) => s.name)
		expect(names).toContain('AuthService')
	})

	test('filters by kind', async () => {
		const engine = await getFixtureEngine()
		const result = engine.search('Database', { kind: 'class' })
		expect(result.results.every((s) => s.kind === 'class')).toBe(true)
	})

	test('returns empty for unknown name', async () => {
		const engine = await getFixtureEngine()
		const result = engine.search('SymbolThatDoesNotExist__xyz')
		expect(result.results).toEqual([])
	})

	test('honours the limit option', async () => {
		const engine = await getFixtureEngine()
		const result = engine.search('a', { limit: 3 })
		expect(result.results.length).toBeLessThanOrEqual(3)
	})
})

describe('deps', () => {
	test('returns null for unknown symbol', async () => {
		const engine = await getFixtureEngine()
		expect(engine.deps('NoSuchSymbol__xyz')).toBeNull()
	})

	test('finds downstream call from loginRoute → AuthService.login', async () => {
		const engine = await getFixtureEngine()
		const result = engine.deps('loginRoute', { direction: 'downstream' })
		expect(result).not.toBeNull()
		const downstream = result!.downstream.map((d) => d.symbol.name)
		expect(downstream.length).toBeGreaterThan(0)
	})
})

describe('blast', () => {
	test('returns null for unknown target', async () => {
		const engine = await getFixtureEngine()
		expect(engine.blast('NoSuchSymbol__xyz')).toBeNull()
	})

	test('reports a non-zero radius for a function with callers', async () => {
		const engine = await getFixtureEngine()
		const result = engine.blast('login')
		expect(result).not.toBeNull()
	})
})

describe('trace', () => {
	test('returns null when either endpoint is missing', async () => {
		const engine = await getFixtureEngine()
		expect(engine.trace('loginRoute', 'NoSuchSymbol__xyz')).toBeNull()
		expect(engine.trace('NoSuchSymbol__xyz', 'login')).toBeNull()
	})
})

describe('deadCode', () => {
	// dead-code uses recursive reachability from exported roots (#41):
	// a non-exported helper that nothing imports or calls is dead.
	// mutually-recursive unreachable functions are also flagged,
	// because each has the other's inbound edge but neither is
	// reachable from any root — the old NOT IN check missed this.
	test('finds non-exported symbols not reachable from any root', async () => {
		const engine = await getFixtureEngine()
		const result = engine.deadCode()
		expect(result.symbols.length).toBeGreaterThan(0)
		const deadNames = result.symbols.map((s) => s.name)
		expect(deadNames).toContain('deadA')
		expect(deadNames).toContain('deadB')
	})

	test('returns stats with byKind and byFile', async () => {
		const engine = await getFixtureEngine()
		const result = engine.deadCode()
		expect(result.stats.total).toBe(result.symbols.length)
		expect(typeof result.stats.byKind).toBe('object')
		expect(typeof result.stats.byFile).toBe('object')
	})
})

describe('files', () => {
	test('returns one entry per fixture file', async () => {
		const engine = await getFixtureEngine()
		const files = engine.files()
		expect(files.length).toBe(6)
	})

	test('fileSymbols returns symbols for a known file', async () => {
		const engine = await getFixtureEngine()
		const syms = engine.fileSymbols('auth.ts')
		const names = syms.map((s) => s.name)
		expect(names).toContain('AuthService')
		expect(names).toContain('User')
	})
})

describe('resolveSymbol', () => {
	test('finds a symbol by short name', async () => {
		const engine = await getFixtureEngine()
		const sym = engine.resolveSymbol('AuthService')
		expect(sym).not.toBeNull()
		expect(sym!.name).toBe('AuthService')
	})

	test('returns null for missing symbol', async () => {
		const engine = await getFixtureEngine()
		expect(engine.resolveSymbol('NoSuchSymbol__xyz')).toBeNull()
	})
})
