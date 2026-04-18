import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import '../helpers/setup.js'
import { createTempStore } from '../helpers/tmp-store.js'
import type { AtlasStore } from '../../src/core/storage/store.js'

// covers #77: the graphql linker used to run an ad hoc queryRawWithParams
// for name+kind lookups. replaced by a typed store method so the query
// layer never introduces new queryRaw call sites.

let store: AtlasStore
let cleanup: () => void

beforeAll(() => {
	const t = createTempStore()
	store = t.store
	cleanup = t.cleanup
	const fileId = store.insertFile('src/models.ts', 'h', 'typescript', 100, false)
	const testFileId = store.insertFile('tests/models.test.ts', 'h', 'typescript', 100, true)
	store.insertSymbol({
		stableId: 'id-User-iface',
		fileId,
		name: 'User',
		qualifiedName: 'src/models.ts::User',
		kind: 'interface',
		visibility: 'export',
		isExported: true,
		lineStart: 1,
		lineEnd: 5,
		colStart: 0,
		colEnd: 0,
		byteStart: 0,
		byteEnd: 100,
		parentId: null,
		signature: null,
		docComment: null,
		metadata: null,
	})
	store.insertSymbol({
		stableId: 'id-User-class',
		fileId,
		name: 'User',
		qualifiedName: 'src/models.ts::User',
		kind: 'class',
		visibility: 'export',
		isExported: true,
		lineStart: 10,
		lineEnd: 20,
		colStart: 0,
		colEnd: 0,
		byteStart: 0,
		byteEnd: 100,
		parentId: null,
		signature: null,
		docComment: null,
		metadata: null,
	})
	store.insertSymbol({
		stableId: 'id-testOnly',
		fileId: testFileId,
		name: 'User',
		qualifiedName: 'tests/models.test.ts::User',
		kind: 'class',
		visibility: null,
		isExported: false,
		lineStart: 1,
		lineEnd: 1,
		colStart: 0,
		colEnd: 0,
		byteStart: 0,
		byteEnd: 10,
		parentId: null,
		signature: null,
		docComment: null,
		metadata: null,
	})
	store.insertSymbol({
		stableId: 'id-Other',
		fileId,
		name: 'Other',
		qualifiedName: 'src/models.ts::Other',
		kind: 'type',
		visibility: null,
		isExported: false,
		lineStart: 30,
		lineEnd: 30,
		colStart: 0,
		colEnd: 0,
		byteStart: 0,
		byteEnd: 10,
		parentId: null,
		signature: null,
		docComment: null,
		metadata: null,
	})
})

afterAll(() => cleanup())

describe('getSymbolsByNamesAndKinds', () => {
	test('returns non-test rows matching both filters', () => {
		const rows = store.getSymbolsByNamesAndKinds(['User'], ['interface', 'type', 'class'])
		const ids = rows.map((r) => r.stableId).sort()
		expect(ids).toEqual(['id-User-class', 'id-User-iface'])
	})

	test('empty name list returns empty result', () => {
		expect(store.getSymbolsByNamesAndKinds([], ['class'])).toEqual([])
	})

	test('empty kind list returns empty result', () => {
		expect(store.getSymbolsByNamesAndKinds(['User'], [])).toEqual([])
	})

	test('kind filter excludes non-matching rows', () => {
		const rows = store.getSymbolsByNamesAndKinds(['Other'], ['class'])
		expect(rows).toEqual([])
	})
})
