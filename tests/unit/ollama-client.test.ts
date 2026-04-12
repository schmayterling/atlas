import { describe, expect, test } from 'bun:test'
import { OllamaClient, EmbedContextLengthError } from '../../src/core/embeddings/ollama-client.js'

/** Creates a client with a mocked embed() method for testing embedBatched. */
function clientWithMockedEmbed(
	embedFn: (texts: string[]) => Promise<number[][]>,
): OllamaClient {
	const client = new OllamaClient()
	;(client as any).embed = embedFn
	return client
}

function fakeVec(seed: number): number[] {
	return Array.from({ length: 768 }, (_, i) => seed + i * 0.001)
}

describe('embedBatched', () => {
	test('returns all embeddings on success', async () => {
		const texts = ['a', 'b', 'c']
		const client = clientWithMockedEmbed(async (batch) =>
			batch.map((_, i) => fakeVec(i)),
		)

		const results = await client.embedBatched(texts, 2)
		expect(results).toHaveLength(3)
		for (const r of results) {
			expect(r).not.toBeNull()
		}
	})

	test('isolates a single failing text via binary split', async () => {
		// batchSize=8 ensures we hit the recursive split path (>4 threshold)
		const texts = ['ok-0', 'ok-1', 'ok-2', 'ok-3', 'POISON', 'ok-5', 'ok-6', 'ok-7']
		const client = clientWithMockedEmbed(async (batch) => {
			if (batch.includes('POISON')) {
				throw new EmbedContextLengthError()
			}
			return batch.map((_, i) => fakeVec(i))
		})

		const results = await client.embedBatched(texts, 8)
		expect(results).toHaveLength(8)
		expect(results[4]).toBeNull() // POISON
		// all others should succeed
		for (let i = 0; i < 8; i++) {
			if (i === 4) continue
			expect(results[i]).not.toBeNull()
		}
	})

	test('re-throws transport errors (5xx) instead of swallowing', async () => {
		const client = clientWithMockedEmbed(async () => {
			throw new Error('ollama embed failed: 500 internal server error')
		})

		await expect(client.embedBatched(['a'], 1)).rejects.toThrow('500')
	})

	test('re-throws timeout errors', async () => {
		const client = clientWithMockedEmbed(async () => {
			throw new DOMException('signal timed out', 'TimeoutError')
		})

		await expect(client.embedBatched(['a'], 1)).rejects.toThrow('timed out')
	})

	test('all texts failing returns all nulls without throwing', async () => {
		const texts = ['bad-0', 'bad-1', 'bad-2']
		const client = clientWithMockedEmbed(async () => {
			throw new EmbedContextLengthError()
		})

		const results = await client.embedBatched(texts, 2)
		expect(results).toHaveLength(3)
		for (const r of results) {
			expect(r).toBeNull()
		}
	})

	test('respects retry budget and stops splitting', async () => {
		// 64 items, batch size 16 = 4 batches, budget = max(8, 16) = 16
		// all fail → budget should limit total calls
		const texts = Array.from({ length: 64 }, (_, i) => `bad-${i}`)
		let callCount = 0
		const client = clientWithMockedEmbed(async () => {
			callCount++
			throw new EmbedContextLengthError()
		})

		const results = await client.embedBatched(texts, 16)
		expect(results).toHaveLength(64)
		// with budget=16, calls should be significantly less than uncapped (127+ per batch)
		expect(callCount).toBeLessThan(100)
	})

	test('single oversized symbol returns null with no throw', async () => {
		const client = clientWithMockedEmbed(async () => {
			throw new EmbedContextLengthError()
		})

		const results = await client.embedBatched(['huge-symbol'], 1)
		expect(results).toHaveLength(1)
		expect(results[0]).toBeNull()
	})
})
