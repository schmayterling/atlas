import pc from 'picocolors'
import { AtlasEngine } from '../../core/engine.js'
import { formatDuration, outputJson } from '../formatters/common.js'

export function indexCommand(
	projectRoot: string,
	json: boolean,
	opts: { force?: boolean; dryRun?: boolean },
) {
	const engine = new AtlasEngine(projectRoot)

	try {
		const result = engine.index(opts)

		if (json) {
			outputJson(result)
			return
		}

		if (opts.dryRun) {
			console.log(pc.dim('(dry run, no changes made)'))
		}

		console.log()
		console.log(
			`indexed ${pc.bold(String(result.filesTotal))} files in ${formatDuration(result.duration)}`,
		)
		console.log(
			`  ${pc.green(`+${result.filesAdded}`)} added  ${pc.yellow(`~${result.filesModified}`)} modified  ${pc.red(`-${result.filesDeleted}`)} deleted  ${pc.dim(`${result.filesCached} cached`)}`,
		)
		console.log(
			`  ${result.symbols} symbols, ${result.edges} edges, ${result.references} references`,
		)

		if (result.warnings.length > 0) {
			console.log()
			console.log(pc.yellow(`${result.warnings.length} warnings:`))
			for (const w of result.warnings.slice(0, 10)) {
				console.log(pc.dim(`  ${w}`))
			}
			if (result.warnings.length > 10) {
				console.log(pc.dim(`  ...and ${result.warnings.length - 10} more`))
			}
		}
	} finally {
		engine.close()
	}
}
