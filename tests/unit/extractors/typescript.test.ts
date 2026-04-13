import { describe, expect, test } from 'bun:test'
import { extractTS } from '../../helpers/parse.js'

describe('typescript extractor', () => {
	test('extracts a top-level function declaration', () => {
		const result = extractTS(`export function greet(name: string): string { return 'hi ' + name }`)
		const fn = result.symbols.find((s) => s.name === 'greet')
		expect(fn).toBeDefined()
		expect(fn!.kind).toBe('function')
		expect(fn!.isExported).toBe(true)
	})

	test('extracts a class with methods and produces contains edges', () => {
		const result = extractTS(`
			export class Foo {
				bar(): number { return 1 }
				baz(): number { return 2 }
			}
		`)
		const cls = result.symbols.find((s) => s.kind === 'class' && s.name === 'Foo')
		expect(cls).toBeDefined()
		const methods = result.symbols.filter((s) => s.kind === 'method')
		expect(methods.map((m) => m.name).sort()).toEqual(['bar', 'baz'])
		const containsEdges = result.edges.filter((e) => e.kind === 'contains')
		expect(containsEdges.length).toBeGreaterThanOrEqual(2)
	})

	test('captures import statements as imports', () => {
		const result = extractTS(`import { foo } from './other.js'\nexport const x = foo()`)
		expect(result.imports.length).toBe(1)
		expect(result.imports[0].importPath).toBe('./other.js')
	})

	test('marks non-exported declarations as not exported', () => {
		const result = extractTS(`function privateHelper() {}`)
		const sym = result.symbols.find((s) => s.name === 'privateHelper')
		expect(sym).toBeDefined()
		expect(sym!.isExported).toBe(false)
	})

	test('methods of an exported class inherit isExported=true (#34)', () => {
		const result = extractTS(`
			export class AtlasStore {
				getSymbol(id: string): void {}
				insertEdge(e: unknown): void {}
			}
		`)
		const methods = result.symbols.filter((s) => s.kind === 'method')
		expect(methods.length).toBe(2)
		for (const m of methods) expect(m.isExported).toBe(true)
	})

	test('methods of a non-exported class stay non-exported (#34)', () => {
		const result = extractTS(`
			class Private {
				helper(): void {}
			}
		`)
		const methods = result.symbols.filter((s) => s.kind === 'method')
		expect(methods.length).toBe(1)
		expect(methods[0].isExported).toBe(false)
	})

	test('methods of an exported interface inherit isExported=true (#34)', () => {
		const result = extractTS(`
			export interface Store {
				get(id: string): void
				set(id: string, v: string): void
			}
		`)
		const methods = result.symbols.filter((s) => s.kind === 'method')
		expect(methods.length).toBe(2)
		for (const m of methods) expect(m.isExported).toBe(true)
	})

	test('extracts interfaces', () => {
		const result = extractTS(`export interface User { id: string; email: string }`)
		const iface = result.symbols.find((s) => s.kind === 'interface' && s.name === 'User')
		expect(iface).toBeDefined()
	})

	test('extracts type aliases', () => {
		const result = extractTS(`export type ID = string`)
		const t = result.symbols.find((s) => s.kind === 'type' && s.name === 'ID')
		expect(t).toBeDefined()
	})

	test('byte_start/byte_end span the symbol body', () => {
		const source = `export function alpha() {}\nexport function beta() {}`
		const result = extractTS(source)
		const alpha = result.symbols.find((s) => s.name === 'alpha')
		expect(alpha).toBeDefined()
		expect(alpha!.byteEnd).toBeGreaterThan(alpha!.byteStart)
		expect(source.slice(alpha!.byteStart, alpha!.byteEnd)).toContain('alpha')
	})

	test('handles empty source without throwing', () => {
		const result = extractTS('')
		expect(result.symbols).toEqual([])
		expect(result.edges).toEqual([])
		expect(result.imports).toEqual([])
	})
})
