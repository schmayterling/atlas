import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AtlasStore } from '../../src/core/storage/store.js'
import { detectChanges } from '../../src/core/indexer/change-detector.js'
import type { DiscoveredFile } from '../../src/core/indexer/file-discovery.js'
import { createTempStore, type TempStore } from '../helpers/tmp-store.js'

let temp: TempStore
let store: AtlasStore

beforeEach(() => {
	temp = createTempStore()
	store = temp.store
})

afterEach(() => temp.cleanup())

function discovered(path: string): DiscoveredFile {
	return { path, absolutePath: '/tmp/' + path, language: 'typescript', sizeBytes: 100 }
}

describe('detectChanges', () => {
	test('first-time index marks everything as added', () => {
		const files = [discovered('a.ts'), discovered('b.ts')]
		const changes = detectChanges('/tmp', files, store)
		expect(changes.added).toEqual(['a.ts', 'b.ts'])
		expect(changes.modified).toEqual([])
		expect(changes.deleted).toEqual([])
		expect(changes.isFullReindex).toBe(true)
	})

	test('detects deleted files when discovery shrinks', () => {
		store.insertFile('a.ts', 'h-a', 'typescript', 100)
		store.insertFile('b.ts', 'h-b', 'typescript', 100)
		const changes = detectChanges('/tmp', [discovered('a.ts')], store)
		expect(changes.deleted).toContain('b.ts')
	})

	test('detects added files when discovery grows', () => {
		store.insertFile('a.ts', 'h-a', 'typescript', 100)
		const changes = detectChanges('/tmp', [discovered('a.ts'), discovered('c.ts')], store)
		expect(changes.added).toContain('c.ts')
	})
})
