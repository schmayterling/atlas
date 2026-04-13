import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createTempStore } from '../helpers/tmp-store.js'
import type { AtlasStore } from '../../src/core/storage/store.js'

// covers #10: channel_hits is the generic data model for
// cross-language channel linking. this unit suite pins the schema
// invariants (unique constraint, cascade delete), the idempotency
// guarantee (duplicate inserts are ignored), the group query
// (<2 symbols per value are filtered out), and the symbol-by-byte
// lookup that channel linkers use to credit a regex hit to the
// smallest enclosing symbol.

let store: AtlasStore
let cleanup: () => void

beforeEach(() => {
	const tmp = createTempStore()
	store = tmp.store
	cleanup = tmp.cleanup
})

afterEach(() => {
	cleanup()
})

// populates a single file with three symbols so every test can refer
// to stable_ids without going through the extractor. mirrors how real
// channel linkers would insert rows after step 5 runs.
function seedFileWithSymbols() {
	const fileId = store.insertFile('src/queries.ts', 'abcd1234', 'typescript', 100, false)
	const alphaId = 'alpha-stable-id'
	const betaId = 'beta-stable-id'
	const gammaId = 'gamma-stable-id'
	store.insertSymbol({
		stableId: alphaId,
		fileId,
		name: 'alpha',
		qualifiedName: 'src/queries.ts::alpha',
		kind: 'function',
		visibility: null,
		isExported: true,
		lineStart: 1,
		lineEnd: 5,
		colStart: 0,
		colEnd: 10,
		byteStart: 0,
		byteEnd: 50,
		parentId: null,
		signature: null,
		docComment: null,
		metadata: null,
	})
	store.insertSymbol({
		stableId: betaId,
		fileId,
		name: 'beta',
		qualifiedName: 'src/queries.ts::beta',
		kind: 'function',
		visibility: null,
		isExported: true,
		lineStart: 7,
		lineEnd: 12,
		colStart: 0,
		colEnd: 10,
		byteStart: 60,
		byteEnd: 120,
		parentId: null,
		signature: null,
		docComment: null,
		metadata: null,
	})
	store.insertSymbol({
		stableId: gammaId,
		fileId,
		name: 'gamma',
		qualifiedName: 'src/queries.ts::gamma',
		kind: 'function',
		visibility: null,
		isExported: true,
		lineStart: 14,
		lineEnd: 18,
		colStart: 0,
		colEnd: 10,
		byteStart: 130,
		byteEnd: 200,
		parentId: null,
		signature: null,
		docComment: null,
	metadata: null,
	})
	return { fileId, alphaId, betaId, gammaId }
}

describe('channel_hits store api', () => {
	test('insertChannelHits writes rows and UNIQUE blocks duplicates', () => {
		const { fileId, alphaId } = seedFileWithSymbols()
		store.insertChannelHits([
			{ symbolStableId: alphaId, fileId, kind: 'sql_table', value: 'users', line: 3, metadata: null },
			{ symbolStableId: alphaId, fileId, kind: 'sql_table', value: 'users', line: 3, metadata: null },
		])
		const rows = store.queryRaw<{ count: number }>(
			`SELECT COUNT(*) as count FROM channel_hits WHERE symbol_stable_id = 'alpha-stable-id'`,
		)
		expect(rows[0]?.count).toBe(1)
	})

	test('deleteChannelHitsByKind only touches the specified kind', () => {
		const { fileId, alphaId } = seedFileWithSymbols()
		store.insertChannelHits([
			{ symbolStableId: alphaId, fileId, kind: 'sql_table', value: 'users', line: 3, metadata: null },
			{ symbolStableId: alphaId, fileId, kind: 'graphql_type', value: 'User', line: 3, metadata: null },
		])
		store.deleteChannelHitsByKind('sql_table')
		const rows = store.queryRaw<{ kind: string }>(`SELECT kind FROM channel_hits`)
		expect(rows).toHaveLength(1)
		expect(rows[0].kind).toBe('graphql_type')
	})

	test('findChannelHitGroups returns groups with >=2 symbols', () => {
		const { fileId, alphaId, betaId, gammaId } = seedFileWithSymbols()
		store.insertChannelHits([
			{ symbolStableId: alphaId, fileId, kind: 'sql_table', value: 'users', line: 3, metadata: null },
			{ symbolStableId: betaId, fileId, kind: 'sql_table', value: 'users', line: 9, metadata: null },
			{ symbolStableId: gammaId, fileId, kind: 'sql_table', value: 'orphan_table', line: 15, metadata: null },
		])
		const groups = store.findChannelHitGroups('sql_table')
		// orphan_table has only 1 symbol and is filtered out. users
		// has alpha and beta, so exactly one group with two stable_ids.
		expect(groups).toHaveLength(1)
		expect(groups[0].value).toBe('users')
		expect(groups[0].symbolStableIds.sort()).toEqual([alphaId, betaId].sort())
	})

	test('getSymbolContainingByte returns the smallest enclosing symbol', () => {
		const { fileId, alphaId } = seedFileWithSymbols()
		// alpha spans 0..50, beta spans 60..120, gamma 130..200.
		// byte 30 is inside alpha only.
		const found = store.getSymbolContainingByte(fileId, 30)
		expect(found?.stableId).toBe(alphaId)
	})

	test('getSymbolContainingByte returns null when no symbol contains the offset', () => {
		const { fileId } = seedFileWithSymbols()
		// byte 55 lives between alpha (ends at 50) and beta (starts at 60).
		const found = store.getSymbolContainingByte(fileId, 55)
		expect(found).toBeNull()
	})

	test('channel_hits cascade-deletes when the file is removed', () => {
		const { fileId, alphaId } = seedFileWithSymbols()
		store.insertChannelHits([
			{ symbolStableId: alphaId, fileId, kind: 'sql_table', value: 'users', line: 3, metadata: null },
		])
		store.deleteFilesByPaths(['src/queries.ts'])
		const rows = store.queryRaw<{ count: number }>(
			`SELECT COUNT(*) as count FROM channel_hits`,
		)
		expect(rows[0]?.count).toBe(0)
	})
})
