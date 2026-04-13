import pc from 'picocolors'
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

	// look for direct cross_project_edges from `from` that land in
	// `toProject`. if none, the user is asking for a path through more
	// than one boundary which is out of scope for the MVP.
	const xEdges = fromEngine.getCrossProjectEdgesByStableId(fromProject.id, fromAnchor.stableId)
	const matchingHops = xEdges.outbound.filter((e) => e.targetProject === toProject.id)

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
					`no direct cross_project_edges from ${pc.cyan(fromProject.id)}::${from} into ${pc.cyan(toProject.id)}. multi-hop cross-project trace is out of scope for the MVP.`,
				),
			)
		}
		return
	}

	// for each boundary hop, run a local trace inside the to-project
	// using stable-id entry points on both ends. name-based resolution
	// would pick the first same-named hit in the to-project, which is
	// wrong when multiple symbols share a name.
	for (const hop of matchingHops) {
		const trace = toEngine.traceByStableIds(hop.targetStableId, toAnchor.stableId, {
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
