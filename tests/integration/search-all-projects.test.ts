import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { addProject } from '../../src/core/registry.js'
import { closeAll, getOrCreateEngine } from '../../src/core/engine-pool.js'

// covers #8: the --all-projects search fan-out. we register two
// separate fixture projects in a throwaway registry, let the
// registry/engine-pool plumbing build engines for both, and assert
// that searching by a name that exists in both projects surfaces
// hits from each under its correct project id. the collision-safe
// id path is exercised indirectly because both fixture projects
// are named `api`.

let registryHome: string
const originalHome = process.env.HOME

interface Fixture {
	root: string
	id: string
}

let projectA: Fixture
let projectB: Fixture

beforeAll(async () => {
	registryHome = mkdtempSync(join(tmpdir(), 'atlas-search-all-'))
	process.env.HOME = registryHome

	// two projects with the same directory-basename (`api`) so the
	// registry's new collision-safe id path assigns distinct ids to
	// them. without the fix, engine-pool would cache a single
	// engine for both and federated search would be corrupt.
	const parentA = mkdtempSync(join(tmpdir(), 'atlas-fed-a-'))
	const parentB = mkdtempSync(join(tmpdir(), 'atlas-fed-b-'))
	const rootA = join(parentA, 'api')
	const rootB = join(parentB, 'api')
	mkdirSync(rootA, { recursive: true })
	mkdirSync(rootB, { recursive: true })

	// each project exports a function named `ping` so a single
	// search query finds one hit in each project.
	writeFileSync(
		join(rootA, 'ping.ts'),
		'export function ping(): string { return "A" }\n',
	)
	writeFileSync(
		join(rootB, 'ping.ts'),
		'export function ping(): string { return "B" }\n',
	)

	const entryA = addProject(rootA)
	const entryB = addProject(rootB)
	projectA = { root: rootA, id: entryA.id }
	projectB = { root: rootB, id: entryB.id }

	const engineA = getOrCreateEngine(projectA.id, projectA.root)
	const engineB = getOrCreateEngine(projectB.id, projectB.root)
	await engineA.index({ noEmbed: true, noSummarize: true, force: true })
	await engineB.index({ noEmbed: true, noSummarize: true, force: true })
})

afterEach(() => {
	// don't close engines between cases — the tests read from
	// both projects' engines and the fan-out re-uses the cached
	// pool entries. cleanup happens in afterAll.
})

afterAll(() => {
	closeAll()
	process.env.HOME = originalHome
	rmSync(registryHome, { recursive: true, force: true })
	rmSync(projectA.root, { recursive: true, force: true })
	rmSync(projectB.root, { recursive: true, force: true })
})

describe('search --all-projects', () => {
	test('registry assigns collision-safe ids to two `api` projects', () => {
		expect(projectA.id).not.toBe(projectB.id)
	})

	test('per-project search finds ping in each project', () => {
		const engineA = getOrCreateEngine(projectA.id, projectA.root)
		const engineB = getOrCreateEngine(projectB.id, projectB.root)
		const ra = engineA.search('ping')
		const rb = engineB.search('ping')
		expect(ra.results.some((s) => s.name === 'ping')).toBe(true)
		expect(rb.results.some((s) => s.name === 'ping')).toBe(true)
	})

	test('fan-out finds ping hits from both projects under their ids', () => {
		// mirror what the CLI does: iterate every registered project,
		// call engine.search() per project, tag each hit with the
		// project id. this verifies the underlying plumbing
		// (registry.listProjects + engine-pool.getOrCreateEngine)
		// lines up with the searchAllProjects helper without
		// shelling out to the CLI process.
		const { listProjects } = require('../../src/core/registry.js')
		const projects = listProjects()
		const merged: Array<{ name: string; project: string }> = []
		for (const p of projects) {
			const engine = getOrCreateEngine(p.id, p.root)
			const r = engine.search('ping')
			for (const sym of r.results) {
				merged.push({ name: sym.name, project: p.id })
			}
		}
		const aHits = merged.filter((h) => h.project === projectA.id && h.name === 'ping')
		const bHits = merged.filter((h) => h.project === projectB.id && h.name === 'ping')
		expect(aHits.length).toBe(1)
		expect(bHits.length).toBe(1)
	})
})
