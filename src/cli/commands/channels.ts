import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { fileRef, heading, outputJson } from '../formatters/common.js'

// CLI surface for the channel_hits table populated by the channel
// linkers. two subcommands:
//   atlas channels list [--kind sql_table]
//   atlas channels show <kind> <value>
// kind defaults to sql_table when --kind is omitted.

const KNOWN_CHANNEL_KINDS = [
	'sql_table',
	'queue_topic',
	'env_var',
	'graphql_type',
	'openapi_type',
	'proto_ref',
]

// format channel_hits.metadata for human output. linkers write
// structured JSON that is genuinely informative (queue pub/sub
// direction, driver; graphql type/input/enum; openapi schemaPath),
// so we surface it inline next to the file:line ref. nested objects
// and arrays would render as `[object Object]` / `1,2`, which is
// noise — skip those values rather than emit junk. see #70.
function formatChannelMetadata(meta: Record<string, unknown> | null): string {
	if (!meta) return ''
	const parts: string[] = []
	for (const [k, v] of Object.entries(meta)) {
		if (v === null || v === undefined) continue
		if (typeof v === 'object') continue
		parts.push(`${k}=${String(v)}`)
	}
	return parts.join(' ')
}

export function channelsListCommand(
	projectRoot: string,
	json: boolean,
	opts: { kind?: string },
) {
	const kind = opts.kind ?? 'sql_table'
	if (!KNOWN_CHANNEL_KINDS.includes(kind)) {
		console.error(
			pc.red(
				`unknown channel kind: ${kind}. valid kinds: ${KNOWN_CHANNEL_KINDS.join(', ')}`,
			),
		)
		process.exit(1)
	}
	const engine = getOrCreateEngine(undefined, projectRoot)
	try {
		const groups = engine.listChannels(kind)
		if (json) {
			outputJson({ kind, groups })
			return
		}
		heading(`channels (${kind}) - ${groups.length} groups`)
		if (groups.length === 0) {
			console.log(pc.dim('  no channel hits. run `atlas index` to populate.'))
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
				const meta = formatChannelMetadata(hit.metadata)
				const suffix = meta ? `  ${pc.dim(meta)}` : ''
				console.log(`    ${fileRef(hit.filePath, hit.line)}${suffix}`)
			}
		}
	} finally {
		engine.close()
	}
}
