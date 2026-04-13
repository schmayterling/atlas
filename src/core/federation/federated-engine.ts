import type { AtlasEngine } from '../engine.js'
import { getOrCreateEngine } from '../engine-pool.js'
import { getActiveProject, getProjectLinks, getProject, listProjects, type ProjectEntry } from '../registry.js'
import { log } from '../../shared/logger.js'

// federation core for #32. exposes a small set of helpers used by
// every federated cli command (deps, blast, trace, dead-code,
// search semantic). intentionally NOT a class — speculative
// abstraction is hard to justify when the consumers are six cli
// commands and one mcp tool. prefer plain functions until a second
// abstraction consumer appears.
//
// scope:
//   - resolve the set of projects to fan out across (--all-projects,
//     --linked, or an explicit project list)
//   - anchor a starting symbol in a single project so cross-project
//     traversal has a fixed root (deps, blast, trace all need this)
//   - walk cross_project_edges from the anchor and call back into the
//     remote project's engine. the BFS itself stays inside each
//     project's loadSubgraph; we only stitch results across boundaries
//     at the federation layer.

export interface FederationOpts {
	allProjects?: boolean
	linked?: boolean
	// the cli `-p <project>` value, used to anchor commands like deps
	// and blast that need a single starting project. for trace, the
	// caller supplies fromProject + toProject directly, so this is
	// optional in that flow.
	anchorProjectId?: string
}

// resolves the project list a federated query should fan out across.
// honors --all-projects (every registered project), --linked (only
// projects reachable via the linkProjects graph from the active
// project), or returns just the one project when neither flag is set.
export function resolveProjects(opts: FederationOpts): ProjectEntry[] {
	const all = listProjects()
	if (all.length === 0) return []
	if (opts.linked) {
		return linkedProjectSet(all)
	}
	if (opts.allProjects) {
		return all
	}
	if (opts.anchorProjectId) {
		const anchor = getProject(opts.anchorProjectId)
		return anchor ? [anchor] : []
	}
	return []
}

// resolves an anchor symbol in a single project. used by deps, blast,
// and any other command that needs to start from one stable_id and
// walk outward. fails loudly when the symbol is ambiguous across
// projects so the user sees a clear error instead of a guess.
export function anchorSymbol(
	engine: AtlasEngine,
	query: string,
): { stableId: string; name: string } | null {
	const store = engine.getStoreForCrossProject()
	const sym = store.resolveSymbol(query)
	if (!sym) return null
	return { stableId: sym.stableId, name: sym.name }
}

// fans out across cross_project_edges from a single anchor. for each
// outbound edge to project X, calls the per-project callback with the
// remote engine and the remote stable_id. the callback runs whatever
// per-project query is appropriate (deps, blast, search). caller is
// responsible for merging.
//
// direction='outbound' walks "things this anchor depends on" across
// projects. direction='inbound' walks "things that depend on this
// anchor" across projects. both is the union.
export function fanOutDownstream<T>(
	anchorEngine: AtlasEngine,
	anchorProjectId: string,
	anchorStableId: string,
	direction: 'outbound' | 'inbound' | 'both',
	fn: (remoteEngine: AtlasEngine, remoteProject: ProjectEntry, remoteStableId: string) => T,
): Array<{ project: string; result: T }> {
	// use the stable_id-keyed lookup so we don't pay a resolveSymbol
	// round-trip on the anchor side; callers passed a stable id directly
	// from anchorSymbol().
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
				out.push({ project: remoteProject.id, result: fn(remoteEngine, remoteProject, stableId) })
			} catch (e) {
				log.warn(`federation: cross-project hop into "${project}" failed: ${e}`)
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
// global ordering by distance ascending. the original per-project
// loop returned top-N per project concatenated, which is wrong when
// the user wants the N globally-best matches. see #32.
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

// restricts a project list to the connected-component reachable via
// linkProjects from the active project. lifted out of search.ts:220
// so all federated commands share the same definition. falls back to
// the full registry when no active project is set, mirroring the
// cli's default resolution order.
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
