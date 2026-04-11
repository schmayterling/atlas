import pc from 'picocolors'
import { AtlasEngine } from '../../core/engine.js'
import type { SymbolKind } from '../../shared/types.js'
import { badge, fileRef, heading, outputJson } from '../formatters/common.js'

export function deadCodeCommand(
	projectRoot: string,
	json: boolean,
	opts: { kind?: string; path?: string },
) {
	const engine = new AtlasEngine(projectRoot)

	try {
		const result = engine.deadCode({
			kind: opts.kind as SymbolKind | undefined,
			path: opts.path,
		})

		if (json) {
			outputJson(result)
			return
		}

		heading(`unreferenced symbols (${result.stats.total} found)`)

		if (result.stats.total === 0) {
			console.log(pc.green('  no dead code found'))
			return
		}

		console.log()
		for (const sym of result.symbols) {
			const kindBadge = badge(sym.kind)
			const name = pc.bold(sym.name)
			const ref = fileRef(sym.filePath, sym.lineStart)
			console.log(`  ${kindBadge} ${name}`)
			console.log(`  ${' '.repeat(12)} ${ref}`)
		}

		console.log()
		console.log(pc.dim('by kind:'))
		for (const [kind, count] of Object.entries(result.stats.byKind)) {
			console.log(pc.dim(`  ${kind}: ${count}`))
		}
	} finally {
		engine.close()
	}
}
