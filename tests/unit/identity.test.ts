import { describe, expect, test } from 'bun:test'
import '../helpers/setup.js'
import { contentHash, stableSymbolId } from '../../src/shared/identity.js'

describe('stableSymbolId', () => {
	test('produces a 32-char hex string', () => {
		const id = stableSymbolId('src/foo.ts', 'function', 'src/foo.ts::bar')
		expect(id).toMatch(/^[0-9a-f]{32}$/)
	})

	test('is deterministic across calls', () => {
		const a = stableSymbolId('src/foo.ts', 'function', 'src/foo.ts::bar')
		const b = stableSymbolId('src/foo.ts', 'function', 'src/foo.ts::bar')
		expect(a).toBe(b)
	})

	test('differs when path differs', () => {
		const a = stableSymbolId('src/foo.ts', 'function', '::bar')
		const b = stableSymbolId('src/baz.ts', 'function', '::bar')
		expect(a).not.toBe(b)
	})

	test('differs when kind differs', () => {
		const a = stableSymbolId('src/foo.ts', 'function', '::bar')
		const b = stableSymbolId('src/foo.ts', 'method', '::bar')
		expect(a).not.toBe(b)
	})

	test('differs when qualifiedName differs', () => {
		const a = stableSymbolId('src/foo.ts', 'function', '::bar')
		const b = stableSymbolId('src/foo.ts', 'function', '::baz')
		expect(a).not.toBe(b)
	})

	test('no collisions across a small realistic corpus', () => {
		const inputs: [string, 'function' | 'method' | 'class', string][] = [
			['src/a.ts', 'function', 'src/a.ts::foo'],
			['src/a.ts', 'function', 'src/a.ts::bar'],
			['src/a.ts', 'class', 'src/a.ts::Foo'],
			['src/a.ts', 'method', 'src/a.ts::Foo.bar'],
			['src/b.ts', 'function', 'src/b.ts::foo'],
			['src/b.ts', 'method', 'src/b.ts::Foo.bar'],
		]
		const ids = new Set(inputs.map((i) => stableSymbolId(...i)))
		expect(ids.size).toBe(inputs.length)
	})
})

describe('contentHash', () => {
	test('produces a 64-char hex string', () => {
		expect(contentHash('hello')).toMatch(/^[0-9a-f]{64}$/)
	})

	test('is deterministic', () => {
		expect(contentHash('hello world')).toBe(contentHash('hello world'))
	})

	test('differs when content differs by one byte', () => {
		expect(contentHash('hello')).not.toBe(contentHash('hellp'))
	})
})
