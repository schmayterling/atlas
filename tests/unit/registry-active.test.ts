import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as registry from '../../src/core/registry.js'

// redirect the registry dir away from $HOME/.atlas so tests don't
// mutate the user's real registry. registry.ts reads process.env.HOME
// lazily, so mutating HOME inside beforeAll is enough to pin every
// subsequent call to the fake home without a module-level import
// trick. see #38.
const originalHome = process.env.HOME
let fakeHome: string

beforeAll(() => {
	fakeHome = mkdtempSync(join(tmpdir(), 'atlas-registry-home-'))
	process.env.HOME = fakeHome
})

afterAll(() => {
	process.env.HOME = originalHome
	if (fakeHome) rmSync(fakeHome, { recursive: true, force: true })
})

describe('registry active project', () => {
	beforeEach(() => {
		const dir = join(fakeHome, '.atlas')
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
		mkdirSync(dir, { recursive: true })
		// seed a couple of fake projects
		const regPath = join(dir, 'registry.json')
		writeFileSync(
			regPath,
			JSON.stringify({
				projects: [
					{ id: 'alpha', name: 'alpha', root: '/tmp/alpha', db: '/tmp/alpha/.atlas/atlas.db' },
					{ id: 'beta', name: 'beta', root: '/tmp/beta', db: '/tmp/beta/.atlas/atlas.db' },
				],
				links: [],
			}),
		)
	})

	afterEach(() => {
		rmSync(join(fakeHome, '.atlas'), { recursive: true, force: true })
	})

	test('getActiveProject returns null when no active set', () => {
		expect(registry.getActiveProject()).toBeNull()
	})

	test('setActiveProject("alpha") returns the entry and persists', () => {
		const result = registry.setActiveProject('alpha')
		expect(result).not.toBeNull()
		expect(result!.id).toBe('alpha')
		expect(registry.getActiveProject()).toBe('alpha')
	})

	test('setActiveProject(null) clears the active id', () => {
		registry.setActiveProject('alpha')
		expect(registry.getActiveProject()).toBe('alpha')
		registry.setActiveProject(null)
		expect(registry.getActiveProject()).toBeNull()
	})

	test('setActiveProject rejects unknown ids', () => {
		expect(() => registry.setActiveProject('unknown')).toThrow(
			/no project with id "unknown"/,
		)
	})

	test('setActiveProject survives a round-trip through readRegistry', () => {
		registry.setActiveProject('beta')
		const raw = JSON.parse(
			readFileSync(join(fakeHome, '.atlas', 'registry.json'), 'utf-8'),
		)
		expect(raw.active).toBe('beta')
	})
})

// covers #8 prerequisite: two different repos whose basenames slugify to
// the same string used to alias to a single engine in the engine pool,
// silently corrupting any multi-project query. the registry now detects
// the collision and disambiguates the second id with a short hash of the
// absolute root.
//
// with the lazy HOME read from #38, we can freely swap process.env.HOME
// inside beforeEach without a top-level await import trick — the
// registry module reads HOME on every call.
describe('registry project-id collision', () => {
	let collisionHome: string

	beforeEach(() => {
		collisionHome = mkdtempSync(join(tmpdir(), 'atlas-registry-collision-'))
		process.env.HOME = collisionHome
	})

	afterEach(() => {
		process.env.HOME = fakeHome
		rmSync(collisionHome, { recursive: true, force: true })
	})

	test('first project at a basename gets the plain slug', () => {
		const workRoot = mkdtempSync(join(tmpdir(), 'work-api-parent-'))
		try {
			mkdirSync(join(workRoot, 'api'), { recursive: true })
			const entry = registry.addProject(join(workRoot, 'api'))
			expect(entry.id).toBe('api')
		} finally {
			rmSync(workRoot, { recursive: true, force: true })
		}
	})

	test('second project with the same basename gets a hash suffix', () => {
		const workRoot = mkdtempSync(join(tmpdir(), 'work-parent-'))
		const personalRoot = mkdtempSync(join(tmpdir(), 'personal-parent-'))
		try {
			mkdirSync(join(workRoot, 'api'), { recursive: true })
			mkdirSync(join(personalRoot, 'api'), { recursive: true })
			const first = registry.addProject(join(workRoot, 'api'))
			const second = registry.addProject(join(personalRoot, 'api'))
			expect(first.id).toBe('api')
			expect(second.id).not.toBe('api')
			expect(second.id.startsWith('api-')).toBe(true)
			expect(second.id.length).toBeGreaterThan('api-'.length)
		} finally {
			rmSync(workRoot, { recursive: true, force: true })
			rmSync(personalRoot, { recursive: true, force: true })
		}
	})

	test('re-registering the same root returns the original id unchanged', () => {
		const root = mkdtempSync(join(tmpdir(), 'same-repo-parent-'))
		try {
			mkdirSync(join(root, 'api'), { recursive: true })
			const first = registry.addProject(join(root, 'api'))
			const again = registry.addProject(join(root, 'api'))
			expect(again.id).toBe(first.id)
			expect(registry.listProjects().length).toBe(1)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

