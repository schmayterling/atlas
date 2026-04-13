import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { anchorSymbol, fanOutDownstream } from '../../core/federation/federated-engine.js'
import { getProject } from '../../core/registry.js'
import { heading, outputJson } from '../formatters/common.js'
import { renderDependencyTree } from '../formatters/tree.js'

export function depsCommand(
	projectRoot: string,
	symbol: string,
	json: boolean,
	opts: { direction?: string; depth?: number; allProjects?: boolean; project?: string },
) {
	if (opts.allProjects) {
		depsAllProjects(symbol, json, opts)
		return
	}

	const engine = getOrCreateEngine(undefined, projectRoot)

	try {
		const result = engine.deps(symbol, {
			direction: (opts.direction ?? 'both') as 'upstream' | 'downstream' | 'both',
			depth: opts.depth,
		})

		if (!result) {
			console.error(pc.red(`symbol not found: ${symbol}`))
			process.exit(1)
		}

		if (json) {
			outputJson(result)
			return
		}

		const sym = result.symbol
		heading(`${sym.name} (${sym.filePath}:${sym.lineStart})`)

		if (result.truncated) {
			console.log(pc.yellow(`  (truncated: ${result.truncationReason})`))
		}

		if (result.downstream.length > 0) {
			console.log()
			console.log(pc.bold('depends on'))
			renderDependencyTree(result.downstream)
		}

		if (result.upstream.length > 0) {
			console.log()
			console.log(pc.bold('depended on by'))
			renderDependencyTree(result.upstream)
		}

		if (result.upstream.length === 0 && result.downstream.length === 0) {
			console.log(pc.dim('  no dependencies found'))
		}

		console.log()
		console.log(
			pc.dim(
				`${result.stats.totalNodes} nodes, ${result.stats.totalEdges} edges, max depth ${result.stats.maxDepthReached}`,
			),
		)
	} finally {
		engine.close()
	}
}

// federated deps: anchor the symbol in --project <id>, run local deps,
// then fan out across cross_project_edges so the user sees what other
// registered projects depend on (or are depended on by) the anchor
// symbol. requires an explicit --project anchor because the same symbol
// name can resolve to different stable_ids in different projects.
// trace.ts has a more elaborate version with --from/--to anchoring.
function depsAllProjects(
	symbol: string,
	json: boolean,
	opts: { direction?: string; depth?: number; project?: string },
) {
	if (!opts.project) {
		console.error(
			pc.red(
				'deps --all-projects requires --project <id> to anchor the starting symbol. ambiguous resolution across projects is not supported; pick a starting project.',
			),
		)
		process.exit(1)
	}
	const anchorProject = getProject(opts.project)
	if (!anchorProject) {
		console.error(pc.red(`unknown project id: ${opts.project}`))
		process.exit(1)
	}
	const anchorEngine = getOrCreateEngine(anchorProject.id, anchorProject.root)
	const anchor = anchorSymbol(anchorEngine, symbol)
	if (!anchor) {
		console.error(pc.red(`symbol not found in project "${anchorProject.id}": ${symbol}`))
		process.exit(1)
	}

	const local = anchorEngine.deps(symbol, {
		direction: (opts.direction ?? 'both') as 'upstream' | 'downstream' | 'both',
		depth: opts.depth,
	})
	const remoteResults = fanOutDownstream(
		anchorEngine,
		anchorProject.id,
		anchor.stableId,
		(opts.direction ?? 'both') === 'upstream' ? 'inbound'
			: (opts.direction ?? 'both') === 'downstream' ? 'outbound'
			: 'both',
		(remoteEngine, _project, remoteStableId) => {
			// resolve the remote stable_id to a queryable symbol
			// (deps takes a query string, not a stable_id) and run
			// the same direction/depth on the remote engine
			const remoteStore = remoteEngine.getStoreForCrossProject()
			const remoteSym = remoteStore.getSymbolByStableId(remoteStableId)
			if (!remoteSym) return null
			return remoteEngine.deps(remoteSym.name, {
				direction: (opts.direction ?? 'both') as 'upstream' | 'downstream' | 'both',
				depth: opts.depth,
			})
		},
	)

	if (json) {
		outputJson({
			anchor: { project: anchorProject.id, ...anchor },
			local,
			remotes: remoteResults,
		})
		return
	}

	if (!local) {
		console.error(pc.red(`local deps failed for ${symbol}`))
		process.exit(1)
	}
	const sym = local.symbol
	heading(`${pc.magenta(`[${anchorProject.id}]`)} ${sym.name} (${sym.filePath}:${sym.lineStart})`)
	if (local.downstream.length > 0) {
		console.log()
		console.log(pc.bold('depends on (local)'))
		renderDependencyTree(local.downstream)
	}
	if (local.upstream.length > 0) {
		console.log()
		console.log(pc.bold('depended on by (local)'))
		renderDependencyTree(local.upstream)
	}
	if (remoteResults.length === 0) {
		console.log()
		console.log(pc.dim('no cross-project hops from this anchor.'))
	}
	for (const remote of remoteResults) {
		console.log()
		console.log(pc.bold(`${pc.magenta(`[${remote.project}]`)} cross-project`))
		if (!remote.result) {
			console.log(pc.dim('  symbol not resolvable in remote project'))
			continue
		}
		if (remote.result.downstream.length > 0) renderDependencyTree(remote.result.downstream)
		if (remote.result.upstream.length > 0) renderDependencyTree(remote.result.upstream)
	}
}
