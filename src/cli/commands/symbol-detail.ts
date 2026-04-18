import pc from 'picocolors'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { badge, fileRef, outputJson } from '../formatters/common.js'

// code-bearing symbol lookup. returns identity + direct deps + cached LLM
// summary (if indexed with --with-summaries) + the actual source body.
// mirrors the atlas_symbol_detail MCP tool.
export async function symbolDetailCommand(
	projectRoot: string,
	symbol: string,
	json: boolean,
) {
	const engine = getOrCreateEngine(undefined, projectRoot)
	try {
		const result = await engine.symbolDetail(symbol)
		if (!result) {
			console.log(pc.red(`symbol not found: ${symbol}`))
			return
		}
		if (json) {
			outputJson(result)
			return
		}

		const s = result.symbol
		console.log(`${badge(s.kind)} ${pc.bold(s.name)}  ${pc.dim(`(${s.qualifiedName})`)}`)
		console.log(`  ${fileRef(s.filePath, s.lineStart)}-${s.lineEnd}`)
		if (s.signature) console.log(`  ${pc.dim('signature:')} ${s.signature}`)
		if (s.docComment) console.log(`  ${pc.dim('doc:')} ${s.docComment.slice(0, 240)}`)
		if (result.summary) console.log(`  ${pc.dim('summary:')} ${result.summary}`)
		console.log(
			`  ${pc.dim(`upstream=${result.upstream.length}  downstream=${result.downstream.length}`)}`,
		)
		console.log()
		if (result.sourceCode) {
			console.log(pc.dim('--- source ---'))
			console.log(result.sourceCode)
		} else {
			console.log(pc.yellow('(source unavailable, file may have been moved or deleted)'))
		}
	} finally {
		engine.close()
	}
}
