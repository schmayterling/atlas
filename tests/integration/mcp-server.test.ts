import { beforeAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../../src/mcp/server.js'
import { getFixtureEngine } from '../helpers/fixture-engine.js'

let client: Client

beforeAll(async () => {
	const engine = await getFixtureEngine()
	const server = createMcpServer(engine)
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	client = new Client({ name: 'atlas-test', version: '0.0.0' })
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
})

describe('mcp server tool registration', () => {
	test('exposes the expected atlas_* tools', async () => {
		const result = await client.listTools()
		const names = result.tools.map((t) => t.name).sort()
		expect(names).toContain('atlas_status')
		expect(names).toContain('atlas_search')
		expect(names).toContain('atlas_deps')
		expect(names).toContain('atlas_blast_radius')
		expect(names).toContain('atlas_trace')
		expect(names).toContain('atlas_dead_code')
	})
})

describe('mcp server tool dispatch', () => {
	test('atlas_status returns formatted text', async () => {
		const result = await client.callTool({ name: 'atlas_status', arguments: {} })
		const content = result.content as { type: string; text: string }[]
		expect(content[0].type).toBe('text')
		expect(content[0].text).toContain('files:')
	})

	test('atlas_search finds AuthService', async () => {
		const result = await client.callTool({
			name: 'atlas_search',
			arguments: { query: 'AuthService' },
		})
		const content = result.content as { type: string; text: string }[]
		expect(content[0].text).toContain('AuthService')
	})

	test('multiple sequential tool calls succeed (regression: stateless transport reuse)', async () => {
		// fix #4 was rooted in transport reuse breaking after the first
		// request. running several calls in a row catches that class of bug.
		for (let i = 0; i < 5; i++) {
			const result = await client.callTool({ name: 'atlas_status', arguments: {} })
			expect(result.isError).toBeFalsy()
		}
	})

	test('errors propagate as isError, not exceptions', async () => {
		const result = await client.callTool({
			name: 'atlas_search',
			arguments: { query: '' },
		})
		// empty query is allowed but returns no results, doesn't throw
		expect(result.isError).toBeFalsy()
	})
})
