import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { addProject, linkProjects } from '../../src/core/registry.js'
import { closeAll, getOrCreateEngine } from '../../src/core/engine-pool.js'
import {
	anchorSymbol,
	fanOutDownstream,
	linkedProjectSet,
	mergeSemanticResults,
} from '../../src/core/federation/federated-engine.js'
import { listProjects } from '../../src/core/registry.js'
import { buildCrossProjectEdgesBySymbolName } from '../../src/core/queries/symbol-name-linker.js'

// covers #32: the federation core helpers used by deps/blast/trace/
// dead-code/semantic-search. tests are scoped to the helpers
// themselves rather than the cli formatters because formatter assert
// would couple the test to terminal layout. cli paths are exercised
// in-process indirectly via the helper composition.

let registryHome: string
const originalHome = process.env.HOME

let alphaRoot: string
let alphaId: string
let betaRoot: string
let betaId: string

beforeAll(async () => {
	registryHome = mkdtempSync(join(tmpdir(), 'atlas-fed-fan-'))
	process.env.HOME = registryHome

	const alphaParent = mkdtempSync(join(tmpdir(), 'atlas-fed-alpha-'))
	const betaParent = mkdtempSync(join(tmpdir(), 'atlas-fed-beta-'))
	alphaRoot = join(alphaParent, 'alpha')
	betaRoot = join(betaParent, 'beta')
	mkdirSync(alphaRoot, { recursive: true })
	mkdirSync(betaRoot, { recursive: true })

	// both projects export `processOrder` so the symbol-name linker can
	// match across them. each project also has a unique helper so we
	// can verify the cross-project hop produces real output without
	// relying on api-route extraction.
	writeFileSync(
		join(alphaRoot, 'service.ts'),
		`export function processOrder(id: string): string {
	return 'alpha-' + id
}
export function alphaHelper(): string {
	return 'a'
}
`,
	)
	writeFileSync(
		join(betaRoot, 'service.ts'),
		`export function processOrder(id: string): string {
	return 'beta-' + id
}
export function betaHelper(): string {
	return 'b'
}
`,
	)

	const alpha = addProject(alphaRoot)
	const beta = addProject(betaRoot)
	alphaId = alpha.id
	betaId = beta.id
	linkProjects(alphaId, betaId)

	const alphaEngine = getOrCreateEngine(alphaId, alphaRoot)
	const betaEngine = getOrCreateEngine(betaId, betaRoot)
	await alphaEngine.index({ noEmbed: true, noSummarize: true, force: true })
	await betaEngine.index({ noEmbed: true, noSummarize: true, force: true })

	// seed cross_project_edges so fanOutDownstream has something to walk.
	// the symbol-name linker handles this when --match-by-name is set.
	const alphaStore = alphaEngine.getStoreForCrossProject()
	const betaStore = betaEngine.getStoreForCrossProject()
	alphaEngine.clearCrossProjectEdges()
	betaEngine.clearCrossProjectEdges()
	buildCrossProjectEdgesBySymbolName(alphaStore, alphaId, betaStore, betaId)
})

afterAll(() => {
	closeAll()
	process.env.HOME = originalHome
	rmSync(registryHome, { recursive: true, force: true })
	rmSync(alphaRoot, { recursive: true, force: true })
	rmSync(betaRoot, { recursive: true, force: true })
})

describe('federation core helpers', () => {
	test('linkedProjectSet returns every registered project when no active id is set', () => {
		const projects = linkedProjectSet(listProjects())
		const ids = projects.map((p) => p.id).sort()
		expect(ids).toEqual([alphaId, betaId].sort())
	})

	test('anchorSymbol resolves a known export to a stable id', () => {
		const alphaEngine = getOrCreateEngine(alphaId, alphaRoot)
		const anchor = anchorSymbol(alphaEngine, 'processOrder')
		expect(anchor).not.toBeNull()
		expect(anchor!.name).toBe('processOrder')
		expect(anchor!.stableId.length).toBeGreaterThan(0)
	})

	test('anchorSymbol returns null for an unknown name', () => {
		const alphaEngine = getOrCreateEngine(alphaId, alphaRoot)
		expect(anchorSymbol(alphaEngine, 'definitelyNotASymbol')).toBeNull()
	})

	test('fanOutDownstream walks cross_project_edges from anchor', () => {
		const alphaEngine = getOrCreateEngine(alphaId, alphaRoot)
		const anchor = anchorSymbol(alphaEngine, 'processOrder')
		expect(anchor).not.toBeNull()

		// double-check the symbol-name linker actually wrote rows for
		// our exports; if it didn't, the rest of this test is moot
		const alphaStore = alphaEngine.getStoreForCrossProject()
		const xRows = alphaStore.queryRaw<{ n: number }>(
			'SELECT COUNT(*) AS n FROM cross_project_edges',
		)
		expect(xRows[0].n).toBeGreaterThan(0)

		const out = fanOutDownstream(
			alphaEngine,
			alphaId,
			anchor!.stableId,
			'both',
			(_remoteEngine, remoteStableId) => ({ remoteStableId }),
		)
		// the symbol-name linker created a name_match edge between the
		// two `processOrder` exports so the fan-out should hit beta
		// with at least one result.
		expect(out.length).toBeGreaterThan(0)
		const projects = out.map((r) => r.project)
		expect(projects).toContain(betaId)
	})

	test('mergeSemanticResults sorts globally by distance', () => {
		const merged = mergeSemanticResults(
			[
				{
					project: 'alpha',
					results: [
						{ distance: 0.5, name: 'a1' } as any,
						{ distance: 0.9, name: 'a2' } as any,
					],
				},
				{
					project: 'beta',
					results: [
						{ distance: 0.1, name: 'b1' } as any,
						{ distance: 0.7, name: 'b2' } as any,
					],
				},
			],
			3,
		)
		expect(merged.length).toBe(3)
		expect(merged[0].distance).toBeLessThan(merged[1].distance)
		expect(merged[1].distance).toBeLessThan(merged[2].distance)
	})
})
