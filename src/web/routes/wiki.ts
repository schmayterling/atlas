import { Hono } from 'hono'
import { marked } from 'marked'
import type { AtlasEngine } from '../../core/engine.js'

export function wikiRoutes(engine: AtlasEngine) {
	const app = new Hono()

	app.get('/', async (c) => {
		const symbolQuery = c.req.query('symbol')
		try {
			if (!symbolQuery) {
				// index page: all files with exported symbols
				const files = engine.files()
				const index = files.map((f) => ({
					path: f.path,
					language: f.language,
					symbolCount: f.symbolCount,
				}))
				return c.json({ type: 'index', files: index })
			}

			// symbol wiki entry
			const detail = engine.symbolDetail(symbolQuery)
			if (!detail) return c.json({ error: 'symbol not found' }, 404)

			const { symbol, upstream, downstream, sourceCode } = detail
			let markdown = `# ${symbol.kind} \`${symbol.name}\`\n\n`
			markdown += `**File:** \`${symbol.filePath}:${symbol.lineStart}\`\n\n`
			if (symbol.signature) markdown += `**Signature:** \`${symbol.signature}\`\n\n`
			if (symbol.isExported) markdown += `*exported*\n\n`
			if (symbol.docComment) markdown += `${symbol.docComment}\n\n`
			if (sourceCode) markdown += `\`\`\`typescript\n${sourceCode}\n\`\`\`\n\n`
			if (upstream.length > 0) {
				markdown += `## depends on\n\n`
				for (const dep of upstream) {
					markdown += `- \`${dep.symbol.name}\` (${dep.edgeKind})\n`
				}
				markdown += '\n'
			}
			if (downstream.length > 0) {
				markdown += `## depended on by\n\n`
				for (const dep of downstream) {
					markdown += `- \`${dep.symbol.name}\` (${dep.edgeKind})\n`
				}
				markdown += '\n'
			}

			const html = await marked(markdown)
			return c.json({ type: 'symbol', symbol, html, markdown })
		} catch (e) {
			return c.json({ error: String(e) }, 500)
		}
	})

	return app
}
