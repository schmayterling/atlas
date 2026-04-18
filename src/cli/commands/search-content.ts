import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import type { ContentSearchOpts } from '../../core/queries/search-content.js'
import { outputJson } from '../formatters/common.js'

// literal content search across indexed source files. fills the gap that
// atlas's symbol graph leaves ("which files mention string X?"). mirror of
// the atlas_content_search MCP tool, same engine method, same defaults.
export async function searchContentCommand(
	projectRoot: string,
	query: string,
	json: boolean,
	opts: ContentSearchOpts,
) {
	const engine = getOrCreateEngine(undefined, projectRoot)
	try {
		const result = engine.searchContent(query, {
			pathPrefix: opts.pathPrefix,
			language: opts.language,
			maxMatches: opts.maxMatches,
		})

		if (json) {
			outputJson(result)
			return
		}

		if (result.warning) {
			console.log(pc.yellow(`warning: ${result.warning}`))
		}
		if (result.matchCount === 0) {
			console.log(pc.dim(`no matches for "${query}"`))
			return
		}

		console.log(
			`${pc.bold(String(result.matchCount))} matches in ${pc.bold(String(result.fileCount))} files for "${query}"`,
		)
		console.log()

		for (const m of result.matches) {
			console.log(`  ${pc.cyan(`${m.file}:${m.line}`)}  ${m.text}`)
		}
	} finally {
		engine.close()
	}
}
