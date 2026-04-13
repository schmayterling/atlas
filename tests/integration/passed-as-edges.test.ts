import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #49: function-reference arguments (r.Use(Auth),
// router.get(path, handler), http.HandleFunc(path, fn)) now emit a
// passed_as edge from the caller to the handler symbol. previously
// there was no edge at all, so blast radius on the handler returned
// 0 and dead-code reported middleware as unreachable.

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-passed-as-'))
	mkdirSync(join(projectRoot, 'src'), { recursive: true })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('ts passed_as', () => {
	test('router.get(path, handler) produces a passed_as edge to handler', async () => {
		writeFileSync(
			join(projectRoot, 'src/handlers.ts'),
			`export function healthHandler(req: any, res: any): void {
	res.send('ok')
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/routes.ts'),
			`import { healthHandler } from './handlers.js'

export function registerRoutes(router: any): void {
	router.get('/health', healthHandler)
}
`,
		)

		engine = new AtlasEngine(projectRoot)
		await engine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false, withCoChange: false })

		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ count: number }>(
			`SELECT COUNT(*) as count
			 FROM edges e
			 JOIN symbols src ON src.stable_id = e.source_id
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE e.kind = 'passed_as'
			 AND src.name = 'registerRoutes'
			 AND tgt.name = 'healthHandler'`,
		)
		expect(rows[0]?.count ?? 0).toBeGreaterThan(0)
	})
})

describe('go passed_as', () => {
	test('r.Use(MiddlewareAuth) produces a passed_as edge to MiddlewareAuth', async () => {
		mkdirSync(join(projectRoot, 'cmd'), { recursive: true })
		writeFileSync(join(projectRoot, 'go.mod'), 'module example.com/demo\n\ngo 1.21\n')
		writeFileSync(
			join(projectRoot, 'cmd/main.go'),
			`package main

func MiddlewareAuth(next func()) func() {
	return next
}

func registerMiddleware() {
	Use(MiddlewareAuth)
}

func Use(fn func(func()) func()) {}
`,
		)

		engine = new AtlasEngine(projectRoot)
		await engine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false, withCoChange: false })

		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ count: number }>(
			`SELECT COUNT(*) as count
			 FROM edges e
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE e.kind = 'passed_as'
			 AND tgt.name = 'MiddlewareAuth'`,
		)
		expect(rows[0]?.count ?? 0).toBeGreaterThan(0)
	})
})
