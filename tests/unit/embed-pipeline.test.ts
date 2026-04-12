import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEmbedText } from '../../src/core/embeddings/embed-pipeline.js'

function withTempFile(content: string, fn: (root: string, relPath: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), 'atlas-embed-'))
	try {
		mkdirSync(join(root, 'src'), { recursive: true })
		const relPath = 'src/foo.ts'
		writeFileSync(join(root, relPath), content)
		fn(root, relPath)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

describe('buildEmbedText', () => {
	test('includes kind, name, file name, signature, doc and source body', () => {
		const source = `function greet() { return "hello world" }`
		withTempFile(source, (root, relPath) => {
			const text = buildEmbedText(
				{
					kind: 'function',
					name: 'greet',
					qualifiedName: 'src/foo.ts::greet',
					filePath: relPath,
					signature: '() => string',
					docComment: 'says hi',
					byteStart: 0,
					byteEnd: source.length,
				},
				root,
				new Map(),
			)
			expect(text).toContain('function greet')
			expect(text).toContain('in foo.ts')
			expect(text).toContain('() => string')
			expect(text).toContain('says hi')
			expect(text).toContain('hello world')
		})
	})

	test('truncates to MAX_EMBED_CHARS', () => {
		const huge = 'x'.repeat(10000)
		withTempFile(`function f() { return "${huge}" }`, (root, relPath) => {
			const text = buildEmbedText(
				{
					kind: 'function',
					name: 'f',
					qualifiedName: 'src/foo.ts::f',
					filePath: relPath,
					signature: null,
					docComment: null,
					byteStart: 0,
					byteEnd: huge.length + 30,
				},
				root,
				new Map(),
			)
			expect(text.length).toBeLessThanOrEqual(4500)
		})
	})

	test('handles missing source file gracefully', () => {
		const text = buildEmbedText(
			{
				kind: 'function',
				name: 'f',
				qualifiedName: 'src/foo.ts::f',
				filePath: 'nope.ts',
				signature: null,
				docComment: null,
				byteStart: 0,
				byteEnd: 50,
			},
			'/tmp/does-not-exist',
			new Map(),
		)
		expect(text).toContain('function f')
		expect(text).toContain('in nope.ts')
	})

	test('caches source reads via the supplied map', () => {
		const source = 'function a() {} function b() {}'
		withTempFile(source, (root, relPath) => {
			const cache = new Map<string, string>()
			buildEmbedText(
				{
					kind: 'function',
					name: 'a',
					qualifiedName: 'src/foo.ts::a',
					filePath: relPath,
					signature: null,
					docComment: null,
					byteStart: 0,
					byteEnd: 16,
				},
				root,
				cache,
			)
			expect(cache.has(relPath)).toBe(true)
			expect(cache.get(relPath)).toBe(source)
		})
	})

	test('omits source body when byte range is empty', () => {
		const text = buildEmbedText(
			{
				kind: 'variable',
				name: 'X',
				qualifiedName: 'src/foo.ts::X',
				filePath: 'src/foo.ts',
				signature: null,
				docComment: null,
				byteStart: 0,
				byteEnd: 0,
			},
			'/tmp',
			new Map(),
		)
		expect(text).toBe('variable X in foo.ts')
	})
})
