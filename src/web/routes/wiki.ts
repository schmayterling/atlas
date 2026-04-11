import { Hono } from 'hono'
import { marked } from 'marked'
import type { AtlasEngine } from '../../core/engine.js'
import { log } from '../../shared/logger.js'

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

export function wikiRoutes(engine: AtlasEngine) {
	const app = new Hono()

	app.get('/', async (c) => {
		const symbolQuery = c.req.query('symbol')
		try {
			if (!symbolQuery) {
				const files = engine.files()
				const index = files.map((f) => ({
					path: f.path,
					language: f.language,
					symbolCount: f.symbolCount,
				}))
				return c.json({ type: 'index', files: index })
			}

			const detail = await engine.symbolDetail(symbolQuery)
			if (!detail) return c.json({ error: 'symbol not found' }, 404)

			const { symbol, upstream, downstream, sourceCode } = detail
			// escape HTML in user-controlled values to prevent XSS from malicious docstrings
			const safeName = escapeHtml(symbol.name)
			const safeSignature = symbol.signature ? escapeHtml(symbol.signature) : null
			const safeDocComment = symbol.docComment ? escapeHtml(symbol.docComment) : null
			const safeSourceCode = sourceCode ? escapeHtml(sourceCode) : null

			let markdown = `# ${symbol.kind} \`${safeName}\`\n\n`
			markdown += `**File:** \`${symbol.filePath}:${symbol.lineStart}\`\n\n`
			if (safeSignature) markdown += `**Signature:** \`${safeSignature}\`\n\n`
			if (symbol.isExported) markdown += `*exported*\n\n`
			if (safeDocComment) markdown += `${safeDocComment}\n\n`
			if (safeSourceCode) markdown += `\`\`\`typescript\n${safeSourceCode}\n\`\`\`\n\n`
			if (upstream.length > 0) {
				markdown += `## depends on\n\n`
				for (const dep of upstream) {
					markdown += `- \`${escapeHtml(dep.symbol.name)}\` (${dep.edgeKind})\n`
				}
				markdown += '\n'
			}
			if (downstream.length > 0) {
				markdown += `## depended on by\n\n`
				for (const dep of downstream) {
					markdown += `- \`${escapeHtml(dep.symbol.name)}\` (${dep.edgeKind})\n`
				}
				markdown += '\n'
			}

			const html = await marked(markdown)
			return c.json({ type: 'symbol', symbol, html })
		} catch (e) {
			log.error(`wiki: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})

	return app
}
