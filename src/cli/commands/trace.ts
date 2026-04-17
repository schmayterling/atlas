import pc from 'picocolors'
import type { AtlasEngine } from '../../core/engine.js'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { anchorSymbol } from '../../core/federation/federated-engine.js'
import { getProject } from '../../core/registry.js'
import { fileRef, heading, outputJson } from '../formatters/common.js'

export function traceCommand(
	projectRoot: string,
	from: string,
	to: string,
	json: boolean,
	opts: { maxPaths?: number; depth?: number; fromProject?: string; toProject?: string },
) {
	if (opts.fromProject || opts.toProject) {
		traceCrossProject(from, to, json, opts)
		return
	}

	const engine = getOrCreateEngine(undefined, projectRoot)

	try {
		const result = engine.trace(from, to, {
			maxPaths: opts.maxPaths,
			maxDepth: opts.depth,
		})

		if (!result) {
			console.error(pc.red(`could not resolve both symbols: "${from}" and "${to}"`))
			process.exit(1)
		}

		if (json) {
			outputJson(result)
			return
		}

		heading(
			`execution paths from ${result.source.name} to ${result.target.name} (${result.stats.totalPaths} found)`,
		)

		if (result.paths.length === 0) {
			console.log(pc.dim('  no paths found'))
			return
		}

		if (result.stats.truncated) {
			console.log(pc.yellow(`  (showing first ${opts.maxPaths ?? 5}, more paths exist)`))
		}

		for (let i = 0; i < result.paths.length; i++) {
			const path = result.paths[i]
			console.log()
			console.log(pc.bold(`path ${i + 1} (${path.length} hops)`))

			for (let j = 0; j < path.nodes.length; j++) {
				const node = path.nodes[j]
				const ref = fileRef(node.filePath, node.lineStart)
				const prefix = j === 0 ? '' : '  -> '
				console.log(`${prefix}${pc.bold(node.name)} ${pc.dim(`(${ref})`)}`)
			}
		}
	} finally {
		engine.close()
	}
}

// cross-project trace: anchor `from` in --from-project and `to` in
// --to-project. fail loudly when only one anchor is provided so the
// user can't accidentally guess the wrong endpoint. stitches local
// outbound paths from `from` against the cross_project_edges between
// the two projects, then runs a separate inbound trace to `to` from
// the matching remote stable_id. caps each leg at 2 hops by default
// to avoid combinatorial blowup. see #32.
function traceCrossProject(
	from: string,
	to: string,
	json: boolean,
	opts: { maxPaths?: number; depth?: number; fromProject?: string; toProject?: string },
) {
	if (!opts.fromProject || !opts.toProject) {
		console.error(
			pc.red(
				'cross-project trace requires both --from-project <id> and --to-project <id>. trace has two endpoints; both must be anchored.',
			),
		)
		process.exit(1)
	}
	if (opts.fromProject === opts.toProject) {
		console.error(
			pc.red(
				`--from-project and --to-project must differ. for a single-project trace, run \`atlas -p <path> trace ${from} ${to}\` without the project flags.`,
			),
		)
		process.exit(1)
	}
	const fromProject = getProject(opts.fromProject)
	const toProject = getProject(opts.toProject)
	if (!fromProject || !toProject) {
		console.error(
			pc.red(
				`unknown project id(s): ${[!fromProject && opts.fromProject, !toProject && opts.toProject]
					.filter(Boolean)
					.join(', ')}`,
			),
		)
		process.exit(1)
	}

	const fromEngine = getOrCreateEngine(fromProject.id, fromProject.root)
	const toEngine = getOrCreateEngine(toProject.id, toProject.root)
	const fromAnchor = anchorSymbol(fromEngine, from)
	if (!fromAnchor) {
		console.error(pc.red(`symbol not found in project "${fromProject.id}": ${from}`))
		process.exit(1)
	}
	const toAnchor = anchorSymbol(toEngine, to)
	if (!toAnchor) {
		console.error(pc.red(`symbol not found in project "${toProject.id}": ${to}`))
		process.exit(1)
	}

	// find every way to reach toProject::toAnchor starting from the
	// from-anchor. direct hops are the simple case (a -> c via one
	// cross_project_edges row). multi-hop searches go through 1+
	// intermediate projects via BFS over cross_project_edges. hop
	// count is capped (default 3) because the meta-graph over cross-
	// project edges can grow quickly, and most real federation paths
	// reach their destination in 1-2 hops. see #72.
	const maxHops = Math.max(1, Math.min(opts.depth ?? 3, 5))
	const matchingHops = findCrossProjectBoundaries(
		fromEngine,
		fromProject.id,
		fromAnchor.stableId,
		toProject.id,
		maxHops,
	)

	const result = {
		fromAnchor: { project: fromProject.id, ...fromAnchor },
		toAnchor: { project: toProject.id, ...toAnchor },
		boundaryHops: matchingHops,
		legs: [] as Array<{ project: string; trace: ReturnType<typeof fromEngine.trace> }>,
	}

	if (matchingHops.length === 0) {
		if (json) {
			outputJson(result)
		} else {
			console.error(
				pc.yellow(
					`no cross_project_edges path from ${pc.cyan(fromProject.id)}::${from} into ${pc.cyan(toProject.id)} within ${maxHops} hops.`,
				),
			)
		}
		return
	}

	// for each boundary hop (possibly multi-hop), run a local trace
	// inside the destination project using stable-id entry points on
	// both ends. name-based resolution would pick the first same-
	// named hit in the to-project, which is wrong when multiple
	// symbols share a name. the hop's landingStableId is the symbol
	// that lands in toProject after the final cross-project edge.
	for (const hop of matchingHops) {
		const trace = toEngine.traceByStableIds(hop.landingStableId, toAnchor.stableId, {
			maxPaths: opts.maxPaths,
			maxDepth: opts.depth ?? 5,
		})
		if (trace) result.legs.push({ project: toProject.id, trace })
	}

	if (json) {
		outputJson(result)
		return
	}

	heading(
		`${pc.magenta(`[${fromProject.id}]`)} ${from} → ${pc.magenta(`[${toProject.id}]`)} ${to}`,
	)
	console.log()
	console.log(pc.bold(`${matchingHops.length} boundary hop${matchingHops.length === 1 ? '' : 's'}`))
	for (const leg of result.legs) {
		// `trace` is non-null here: the upstream loop only pushes legs
		// when traceByStableIds returned a result.
		const trace = leg.trace!
		if (trace.paths.length === 0) {
			console.log(pc.dim('  no path through this boundary hop'))
			continue
		}
		for (let i = 0; i < trace.paths.length; i++) {
			const path = trace.paths[i]
			console.log()
			console.log(pc.bold(`leg ${i + 1} (${path.length} hops)`))
			for (let j = 0; j < path.nodes.length; j++) {
				const node = path.nodes[j]
				const ref = fileRef(node.filePath, node.lineStart)
				const prefix = j === 0 ? '' : '  -> '
				console.log(`${prefix}${pc.bold(node.name)} ${pc.dim(`(${ref})`)}`)
			}
		}
	}
}

// boundary-hop entry for (possibly multi-hop) cross-project paths.
// `boundaryChain` lists every cross_project_edges row walked from the
// from-anchor to `landingStableId` in toProject, ordered source → dest.
// a direct hop has one entry in the chain.
interface BoundaryHop {
	landingStableId: string
	boundaryChain: Array<{
		sourceProject: string
		sourceStableId: string
		targetProject: string
		targetStableId: string
		kind: string
	}>
}

// BFS over the meta-graph of cross_project_edges. each queue entry
// is a (project, stableId, chain-so-far) triple. at every node we
// take its outbound cross-project edges via the remote project's
// engine and enqueue the landing point. the search terminates for a
// node when it reaches toProject; the queue still processes other
// branches so we collect all reachable hop chains under the hop cap.
//
// dedupe on (project, stableId) so cycles don't blow up. maxHops is
// counted as the number of cross_project_edges walked, so depth=1
// is the direct-hop case, depth=2 follows one intermediate boundary,
// etc. capped at 5 to keep pathological federation graphs bounded.
function findCrossProjectBoundaries(
	fromEngine: AtlasEngine,
	fromProjectId: string,
	fromStableId: string,
	toProjectId: string,
	maxHops: number,
): BoundaryHop[] {
	type QueueItem = {
		engine: AtlasEngine
		projectId: string
		stableId: string
		chain: BoundaryHop['boundaryChain']
	}
	const hops: BoundaryHop[] = []
	const visited = new Set<string>()
	const queue: QueueItem[] = [
		{ engine: fromEngine, projectId: fromProjectId, stableId: fromStableId, chain: [] },
	]
	visited.add(`${fromProjectId}|${fromStableId}`)

	while (queue.length > 0) {
		const item = queue.shift()!
		if (item.chain.length >= maxHops) continue
		const edges = item.engine.getCrossProjectEdgesByStableId(item.projectId, item.stableId)
		for (const edge of edges.outbound) {
			const key = `${edge.targetProject}|${edge.targetStableId}`
			if (visited.has(key)) continue
			visited.add(key)
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
				hops.push({ landingStableId: edge.targetStableId, boundaryChain: nextChain })
				// don't enqueue past the destination: the local trace
				// inside toProject handles the rest.
				continue
			}
			const nextProject = getProject(edge.targetProject)
			if (!nextProject) continue
			const nextEngine = getOrCreateEngine(nextProject.id, nextProject.root)
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
