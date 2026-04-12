import { describe, expect, test } from 'bun:test'
import { extractPY } from '../../helpers/parse.js'

describe('python extractor', () => {
	test('extracts a top-level function', () => {
		const result = extractPY(`def greet(name):\n    return 'hi ' + name\n`)
		const fn = result.symbols.find((s) => s.name === 'greet')
		expect(fn).toBeDefined()
		expect(fn!.kind).toBe('function')
	})

	test('extracts a class with methods', () => {
		const result = extractPY(`class Foo:\n    def bar(self):\n        return 1\n    def baz(self):\n        return 2\n`)
		const cls = result.symbols.find((s) => s.kind === 'class' && s.name === 'Foo')
		expect(cls).toBeDefined()
		const methods = result.symbols.filter((s) => s.kind === 'method').map((m) => m.name).sort()
		expect(methods).toEqual(['bar', 'baz'])
	})

	test('captures import statements', () => {
		const result = extractPY(`from .other import foo\n\ndef use():\n    return foo()\n`)
		expect(result.imports.length).toBeGreaterThan(0)
	})

	test('handles empty source', () => {
		const result = extractPY('')
		expect(result.symbols).toEqual([])
	})
})
