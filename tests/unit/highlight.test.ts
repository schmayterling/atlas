import { describe, expect, test } from 'bun:test'
import { highlight, clearHighlightCache } from '../../src/web/highlight.js'

describe('highlight', () => {
	test('renders typescript with shiki dual-theme markup', async () => {
		const html = await highlight('const x: number = 1', 'ts')
		expect(html).toContain('<pre')
		expect(html).toContain('<code')
		expect(html).toContain('--shiki-dark')
		expect(html).toContain('const')
	})

	test('python is supported', async () => {
		const html = await highlight('def foo():\n    return 1', 'py')
		expect(html).toContain('<pre')
		expect(html).toContain('def')
	})

	test('caches by lang+code', async () => {
		clearHighlightCache()
		const a = await highlight('const a = 1', 'ts')
		const b = await highlight('const a = 1', 'ts')
		expect(a).toBe(b)
	})

	test('escapes html in source', async () => {
		const html = await highlight('const x = "<script>alert(1)</script>"', 'ts')
		expect(html).not.toContain('<script>alert(1)</script>')
		expect(html).toContain('&#x3C;script>')
	})

	test('unknown language falls back to typescript', async () => {
		const html = await highlight('const a = 1', 'unknown-lang')
		expect(html).toContain('<pre')
	})
})
