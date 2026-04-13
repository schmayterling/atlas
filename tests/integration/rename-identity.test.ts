import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import '../helpers/setup.js'
import { createTempStore, type TempStore } from '../helpers/tmp-store.js'
import { stableSymbolId } from '../../src/shared/identity.js'

let temp: TempStore

beforeEach(() => {
	temp = createTempStore()
})

afterEach(() => {
	temp.cleanup()
})

describe('rewriteStableIdsForRename', () => {
	test('rewrites symbols, edges, api_endpoints, test_links for a pure rename', () => {
		const store = temp.store
		const oldPath = 'src/foo.ts'
		const newPath = 'src/bar.ts'

		// seed an "old" file with two symbols + an intra-file call edge
		const fileId = store.insertFile(oldPath, 'h1', 'typescript', 100, false)
		const oldHelloId = stableSymbolId(oldPath, 'function', `${oldPath}::hello`)
		const oldWorldId = stableSymbolId(oldPath, 'function', `${oldPath}::world`)

		store.insertSymbol({
			stableId: oldHelloId,
			fileId,
			name: 'hello',
			qualifiedName: `${oldPath}::hello`,
			kind: 'function',
			visibility: null,
			isExported: true,
			lineStart: 1,
			lineEnd: 3,
			colStart: 0,
			colEnd: 0,
			byteStart: 0,
			byteEnd: 40,
			parentId: null,
			signature: '() => void',
			docComment: null,
			metadata: null,
		})
		store.insertSymbol({
			stableId: oldWorldId,
			fileId,
			name: 'world',
			qualifiedName: `${oldPath}::world`,
			kind: 'function',
			visibility: null,
			isExported: true,
			lineStart: 5,
			lineEnd: 6,
			colStart: 0,
			colEnd: 0,
			byteStart: 50,
			byteEnd: 80,
			parentId: null,
			signature: '() => void',
			docComment: null,
			metadata: null,
		})

		// intra-file edge: hello -> world
		store.insertEdge({
			sourceId: oldHelloId,
			targetId: oldWorldId,
			kind: 'calls',
			fileId,
			line: 2,
			col: 0,
			confidence: 'resolved',
			metadata: null,
		})

		// an api endpoint pointing at hello
		store.insertApiEndpoint({
			filePath: oldPath,
			pathPattern: '/api/hello',
			httpMethod: 'GET',
			symbolStableId: oldHelloId,
			role: 'server',
			framework: null,
			line: 1,
		})

		// a test_link referring to hello (simulates a test that calls it)
		store.runRaw(
			'INSERT INTO test_links (test_file_id, source_symbol_stable_id, confidence) VALUES (?, ?, ?)',
			fileId,
			oldHelloId,
			'called',
		)

		// rewrite
		const rewritten = store.rewriteStableIdsForRename(oldPath, newPath)
		expect(rewritten).toBe(2)

		// files.path updated in place; file_id stable
		const fileRow = store.getFileByPath(newPath)
		expect(fileRow).not.toBeNull()
		expect(fileRow!.id).toBe(fileId)
		expect(store.getFileByPath(oldPath)).toBeNull()

		// new stable ids follow the path-substitution rule
		const newHelloId = stableSymbolId(newPath, 'function', `${newPath}::hello`)
		const newWorldId = stableSymbolId(newPath, 'function', `${newPath}::world`)
		expect(newHelloId).not.toBe(oldHelloId)

		// symbols table uses new ids and new qnames
		expect(store.getSymbolByStableId(newHelloId)).not.toBeNull()
		expect(store.getSymbolByStableId(oldHelloId)).toBeNull()
		expect(store.getSymbolByStableId(newHelloId)!.qualifiedName).toBe(`${newPath}::hello`)

		// edges table reference the new ids
		const edgesFromHello = store.getDirectEdgesFrom(newHelloId, 'calls')
		expect(edgesFromHello).toHaveLength(1)
		expect(edgesFromHello[0].targetId).toBe(newWorldId)

		// api_endpoints table: symbol_stable_id and file_path both rewritten
		const endpoints = store.queryRaw<{ symbolStableId: string; filePath: string }>(
			`SELECT symbol_stable_id as symbolStableId, file_path as filePath FROM api_endpoints`,
		)
		expect(endpoints).toHaveLength(1)
		expect(endpoints[0].symbolStableId).toBe(newHelloId)
		expect(endpoints[0].filePath).toBe(newPath)

		// test_links table: source_symbol_stable_id rewritten
		const links = store.queryRaw<{ sourceSymbolStableId: string }>(
			`SELECT source_symbol_stable_id as sourceSymbolStableId FROM test_links`,
		)
		expect(links).toHaveLength(1)
		expect(links[0].sourceSymbolStableId).toBe(newHelloId)
	})

	test('rewrites parent_id across the same file', () => {
		const store = temp.store
		const oldPath = 'src/foo.ts'
		const newPath = 'src/bar.ts'
		const fileId = store.insertFile(oldPath, 'h', 'typescript', 100, false)

		const classQname = `${oldPath}::Klass`
		const methodQname = `${oldPath}::Klass.greet`
		const oldClassId = stableSymbolId(oldPath, 'class', classQname)
		const oldMethodId = stableSymbolId(oldPath, 'method', methodQname)

		store.insertSymbol({
			stableId: oldClassId,
			fileId,
			name: 'Klass',
			qualifiedName: classQname,
			kind: 'class',
			visibility: null,
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
			stableId: oldMethodId,
			fileId,
			name: 'greet',
			qualifiedName: methodQname,
			kind: 'method',
			visibility: null,
			isExported: false,
			lineStart: 2,
			lineEnd: 4,
			colStart: 2,
			colEnd: 0,
			byteStart: 20,
			byteEnd: 80,
			parentId: oldClassId,
			signature: '() => string',
			docComment: null,
			metadata: null,
		})

		store.rewriteStableIdsForRename(oldPath, newPath)

		const newMethodId = stableSymbolId(newPath, 'method', `${newPath}::Klass.greet`)
		const newClassId = stableSymbolId(newPath, 'class', `${newPath}::Klass`)

		const method = store.getSymbolByStableId(newMethodId)
		expect(method).not.toBeNull()
		expect(method!.parentId).toBe(newClassId)
	})

	test('no-op rename returns 0 when file has no symbols', () => {
		const store = temp.store
		store.insertFile('empty.ts', 'h', 'typescript', 0, false)

		const rewritten = store.rewriteStableIdsForRename('empty.ts', 'moved-empty.ts')
		expect(rewritten).toBe(0)
		expect(store.getFileByPath('moved-empty.ts')).not.toBeNull()
		expect(store.getFileByPath('empty.ts')).toBeNull()
	})
})
