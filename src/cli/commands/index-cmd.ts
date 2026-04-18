import pc from 'picocolors'
import { AtlasEngine } from '../../core/engine.js'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { getProjectLinks, listProjects } from '../../core/registry.js'
import { formatDuration, outputJson } from '../formatters/common.js'

export async function indexCommand(
	projectRoot: string,
	json: boolean,
	opts: {
		force?: boolean
		dryRun?: boolean
		noEmbed?: boolean
		noSummarize?: boolean
		withCoChange?: boolean
		withGitHub?: boolean
		db?: string
	},
) {
	// --db explicitly targets a dedicated sqlite file (dogfood, tmp
	// benches) so it must not go through the shared engine pool. every
	// other invocation resolves via the pool so `atlas use` steers it.
	const engine = opts.db
		? new AtlasEngine(projectRoot, { dbPath: opts.db })
		: getOrCreateEngine(undefined, projectRoot)

	try {
		const result = await engine.index(opts)

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
		console.log(`  ${result.symbols} symbols, ${result.edges} edges`)

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

		// hint when this project is linked to other registered projects
		// but no cross-project edges have been built yet. the user has to
		// run `atlas projects build-edges` explicitly because we don't
		// auto-run it (it touches multiple project dbs and can't be
		// undone without `clear-edges`). see #8b.
		try {
			const projects = listProjects()
			if (projects.length > 1) {
				const matching = projects.find((p) => p.root === projectRoot)
				if (matching) {
					const links = getProjectLinks().filter(
						(l) => l.from === matching.id || l.to === matching.id,
					)
					if (links.length > 0) {
						// engine wrapper keeps the cli off the raw store. see #78.
						const xCount = engine.getCrossProjectEdgeCount()
						if (xCount === 0) {
							console.log()
							console.log(
								pc.dim(
									`hint: this project is linked but has no cross-project edges yet. run \`atlas projects build-edges\` to populate them.`,
								),
							)
						}
					}
				}
			}
		} catch {
			// linking hint is best-effort; don't fail the index because of it
		}
	} finally {
		engine.close()
	}
}
