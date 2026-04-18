import { join } from 'node:path'
import type { Scenario } from '../../run.js'
import { setupScenario, resolveStableId } from '../../harness.js'
import { findCrossProjectBoundaries } from '../../../src/core/federation/federated-engine.js'

// three-project chain a -> b -> c with an extra c -> a back-edge to
// exercise cycle handling in findCrossProjectBoundaries. seeds the
// cross_project_edges directly so the scenario does not depend on the
// symbol-name or api-route linkers; those have their own integration
// tests. see #83.
const scenario: Scenario = {
	name: 'federation-chain',
	description: 'a->b->c boundary walk with back-edge cycle',
	timeBudgetMs: 30_000,
	async run(ctx) {
		const here = ctx.scenarioDir
		const { projects, teardown } = await setupScenario(
			ctx.tmpRoot,
			[
				{ name: 'a', sourceDir: join(here, 'project-a') },
				{ name: 'b', sourceDir: join(here, 'project-b') },
				{ name: 'c', sourceDir: join(here, 'project-c') },
			],
			{ linkPairs: [['a', 'b'], ['b', 'c'], ['a', 'c']] },
		)
		try {
			const [a, b, c] = projects
			const entryId = resolveStableId(a.engine, 'entry')
			const invokeMiddleId = resolveStableId(a.engine, 'invokeMiddle')
			const middleId = resolveStableId(b.engine, 'middle')
			const invokeLeafId = resolveStableId(b.engine, 'invokeLeaf')
			const leafId = resolveStableId(c.engine, 'leaf')
			const backToAId = resolveStableId(c.engine, 'backToA')

			// seed a chain of cross_project_edges so BFS walks
			// (a, invokeMiddle) -> (b, middle) -> (c, leaf). the landing
			// stable_id at each hop is also the source of the next edge
			// written in the next project's db so getCrossProjectEdges-
			// Outbound on that db returns something. a c -> a back-edge
			// from backToA to entry exercises cycle handling, and the
			// remaining invokeLeaf / entry ids are asserted as loaded so
			// the scenario fails loudly if tree-sitter drops an export.
			void invokeLeafId
			void entryId
			a.engine.getStoreForCrossProject().insertCrossProjectEdge({
				sourceProject: a.id,
				sourceStableId: invokeMiddleId,
				targetProject: b.id,
				targetStableId: middleId,
				kind: 'name_match',
				confidence: 'heuristic',
			})
			b.engine.getStoreForCrossProject().insertCrossProjectEdge({
				sourceProject: b.id,
				sourceStableId: middleId,
				targetProject: c.id,
				targetStableId: leafId,
				kind: 'name_match',
				confidence: 'heuristic',
			})
			c.engine.getStoreForCrossProject().insertCrossProjectEdge({
				sourceProject: c.id,
				sourceStableId: backToAId,
				targetProject: a.id,
				targetStableId: entryId,
				kind: 'name_match',
				confidence: 'heuristic',
			})

			const hops3 = findCrossProjectBoundaries(a.engine, a.id, invokeMiddleId, c.id, 3)
			const hops1 = findCrossProjectBoundaries(a.engine, a.id, invokeMiddleId, c.id, 1)

			return {
				queries: {
					// normalize the project ids to their bench names so the
					// snapshot doesn't depend on the 16-hex content-addressed
					// id that addProject computes from the absolute path.
					boundariesHops3: hops3.map((h) => normalize(h, projects)),
					boundariesHops1: hops1.map((h) => normalize(h, projects)),
					boundaryCountHops3: hops3.length,
					boundaryCountHops1: hops1.length,
				},
			}
		} finally {
			teardown()
		}
	},
}

function normalize(
	hop: { landingStableId: string; boundaryChain: Array<{ sourceProject: string; targetProject: string; kind: string }> },
	projects: Array<{ name: string; id: string }>,
) {
	const idToName = new Map(projects.map((p) => [p.id, p.name]))
	return {
		landingStableIdType: typeof hop.landingStableId,
		chain: hop.boundaryChain.map((c) => ({
			source: idToName.get(c.sourceProject) ?? c.sourceProject,
			target: idToName.get(c.targetProject) ?? c.targetProject,
			kind: c.kind,
		})),
	}
}

export default scenario
