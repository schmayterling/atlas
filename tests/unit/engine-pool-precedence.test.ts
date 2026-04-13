import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { addProject, setActiveProject } from '../../src/core/registry.js'
import { closeAll, getOrCreateEngine } from '../../src/core/engine-pool.js'
import '../helpers/setup.js'

// covers #8a / codex finding 1: an explicit fallbackRoot (the common
// `-p` cli case where commander defaults to cwd) must win over any
// active-project alias from `atlas use`. before #8a, indexCommand,
// statusCommand, deps, blast, trace, and 18 other call sites passed
// `getOrCreateEngine(undefined, projectRoot)` and the active project
// silently overrode the explicit path, indexing the wrong repo.
const originalHome = process.env.HOME
let fakeHome: string

beforeAll(() => {
	fakeHome = mkdtempSync(join(tmpdir(), 'atlas-engine-pool-precedence-'))
	process.env.HOME = fakeHome
})

afterAll(() => {
	process.env.HOME = originalHome
	if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
})

describe('engine-pool fallbackRoot precedence over active project', () => {
	let alphaRoot: string
	let betaRoot: string
	let alphaId: string
	let betaId: string

	beforeEach(() => {
		const dir = join(fakeHome, '.atlas')
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
		mkdirSync(dir, { recursive: true })

		alphaRoot = mkdtempSync(join(tmpdir(), 'atlas-pool-alpha-'))
		betaRoot = mkdtempSync(join(tmpdir(), 'atlas-pool-beta-'))
		// minimal source file so the engine has something real to anchor on
		writeFileSync(join(alphaRoot, 'a.ts'), 'export const alphaMarker = 1\n')
		writeFileSync(join(betaRoot, 'b.ts'), 'export const betaMarker = 2\n')

		const alpha = addProject(alphaRoot, 'alpha')
		const beta = addProject(betaRoot, 'beta')
		alphaId = alpha.id
		betaId = beta.id
		setActiveProject(alphaId)
	})

	afterEach(() => {
		closeAll()
		setActiveProject(null)
		rmSync(alphaRoot, { recursive: true, force: true })
		rmSync(betaRoot, { recursive: true, force: true })
	})

	test('explicit fallbackRoot pointing at a registered project reuses that engine', () => {
		const engine = getOrCreateEngine(undefined, betaRoot)
		// the engine should be anchored at betaRoot, not the active alpha
		expect((engine as unknown as { projectRoot: string }).projectRoot).toBe(betaRoot)
	})

	test('explicit fallbackRoot wins over active project alias', () => {
		// active project is alpha. explicit fallbackRoot points at beta.
		// before #8a, this returned the alpha engine. now it must return beta.
		const engine = getOrCreateEngine(undefined, betaRoot)
		expect((engine as unknown as { projectRoot: string }).projectRoot).not.toBe(alphaRoot)
		expect((engine as unknown as { projectRoot: string }).projectRoot).toBe(betaRoot)
	})

	test('fallbackRoot pointing at an unregistered path anchors a fresh engine', () => {
		const scratch = mkdtempSync(join(tmpdir(), 'atlas-pool-scratch-'))
		try {
			writeFileSync(join(scratch, 'x.ts'), 'export const x = 0\n')
			const engine = getOrCreateEngine(undefined, scratch)
			expect((engine as unknown as { projectRoot: string }).projectRoot).toBe(resolve(scratch))
		} finally {
			rmSync(scratch, { recursive: true, force: true })
		}
	})

	test('no projectId and no fallbackRoot still falls back to active project', () => {
		// this is the mcp-without-project / web-without-?project= path
		const engine = getOrCreateEngine(undefined)
		expect((engine as unknown as { projectRoot: string }).projectRoot).toBe(alphaRoot)
	})

	test('explicit projectId always wins regardless of fallbackRoot', () => {
		// explicit id takes top priority. the fallbackRoot is ignored.
		const engine = getOrCreateEngine(betaId, alphaRoot)
		expect((engine as unknown as { projectRoot: string }).projectRoot).toBe(betaRoot)
	})
})
