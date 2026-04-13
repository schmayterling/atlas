import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { fileRef, heading, outputJson } from '../formatters/common.js'

// covers #31: CLI surface for the channel_hits table populated by the
// sql-linker (and future graphql/queue/env/openapi linkers). three
// subcommands:
//   atlas channels list [--kind sql_table]
//   atlas channels show <kind> <value>
//
// kind defaults to sql_table when the list subcommand is called
// without one, matching the single channel shipped so far (#10).

export function channelsListCommand(
	projectRoot: string,
	json: boolean,
	opts: { kind?: string },
) {
	const engine = getOrCreateEngine(undefined, projectRoot)
	try {
		const kind = opts.kind ?? 'sql_table'
		const groups = engine.listChannels(kind)
		if (json) {
			outputJson({ kind, groups })
			return
		}
		heading(`channels (${kind}) - ${groups.length} groups`)
		if (groups.length === 0) {
			console.log(pc.dim('  no channel hits. run `atlas index` first.'))
			return
		}
		console.log()
		for (const g of groups) {
			console.log(`  ${pc.bold(g.value)}  ${pc.dim(`(${g.symbolStableIds.length} symbols)`)}`)
		}
	} finally {
		engine.close()
	}
}

export function channelsShowCommand(
	projectRoot: string,
	json: boolean,
	kind: string,
	value: string,
) {
	const engine = getOrCreateEngine(undefined, projectRoot)
	try {
		const result = engine.showChannel(kind, value)
		if (json) {
			outputJson({ kind, value, ...result })
			return
		}
		heading(`channel ${kind}:${value}`)
		if (result.symbols.length === 0) {
			console.log(pc.dim(`  no symbols touch ${value}`))
			return
		}
		console.log()
		for (const sym of result.symbols) {
			console.log(`  ${pc.bold(sym.name)}  ${fileRef(sym.filePath, sym.lineStart)}`)
		}
		if (result.hits.length > 0) {
			console.log()
			console.log(pc.dim(`  hits:`))
			for (const hit of result.hits) {
				console.log(`    ${fileRef(hit.filePath, hit.line)}`)
			}
		}
	} finally {
		engine.close()
	}
}
