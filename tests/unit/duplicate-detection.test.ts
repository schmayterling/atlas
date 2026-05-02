import { describe, expect, test } from 'bun:test'
import { detectDuplicatesFromEmbeddings } from '../../src/core/queries/duplicate-detection.js'
import { createTempStore } from '../helpers/tmp-store.js'

describe('detectDuplicatesFromEmbeddings', () => {
	test('clears stale derived duplicate pairs before recomputing', () => {
		const { store, cleanup } = createTempStore()
		try {
			store.runRaw(
				'INSERT INTO duplicates (symbol_a_id, symbol_b_id, similarity) VALUES (?, ?, ?)',
				'old-a',
				'old-b',
				0.99,
			)
			expect(
				store.queryRaw<{ count: number }>('SELECT COUNT(*) as count FROM duplicates')[0].count,
			).toBe(1)

			expect(detectDuplicatesFromEmbeddings(store)).toBe(0)
			expect(
				store.queryRaw<{ count: number }>('SELECT COUNT(*) as count FROM duplicates')[0].count,
			).toBe(0)
		} finally {
			cleanup()
		}
	})
})
