import { describe, expect, test } from 'bun:test'
import { OllamaClient, EmbedContextLengthError } from '../../src/core/embeddings/ollama-client.js'

/** Creates a client with a mocked embed() method for testing embedBatched. */
function clientWithMockedEmbed(
	embedFn: (texts: string[]) => Promise<number[][]>,
): OllamaClient {
	const client = new OllamaClient()
	// replace the network-calling embed() with our mock
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
		const texts = ['ok-0', 'ok-1', 'POISON', 'ok-3']
		const client = clientWithMockedEmbed(async (batch) => {
			if (batch.includes('POISON')) {
				throw new EmbedContextLengthError(400, 'context length exceeded')
			}
			return batch.map((_, i) => fakeVec(i))
		})

		const results = await client.embedBatched(texts, 4)
		expect(results).toHaveLength(4)
		expect(results[0]).not.toBeNull()
		expect(results[1]).not.toBeNull()
		expect(results[2]).toBeNull() // POISON
		expect(results[3]).not.toBeNull()
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
			throw new EmbedContextLengthError(400, 'context length exceeded')
		})

		const results = await client.embedBatched(texts, 2)
		expect(results).toHaveLength(3)
		for (const r of results) {
			expect(r).toBeNull()
		}
	})

	test('respects retry budget and stops splitting', async () => {
		// 16 items, batch size 4 = 4 batches, budget = 8
		// all fail → budget exhausts before testing every item individually
		const texts = Array.from({ length: 16 }, (_, i) => `bad-${i}`)
		let callCount = 0
		const client = clientWithMockedEmbed(async () => {
			callCount++
			throw new EmbedContextLengthError(400, 'context length exceeded')
		})

		const results = await client.embedBatched(texts, 4)
		expect(results).toHaveLength(16)
		// should not have made an absurd number of calls
		expect(callCount).toBeLessThan(40)
	})

	test('single oversized symbol returns null with no throw', async () => {
		const client = clientWithMockedEmbed(async () => {
			throw new EmbedContextLengthError(400, 'context length exceeded')
		})

		const results = await client.embedBatched(['huge-symbol'], 1)
		expect(results).toHaveLength(1)
		expect(results[0]).toBeNull()
	})
})
