import pc from 'picocolors'
import { AtlasEngine } from '../../core/engine.js'
import { heading, outputJson } from '../formatters/common.js'
import { renderDependencyTree } from '../formatters/tree.js'

export function depsCommand(
	projectRoot: string,
	symbol: string,
	json: boolean,
	opts: { direction?: string; depth?: number },
) {
	const engine = new AtlasEngine(projectRoot)

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
