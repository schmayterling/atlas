import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { addProject } from '../../src/core/registry.js'
import { closeAll, getOrCreateEngine } from '../../src/core/engine-pool.js'
import { findCrossProjectBoundaries } from '../../src/core/federation/federated-engine.js'

// covers #72: multi-hop cross-project trace. three projects a -> b -> c,
// each with an api boundary crossing, exercise the BFS in
// cli/commands/trace.ts::findCrossProjectBoundaries. we don't execute
// the cli command here (that would couple the test to terminal
// output); instead we reconstruct the BFS inline to validate behavior.

let registryHome: string
const originalHome = process.env.HOME

let aRoot: string
let bRoot: string
let cRoot: string
let aId: string
let bId: string
let cId: string

beforeAll(async () => {
	registryHome = mkdtempSync(join(tmpdir(), 'atlas-trace-multi-hop-'))
	process.env.HOME = registryHome

	const aParent = mkdtempSync(join(tmpdir(), 'atlas-mh-a-'))
	const bParent = mkdtempSync(join(tmpdir(), 'atlas-mh-b-'))
	const cParent = mkdtempSync(join(tmpdir(), 'atlas-mh-c-'))
	aRoot = join(aParent, 'a')
	bRoot = join(bParent, 'b')
	cRoot = join(cParent, 'c')
	mkdirSync(aRoot, { recursive: true })
	mkdirSync(bRoot, { recursive: true })
	mkdirSync(cRoot, { recursive: true })

	writeFileSync(
		join(aRoot, 'entry.ts'),
		`export function entry() { return 'entry' }
export function alphaHop() { return 'alpha' }
`,
	)
	writeFileSync(
		join(bRoot, 'middle.ts'),
		`export function middle() { return 'middle' }
`,
	)
	writeFileSync(
		join(cRoot, 'leaf.ts'),
		`export function leaf() { return 'leaf' }
`,
	)

	aId = addProject(aRoot).id
	bId = addProject(bRoot).id
	cId = addProject(cRoot).id

	const aEngine = getOrCreateEngine(aId, aRoot)
	const bEngine = getOrCreateEngine(bId, bRoot)
	const cEngine = getOrCreateEngine(cId, cRoot)
	await aEngine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false })
	await bEngine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false })
	await cEngine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false })

	// seed cross_project_edges: a::entry -> b::middle, b::middle -> c::leaf.
	// direct SQL insert bypasses the matchers because we just need the
	// graph shape for BFS.
	const aStore = aEngine.getStoreForCrossProject()
	const bStore = bEngine.getStoreForCrossProject()
	const entry = aStore.queryRaw<{ stable_id: string }>(
		`SELECT stable_id FROM symbols WHERE name = 'entry'`,
	)[0]
	const middle = bStore.queryRaw<{ stable_id: string }>(
		`SELECT stable_id FROM symbols WHERE name = 'middle'`,
	)[0]
	const leaf = cEngine.getStoreForCrossProject().queryRaw<{ stable_id: string }>(
		`SELECT stable_id FROM symbols WHERE name = 'leaf'`,
	)[0]
	aStore.queryRawWithParams(
		`INSERT OR IGNORE INTO cross_project_edges (source_project, source_stable_id, target_project, target_stable_id, kind, confidence) VALUES (?, ?, ?, ?, 'api', 'heuristic')`,
		aId, entry.stable_id, bId, middle.stable_id,
	)
	bStore.queryRawWithParams(
		`INSERT OR IGNORE INTO cross_project_edges (source_project, source_stable_id, target_project, target_stable_id, kind, confidence) VALUES (?, ?, ?, ?, 'api', 'heuristic')`,
		bId, middle.stable_id, cId, leaf.stable_id,
	)
})

afterAll(() => {
	closeAll()
	process.env.HOME = originalHome
	rmSync(registryHome, { recursive: true, force: true })
	rmSync(aRoot, { recursive: true, force: true })
	rmSync(bRoot, { recursive: true, force: true })
	rmSync(cRoot, { recursive: true, force: true })
})

describe('multi-hop cross-project trace (#72)', () => {
	test('findCrossProjectBoundaries walks a -> b -> c via the cross_project_edges chain', () => {
		const aEngine = getOrCreateEngine(aId, aRoot)
		const entry = aEngine.getStoreForCrossProject().queryRaw<{ stable_id: string }>(
			`SELECT stable_id FROM symbols WHERE name = 'entry'`,
		)[0]
		// exercise the production helper rather than re-implementing a
		// parallel BFS in the test. the helper is what the trace cli
		// actually calls, so regressions in BFS semantics (visited set,
		// hop cap, terminal landing collection) surface here.
		const hops = findCrossProjectBoundaries(aEngine, aId, entry.stable_id, cId, 3)
		expect(hops.length).toBeGreaterThan(0)
		const landingProjects = hops.map((h) => h.boundaryChain[h.boundaryChain.length - 1].targetProject)
		expect(landingProjects).toContain(cId)
		const leaf = hops[0]
		expect(leaf.boundaryChain.length).toBe(2)
		expect(leaf.boundaryChain[0].targetProject).toBe(bId)
		expect(leaf.boundaryChain[1].targetProject).toBe(cId)
	})

	test('hop cap is respected (maxHops=1 blocks the a -> b -> c chain)', () => {
		const aEngine = getOrCreateEngine(aId, aRoot)
		const entry = aEngine.getStoreForCrossProject().queryRaw<{ stable_id: string }>(
			`SELECT stable_id FROM symbols WHERE name = 'entry'`,
		)[0]
		// direct a -> c edge does not exist; only a -> b and b -> c do,
		// so a single hop must find nothing landing in cId.
		const hops = findCrossProjectBoundaries(aEngine, aId, entry.stable_id, cId, 1)
		expect(hops.length).toBe(0)
	})

	test('direct single-hop edges from a still work (no regression)', () => {
		const aEngine = getOrCreateEngine(aId, aRoot)
		const entry = aEngine.getStoreForCrossProject().queryRaw<{ stable_id: string }>(
			`SELECT stable_id FROM symbols WHERE name = 'entry'`,
		)[0]
		const edges = aEngine.getCrossProjectEdgesByStableId(aId, entry.stable_id)
		expect(edges.outbound.some((e) => e.targetProject === bId)).toBe(true)
	})
})
