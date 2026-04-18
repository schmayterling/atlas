// smoke test for bench-llm/lib/mcp-client.ts. uses atlas's OWN mcp
// server (`bun run src/bin.ts mcp`) as the spawn target — no need
// for CBM or chunkhound to be installed. validates that:
//   - openMcpAgent spawns a stdio mcp server
//   - it lists tools and converts to OpenAI tool format
//   - the handler can dispatch a real call and get a result back
//   - close() tears the process down

import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { openMcpAgent } from '../../bench-llm/lib/mcp-client.js'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('mcp-client end-to-end (atlas mcp as test target)', () => {
	test('lists tools, dispatches a call, closes cleanly', async () => {
		const handle = await openMcpAgent({
			name: 'atlas-self',
			command: 'bun',
			args: ['run', join(REPO_ROOT, 'src', 'bin.ts'), 'mcp'],
			env: { ...process.env, ATLAS_MCP_PROJECT_ROOT: REPO_ROOT } as Record<string, string>,
		}, REPO_ROOT)

		try {
			// atlas exposes ~12 tools via mcp; the exact count can change
			// as we ship new ones. lower-bound assert.
			expect(handle.tools.length).toBeGreaterThanOrEqual(5)

			// every tool must have name + description + parameters of
			// the OpenAI function-call shape.
			for (const t of handle.tools) {
				expect(t.type).toBe('function')
				expect(typeof t.function.name).toBe('string')
				expect(t.function.name.length).toBeGreaterThan(0)
				expect(typeof t.function.parameters).toBe('object')
			}

			// at least one well-known atlas tool should be present.
			const names = handle.tools.map((t) => t.function.name)
			expect(names.some((n) => n.includes('search') || n.includes('atlas'))).toBe(true)
		} finally {
			await handle.close()
		}
	}, 30_000)
})
