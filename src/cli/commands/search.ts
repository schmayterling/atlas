import pc from 'picocolors'
import { AtlasEngine } from '../../core/engine.js'
import type { SymbolKind } from '../../shared/types.js'
import { badge, fileRef, outputJson } from '../formatters/common.js'

export function searchCommand(
	projectRoot: string,
	query: string,
	json: boolean,
	opts: { kind?: string; exact?: boolean; limit?: number },
) {
	const engine = new AtlasEngine(projectRoot)

	try {
		const result = engine.search(query, {
			kind: opts.kind as SymbolKind | undefined,
			exact: opts.exact,
			limit: opts.limit,
		})

		if (json) {
			outputJson(result)
			return
		}

		if (result.total === 0) {
			console.log(pc.dim(`no results for "${query}"`))
			return
		}

		console.log(
			`${pc.bold(String(result.total))} results for "${query}"`,
		)
		console.log()

		for (const sym of result.results) {
			const kindBadge = badge(sym.kind)
			const name = pc.bold(sym.name)
			const sig = sym.signature ? pc.dim(` ${sym.signature}`) : ''
			const ref = fileRef(sym.filePath, sym.lineStart)
			const stats = pc.dim(
				`${sym.usageCount} uses | ${sym.dependentCount} dependents`,
			)

			console.log(`  ${kindBadge} ${name}${sig}`)
			console.log(`  ${' '.repeat(12)} ${ref}`)
			console.log(`  ${' '.repeat(12)} ${stats}`)
			console.log()
		}
	} finally {
		engine.close()
	}
}
