import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import '../helpers/setup.js'
import { linkInRepoApiEndpoints } from '../../src/core/queries/cross-language-linker.js'
import { createTempStore, type TempStore } from '../helpers/tmp-store.js'

let temp: TempStore

beforeEach(() => {
	temp = createTempStore()
})

afterEach(() => {
	temp.cleanup()
})

function seedEndpoint(
	store: TempStore['store'],
	filePath: string,
	pathPattern: string,
	role: 'client' | 'server',
	stableId: string,
	method: string | null = null,
	framework: string | null = null,
): void {
	const fileId = store.insertFile(filePath, 'h-' + filePath, 'go', 1, false)
	// also insert a stub symbol so stable_id lookups work downstream
	store.insertSymbol({
		stableId,
		fileId,
		name: 'handler',
		qualifiedName: stableId,
		kind: 'function',
		visibility: null,
		isExported: true,
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
	store.insertApiEndpoint({
		filePath,
		pathPattern,
		httpMethod: method,
		symbolStableId: stableId,
		role,
		framework,
		line: 1,
	})
}

describe('linkInRepoApiEndpoints', () => {
	test('matches exact client / server path pair', () => {
		const store = temp.store
		seedEndpoint(store, 'web/api.ts', '/api/users', 'client', 'web-client-1', 'GET', 'fetch')
		seedEndpoint(store, 'server/api.go', '/api/users', 'server', 'go-server-1', 'GET', 'chi')

		const result = linkInRepoApiEndpoints(store)
		expect(result.edgesCreated).toBe(1)

		const edges = store.queryRaw<{ source: string; target: string }>(
			`SELECT source_stable_id as source, target_stable_id as target FROM cross_project_edges WHERE source_project = 'local'`,
		)
		expect(edges).toHaveLength(1)
		expect(edges[0].source).toBe('web-client-1')
		expect(edges[0].target).toBe('go-server-1')
	})

	test('matches path-param across ts and go conventions', () => {
		const store = temp.store
		seedEndpoint(store, 'web/api.ts', '/api/users/${id}', 'client', 'web-client-2', 'GET')
		seedEndpoint(store, 'server/api.go', '/api/users/:id', 'server', 'go-server-2', 'GET')

		const result = linkInRepoApiEndpoints(store)
		expect(result.edgesCreated).toBe(1)
	})

	test('skips when http methods disagree', () => {
		const store = temp.store
		seedEndpoint(store, 'web/api.ts', '/api/users', 'client', 'web-client-3', 'POST')
		seedEndpoint(store, 'server/api.go', '/api/users', 'server', 'go-server-3', 'GET')

		const result = linkInRepoApiEndpoints(store)
		expect(result.edgesCreated).toBe(0)
	})

	test('clears prior local rows on re-run', () => {
		const store = temp.store
		seedEndpoint(store, 'web/api.ts', '/api/users', 'client', 'web-client-4', 'GET')
		seedEndpoint(store, 'server/api.go', '/api/users', 'server', 'go-server-4', 'GET')

		linkInRepoApiEndpoints(store)
		linkInRepoApiEndpoints(store)
		// running twice should still yield exactly one row, not two
		const edges = store.queryRaw<{ id: number }>(
			`SELECT id FROM cross_project_edges WHERE source_project = 'local'`,
		)
		expect(edges).toHaveLength(1)
	})
})
