import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { addProject } from '../../src/core/registry.js'
import { closeAll, getOrCreateEngine } from '../../src/core/engine-pool.js'

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
	test('walks a -> b -> c via the cross_project_edges chain', () => {
		const aEngine = getOrCreateEngine(aId, aRoot)
		// start at a::entry, walk two hops to c::leaf
		const entry = aEngine.getStoreForCrossProject().queryRaw<{ stable_id: string }>(
			`SELECT stable_id FROM symbols WHERE name = 'entry'`,
		)[0]

		// BFS by hand (simpler than importing the private helper). walk
		// every outbound cross-project edge, hopping through intermediate
		// projects. verify that c::leaf is reachable within 2 hops.
		const visited = new Set<string>()
		const queue: Array<{ projectId: string; stableId: string; depth: number }> = [
			{ projectId: aId, stableId: entry.stable_id, depth: 0 },
		]
		let reachedLeaf = false
		while (queue.length > 0) {
			const item = queue.shift()!
			if (item.depth >= 3) continue
			const engine = getOrCreateEngine(item.projectId, item.projectId === aId ? aRoot : item.projectId === bId ? bRoot : cRoot)
			const edges = engine.getCrossProjectEdgesByStableId(item.projectId, item.stableId)
			for (const edge of edges.outbound) {
				const key = `${edge.targetProject}|${edge.targetStableId}`
				if (visited.has(key)) continue
				visited.add(key)
				if (edge.targetProject === cId) reachedLeaf = true
				queue.push({ projectId: edge.targetProject, stableId: edge.targetStableId, depth: item.depth + 1 })
			}
		}
		expect(reachedLeaf).toBe(true)
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
