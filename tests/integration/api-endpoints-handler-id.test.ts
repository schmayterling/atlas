import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import type { AtlasEngine } from '../../src/core/engine.js'
import { addProject } from '../../src/core/registry.js'
import { closeAll, getOrCreateEngine } from '../../src/core/engine-pool.js'

// covers #74: every server-side app.get('/path', handler) registration
// must attribute to its own symbol (the handler), not to a shared
// `filePath::module` fallback. two endpoints in the same file used to
// collide on one synthetic stable_id, which broke cross-project edge
// correctness and api-tracing.

let root: string
let engine: AtlasEngine

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'atlas-api-handler-id-'))
	mkdirSync(join(root, 'api'), { recursive: true })

	writeFileSync(
		join(root, 'api', 'server.ts'),
		`import express from 'express'
const app = express()

export function getUsers(req: any, res: any) { res.json([]) }
export function postOrders(req: any, res: any) { res.json({ id: 1 }) }

app.get('/api/users', getUsers)
app.post('/api/orders', postOrders)
app.get('/api/anon', (req, res) => res.json({ ok: true }))
`,
	)

	const project = addProject(root)
	engine = getOrCreateEngine(project.id, root)
	await engine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false })
})

afterAll(() => {
	closeAll()
	rmSync(root, { recursive: true, force: true })
})

describe('api-endpoints handler stable_id (#74)', () => {
	test('each server registration points at its handler, not a shared module id', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{
			path_pattern: string
			role: string
			symbol_stable_id: string
		}>(
			`SELECT path_pattern, role, symbol_stable_id FROM api_endpoints ORDER BY path_pattern, role`,
		)
		const serverRows = rows.filter((r) => r.role === 'server')
		expect(serverRows.length).toBe(3)
		const ids = new Set(serverRows.map((r) => r.symbol_stable_id))
		// all three distinct — no module fallback collision
		expect(ids.size).toBe(3)
	})

	test('named handler registrations resolve to the exported handler symbol', () => {
		const store = engine.getStoreForCrossProject()
		const endpoints = store.queryRaw<{
			path_pattern: string
			symbol_stable_id: string
		}>(
			`SELECT path_pattern, symbol_stable_id FROM api_endpoints WHERE role = 'server'`,
		)
		const users = endpoints.find((e) => e.path_pattern === '/api/users')
		expect(users).toBeDefined()
		const handler = store.queryRawWithParams<{ name: string }>(
			`SELECT name FROM symbols WHERE stable_id = ?`,
			users!.symbol_stable_id,
		)
		expect(handler[0]?.name).toBe('getUsers')
	})
})
