import type { AtlasEngine } from '../engine.js'
import { getOrCreateEngine } from '../engine-pool.js'
import { getActiveProject, getProjectLinks, getProject, type ProjectEntry } from '../registry.js'
import { log } from '../../shared/logger.js'

// federation core: a handful of plain functions used by every
// federated cli command (deps, blast, trace, dead-code, search
// semantic). intentionally NOT a class. single-consumer abstraction
// isn't justified until a second consumer appears.
//
// scope:
//   - anchor a starting symbol in a single project so cross-project
//     traversal has a fixed root (deps, blast, trace all need this)
//   - walk cross_project_edges from the anchor and call back into the
//     remote project's engine. the BFS itself stays inside each
//     project's loadSubgraph; we only stitch results across boundaries
//     at the federation layer.
//   - merge per-project semantic search results into a single global
//     distance-sorted list.
//   - restrict a project list to the connected component reachable
//     via linkProjects from the active project (--linked).

// resolves an anchor symbol in a single project. goes through
// engine.resolveSymbolIdentity so CLI/federation stays on the engine
// api surface (CLI/MCP/web never reach into store.ts directly).
export function anchorSymbol(
	engine: AtlasEngine,
	query: string,
): { stableId: string; name: string } | null {
	return engine.resolveSymbolIdentity(query)
}

// fans out across cross_project_edges from a single anchor. for each
// outbound edge to project X, calls the per-project callback with
// the remote engine and the remote stable_id. the callback runs
// whatever per-project query is appropriate (deps, blast, trace).
// caller is responsible for merging.
//
// direction='outbound' walks "things this anchor depends on" across
// projects. direction='inbound' walks "things that depend on this
// anchor" across projects. 'both' is the union.
export function fanOutDownstream<T>(
	anchorEngine: AtlasEngine,
	anchorProjectId: string,
	anchorStableId: string,
	direction: 'outbound' | 'inbound' | 'both',
	fn: (remoteEngine: AtlasEngine, remoteStableId: string) => T,
): Array<{ project: string; result: T }> {
	const xEdges = anchorEngine.getCrossProjectEdgesByStableId(anchorProjectId, anchorStableId)
	const seen = new Set<string>()
	const out: Array<{ project: string; result: T }> = []

	const walk = (
		edges: Array<{ targetProject?: string; targetStableId?: string; sourceProject?: string; sourceStableId?: string; kind: string }>,
		field: 'target' | 'source',
	) => {
		for (const edge of edges) {
			const project = field === 'target' ? edge.targetProject : edge.sourceProject
			const stableId = field === 'target' ? edge.targetStableId : edge.sourceStableId
			if (!project || !stableId) continue
			const dedup = `${project}|${stableId}`
			if (seen.has(dedup)) continue
			seen.add(dedup)
			const remoteProject = getProject(project)
			if (!remoteProject) {
				log.debug(`federation: cross_project_edges row references unknown project "${project}"`)
				continue
			}
			try {
				const remoteEngine = getOrCreateEngine(remoteProject.id, remoteProject.root)
				out.push({ project: remoteProject.id, result: fn(remoteEngine, stableId) })
			} catch (e) {
				log.warn(
					`federation: hop from ${anchorProjectId}::${anchorStableId} into ${project}::${stableId} failed: ${
						e instanceof Error ? e.stack : e
					}`,
				)
			}
		}
	}

	if (direction === 'outbound' || direction === 'both') {
		walk(xEdges.outbound, 'target')
	}
	if (direction === 'inbound' || direction === 'both') {
		walk(xEdges.inbound, 'source')
	}

	return out
}

// merges a list of per-project semantic search results into a single
// global ordering by distance ascending. the per-project loop
// returns top-N per project concatenated, which is wrong when the
// user wants the N globally-best matches.
export function mergeSemanticResults<T extends { distance: number }>(
	perProject: Array<{ project: string; results: T[] }>,
	limit: number,
): Array<T & { project: string }> {
	const merged: Array<T & { project: string }> = []
	for (const block of perProject) {
		for (const r of block.results) {
			merged.push({ ...r, project: block.project })
		}
	}
	merged.sort((a, b) => a.distance - b.distance)
	return merged.slice(0, limit)
}

// boundary-hop entry for (possibly multi-hop) cross-project paths.
// `boundaryChain` lists every cross_project_edges row walked from the
// source anchor to `landingStableId` inside the destination project,
// ordered source → dest. a direct hop has one entry in the chain.
export interface BoundaryHop {
	landingStableId: string
	boundaryChain: Array<{
		sourceProject: string
		sourceStableId: string
		targetProject: string
		targetStableId: string
		kind: string
	}>
}

// BFS over the meta-graph of cross_project_edges. at each node we take
// its outbound cross-project edges via the remote project's engine and
// enqueue the landing point. the search records every distinct landing
// in toProject under the hop cap, so two different edges from different
// intermediate projects both surface. we track landings in their own
// dedupe set so each (landing_project, landing_stable_id) pair is
// recorded at most once (prevents exponential blowup when toProject
// also appears as an intermediate hop in cycles). intermediate nodes
// are deduped in `visited` to keep cycles bounded. maxHops is the
// number of cross_project_edges walked (hop=1 direct, hop=2 one
// intermediate, etc.). see #72 + deep-review.
export function findCrossProjectBoundaries(
	fromEngine: AtlasEngine,
	fromProjectId: string,
	fromStableId: string,
	toProjectId: string,
	maxHops: number,
): BoundaryHop[] {
	if (fromProjectId === toProjectId) {
		// nothing to walk: same-project trace is handled by the caller
		// without crossing any boundary. bail early rather than mining
		// self-referencing cross_project_edges rows, which would be a
		// misleading result.
		return []
	}

	type QueueItem = {
		engine: AtlasEngine
		projectId: string
		stableId: string
		chain: BoundaryHop['boundaryChain']
	}
	const hops: BoundaryHop[] = []
	const visited = new Set<string>()
	const landingSeen = new Set<string>()
	const queue: QueueItem[] = [
		{ engine: fromEngine, projectId: fromProjectId, stableId: fromStableId, chain: [] },
	]
	visited.add(`${fromProjectId}|${fromStableId}`)

	while (queue.length > 0) {
		const item = queue.shift()!
		if (item.chain.length >= maxHops) continue
		const edges = item.engine.getCrossProjectEdgesOutbound(item.projectId, item.stableId)
		for (const edge of edges) {
			const nextChain = [
				...item.chain,
				{
					sourceProject: item.projectId,
					sourceStableId: item.stableId,
					targetProject: edge.targetProject,
					targetStableId: edge.targetStableId,
					kind: edge.kind,
				},
			]
			if (edge.targetProject === toProjectId) {
				// record each distinct landing in toProject once. this
				// prevents an exponential blowup when toProject appears
				// as an intermediate hop in a cycle.
				const landingKey = `${edge.targetProject}|${edge.targetStableId}`
				if (landingSeen.has(landingKey)) continue
				landingSeen.add(landingKey)
				hops.push({ landingStableId: edge.targetStableId, boundaryChain: nextChain })
				continue
			}
			const key = `${edge.targetProject}|${edge.targetStableId}`
			if (visited.has(key)) continue
			visited.add(key)
			const nextProject = getProject(edge.targetProject)
			if (!nextProject) {
				log.debug(
					`findCrossProjectBoundaries: edge references unknown project "${edge.targetProject}", skipping subtree`,
				)
				continue
			}
			let nextEngine: AtlasEngine
			try {
				nextEngine = getOrCreateEngine(nextProject.id, nextProject.root)
			} catch (e) {
				log.warn(
					`findCrossProjectBoundaries: failed to open engine for "${nextProject.id}": ${e instanceof Error ? e.message : e}`,
				)
				continue
			}
			queue.push({
				engine: nextEngine,
				projectId: nextProject.id,
				stableId: edge.targetStableId,
				chain: nextChain,
			})
		}
	}

	return hops
}

// restricts a project list to the connected component reachable via
// linkProjects from the active project. lifted out of search.ts so
// all federated commands share the same definition. falls back to
// the full registry when no active project is set.
export function linkedProjectSet(allProjects: ProjectEntry[]): ProjectEntry[] {
	const rootId = getActiveProject()
	if (!rootId) return allProjects
	const links = getProjectLinks()
	const adj = new Map<string, Set<string>>()
	for (const link of links) {
		if (!adj.has(link.from)) adj.set(link.from, new Set())
		if (!adj.has(link.to)) adj.set(link.to, new Set())
		adj.get(link.from)!.add(link.to)
		adj.get(link.to)!.add(link.from)
	}
	const visited = new Set<string>([rootId])
	const queue = [rootId]
	while (queue.length > 0) {
		const id = queue.shift()!
		const neighbours = adj.get(id)
		if (!neighbours) continue
		for (const next of neighbours) {
			if (visited.has(next)) continue
			visited.add(next)
			queue.push(next)
		}
	}
	return allProjects.filter((p) => visited.has(p.id))
}
