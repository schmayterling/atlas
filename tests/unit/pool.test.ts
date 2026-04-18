import { describe, expect, test } from 'bun:test'
import { runPool } from '../../bench-llm/lib/pool.js'

describe('runPool', () => {
	test('runs every item exactly once and preserves index order', async () => {
		const seen: number[] = []
		const results = await runPool([1, 2, 3, 4, 5], 2, async (n, i) => {
			seen.push(i)
			return n * 10
		})
		expect(results).toHaveLength(5)
		expect(results.map((r) => r.value)).toEqual([10, 20, 30, 40, 50])
		expect(seen.sort()).toEqual([0, 1, 2, 3, 4])
	})

	test('respects concurrency limit', async () => {
		let inFlight = 0
		let peak = 0
		await runPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
			inFlight++
			peak = Math.max(peak, inFlight)
			await new Promise((r) => setTimeout(r, 8))
			inFlight--
			return 1
		})
		expect(peak).toBeLessThanOrEqual(3)
		expect(peak).toBeGreaterThan(1)
	})

	test('captures errors per-item without halting the pool', async () => {
		const results = await runPool([1, 2, 3], 2, async (n) => {
			if (n === 2) throw new Error('boom-2')
			return n * 10
		})
		expect(results[0].value).toBe(10)
		expect(results[1].error?.message).toBe('boom-2')
		expect(results[2].value).toBe(30)
	})

	test('calls onProgress in completion order', async () => {
		const progress: number[] = []
		await runPool([3, 1, 2], 3, async (n) => {
			await new Promise((r) => setTimeout(r, n * 5))
			return n
		}, (done) => { progress.push(done) })
		expect(progress).toEqual([1, 2, 3])
	})

	test('concurrency=1 is strictly serial', async () => {
		const order: number[] = []
		await runPool([1, 2, 3], 1, async (n) => {
			order.push(n)
			return n
		})
		expect(order).toEqual([1, 2, 3])
	})
})
