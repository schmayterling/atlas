import pc from 'picocolors'
import { AtlasEngine } from '../../core/engine.js'
import { fileRef, heading, outputJson } from '../formatters/common.js'

export function traceCommand(
	projectRoot: string,
	from: string,
	to: string,
	json: boolean,
	opts: { maxPaths?: number; depth?: number },
) {
	const engine = new AtlasEngine(projectRoot)

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
