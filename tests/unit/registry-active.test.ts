import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// redirect the registry dir away from $HOME/.atlas so tests don't
// mutate the user's real registry. must happen before importing
// registry.js so the module-level const picks up the env var.
const originalHome = process.env.HOME
const fakeHome = mkdtempSync(join(tmpdir(), 'atlas-registry-home-'))
process.env.HOME = fakeHome

const registry = await import('../../src/core/registry.js')

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

// restore HOME so anything else running after this suite doesn't
// get confused.
afterEach(() => {
	process.env.HOME = originalHome
})
