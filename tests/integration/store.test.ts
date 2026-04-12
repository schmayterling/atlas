import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AtlasStore } from '../../src/core/storage/store.js'
import { stableSymbolId } from '../../src/shared/identity.js'
import { createTempStore, type TempStore } from '../helpers/tmp-store.js'

let temp: TempStore
let store: AtlasStore

beforeEach(() => {
	temp = createTempStore()
	store = temp.store
})

afterEach(() => {
	temp.cleanup()
})

function seedFile(path = 'src/foo.ts'): { fileId: number } {
	const fileId = store.insertFile(path, 'hash-' + path, 'typescript', 100)
	return { fileId }
}

function seedSymbol(opts: {
	fileId: number
	name: string
	path?: string
	kind?: 'function' | 'class' | 'method'
	exported?: boolean
}): string {
	const path = opts.path ?? 'src/foo.ts'
	const kind = opts.kind ?? 'function'
	const qname = `${path}::${opts.name}`
	const stableId = stableSymbolId(path, kind, qname)
	store.insertSymbol({
		stableId,
		fileId: opts.fileId,
		name: opts.name,
		qualifiedName: qname,
		kind,
		visibility: opts.exported ? 'export' : null,
		isExported: opts.exported ?? false,
		lineStart: 1,
		lineEnd: 5,
		colStart: 0,
		colEnd: 10,
		byteStart: 0,
		byteEnd: 50,
		parentId: null,
		signature: '() => void',
		docComment: null,
		metadata: null,
	})
	return stableId
}

describe('AtlasStore CRUD', () => {
	test('inserts and retrieves a file', () => {
		const { fileId } = seedFile()
		expect(fileId).toBeGreaterThan(0)
		const files = store.getAllFiles()
		expect(files.length).toBe(1)
		expect(files[0].path).toBe('src/foo.ts')
	})

	test('inserts and retrieves a symbol by stable id', () => {
		const { fileId } = seedFile()
		const id = seedSymbol({ fileId, name: 'foo' })
		const sym = store.getSymbolByStableId(id)
		expect(sym).not.toBeNull()
		expect(sym!.name).toBe('foo')
		expect(sym!.kind).toBe('function')
	})

	test('returns null for unknown stable id', () => {
		expect(store.getSymbolByStableId('0'.repeat(32))).toBeNull()
	})
})

describe('AtlasStore batch queries', () => {
	test('getSymbolsByStableIds returns only matching ids', () => {
		const { fileId } = seedFile()
		const a = seedSymbol({ fileId, name: 'a' })
		const b = seedSymbol({ fileId, name: 'b' })
		seedSymbol({ fileId, name: 'c' })
		const map = store.getSymbolsByStableIds([a, b, '0'.repeat(32)])
		expect(map.size).toBe(2)
		expect(map.has(a)).toBe(true)
		expect(map.has(b)).toBe(true)
	})

	test('symbolsToResults matches symbolToResult one by one', () => {
		const { fileId } = seedFile()
		const id1 = seedSymbol({ fileId, name: 'one' })
		const id2 = seedSymbol({ fileId, name: 'two' })
		const syms = [id1, id2].map((id) => store.getSymbolByStableId(id)!)
		const batched = store.symbolsToResults(syms)
		const oneByOne = syms.map((s) => store.symbolToResult(s))
		expect(batched).toEqual(oneByOne)
	})

	test('getSymbolsByStableIds handles empty input', () => {
		expect(store.getSymbolsByStableIds([]).size).toBe(0)
	})
})

describe('AtlasStore bulkInsert', () => {
	test('runs operations inside a transaction', () => {
		const { fileId } = seedFile()
		store.bulkInsert(() => {
			seedSymbol({ fileId, name: 'a' })
			seedSymbol({ fileId, name: 'b' })
			seedSymbol({ fileId, name: 'c' })
		})
		expect(store.getSymbolCount()).toBe(3)
	})

	test('rolls back on throw', () => {
		const { fileId } = seedFile()
		expect(() =>
			store.bulkInsert(() => {
				seedSymbol({ fileId, name: 'a' })
				throw new Error('boom')
			}),
		).toThrow('boom')
		expect(store.getSymbolCount()).toBe(0)
	})
})

describe('AtlasStore cascade deletes', () => {
	test('deleting a file removes its symbols', () => {
		const { fileId } = seedFile()
		seedSymbol({ fileId, name: 'a' })
		seedSymbol({ fileId, name: 'b' })
		expect(store.getSymbolCount()).toBe(2)
		store.deleteFilesByPaths(['src/foo.ts'])
		expect(store.getSymbolCount()).toBe(0)
		expect(store.getFileCount()).toBe(0)
	})

	test('deleting a file removes its edges', () => {
		const { fileId } = seedFile()
		const a = seedSymbol({ fileId, name: 'a' })
		const b = seedSymbol({ fileId, name: 'b' })
		store.insertEdge({
			sourceId: a,
			targetId: b,
			kind: 'calls',
			fileId,
			line: 1,
			col: 0,
			confidence: 'resolved',
			metadata: null,
		})
		expect(store.getEdgeCount()).toBe(1)
		store.deleteFilesByPaths(['src/foo.ts'])
		expect(store.getEdgeCount()).toBe(0)
	})
})

describe('AtlasStore prepared statements survive multiple calls', () => {
	test('repeated getSymbolByStableId returns consistent results', () => {
		const { fileId } = seedFile()
		const id = seedSymbol({ fileId, name: 'foo' })
		for (let i = 0; i < 10; i++) {
			const sym = store.getSymbolByStableId(id)
			expect(sym).not.toBeNull()
			expect(sym!.name).toBe('foo')
		}
	})
})
