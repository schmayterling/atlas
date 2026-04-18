import { describe, expect, test } from 'bun:test'
import '../helpers/setup.js'
import { stripInlineImportTypes, parseSource } from '../../src/core/parser/parser-manager.js'
import { extractTypeScript } from '../../src/core/parser/extractors/typescript.js'

// covers #81: inline `import('./foo.js').T` types in class-member
// return positions crash tree-sitter's class-body recovery. without
// preprocessing, every method after the first occurrence is silently
// dropped from the index. the ts-resolver still emits call edges with
// AST-derived source stable_ids, but those ids match no symbol row so
// deps/blast-radius/trace surface them as <unknown>.

describe('stripInlineImportTypes', () => {
	test('preserves byte length so tree-sitter offsets stay valid', () => {
		const src = "const x: import('./foo.js').Bar = null as any\n"
		const out = stripInlineImportTypes(src)
		// total length unchanged so line offsets and any post-match
		// byte positions still line up with the original source a
		// developer reads in an editor.
		expect(out.length).toBe(src.length)
		// line count is preserved across the replacement.
		expect(out.split('\n').length).toBe(src.split('\n').length)
	})

	test('rewrites every inline import type', () => {
		const src = "type A = import('../a.js').X\ntype B = import('../b.js').Y\n"
		const out = stripInlineImportTypes(src)
		expect(out.includes('import(')).toBe(false)
		expect(out.includes('X')).toBe(true)
		expect(out.includes('Y')).toBe(true)
	})

	test('leaves ordinary imports untouched', () => {
		const src = "import { X } from './a.js'\n"
		expect(stripInlineImportTypes(src)).toBe(src)
	})

	// deep-review pass 2/4/10 codex caught the original regex clobbering
	// runtime dynamic-import chains by rewriting `import('./m.js').then`
	// into a bare `then` call. the negative lookahead skips any match
	// where the identifier is immediately followed by `(`.
	test('leaves runtime dynamic-import method chains untouched', () => {
		const samples = [
			"const p = import('./m.js').then((m) => m.run())",
			"import('./m.js').catch((e) => console.error(e))",
			"import('./m.js').finally(() => cleanup())",
		]
		for (const src of samples) {
			expect(stripInlineImportTypes(src)).toBe(src)
		}
	})

	test('fast-path returns unchanged source when no inline import()', () => {
		const src = 'export const answer = 42\nfunction foo() { return answer }\n'
		// same object-identity check is not guaranteed, but content must match
		expect(stripInlineImportTypes(src)).toBe(src)
	})
})

describe('class body with inline import() types', () => {
	test('every method is extracted after preprocessing', () => {
		const src = `
export class Sample {
	first(): number { return 1 }

	showChannel(): {
		symbols: import('../../../shared/types.js').SymbolResult[]
	} {
		return { symbols: [] }
	}

	second(x: string): {
		payload: import('../types.js').Payload
		count: number
	} {
		return { payload: null as any, count: 0 }
	}

	third(): void {}
}
`
		const tree = parseSource(src, 'typescript')
		const { symbols } = extractTypeScript(tree, 'sample.ts', src)
		const methods = symbols.filter((s) => s.kind === 'method').map((s) => s.name)
		// without the preprocessing fix, `third` drops off and the
		// extractor returns only [first, showChannel] or similar.
		expect(methods).toContain('first')
		expect(methods).toContain('showChannel')
		expect(methods).toContain('second')
		expect(methods).toContain('third')
	})
})
