import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import type { SymbolKind } from '../../shared/types.js'
import { badge, fileRef, outputJson } from '../formatters/common.js'

export async function searchCommand(
	projectRoot: string,
	query: string,
	json: boolean,
	opts: { kind?: string; exact?: boolean; limit?: number; semantic?: boolean; includeTests?: boolean },
) {
	const engine = getOrCreateEngine(undefined, projectRoot)

	try {
		if (opts.semantic) {
			const result = await engine.semanticSearch(query, { limit: opts.limit, includeTests: opts.includeTests })

			if (json) {
				outputJson(result)
				return
			}

			if (!result.embeddingsAvailable) {
				console.log(pc.yellow('embeddings not available. run `atlas index` with Ollama running.'))
				return
			}

			if (result.results.length === 0) {
				console.log(pc.dim(`no semantic results for "${query}"`))
				return
			}

			console.log(
				`${pc.bold(String(result.results.length))} semantic results for "${query}"`,
			)
			console.log()

			for (const sym of result.results) {
				const kindBadge = badge(sym.kind)
				const name = pc.bold(sym.name)
				const ref = fileRef(sym.filePath, sym.lineStart)
				const dist = pc.dim(`distance: ${sym.distance.toFixed(3)}`)
				console.log(`  ${kindBadge} ${name}`)
				console.log(`  ${' '.repeat(12)} ${ref}  ${dist}`)
				console.log()
			}
			return
		}

		const result = engine.search(query, {
			kind: opts.kind as SymbolKind | undefined,
			exact: opts.exact,
			limit: opts.limit,
			includeTests: opts.includeTests,
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
