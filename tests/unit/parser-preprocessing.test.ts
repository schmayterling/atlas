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
