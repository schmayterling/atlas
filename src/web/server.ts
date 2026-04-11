import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { log } from '../shared/logger.js'
import { buildClient } from './build.js'
import { getOrCreateEngine, closeAll } from '../core/engine-pool.js'
import { addProject, getLinkedProjects, getProject } from '../core/registry.js'
import { buildCrossProjectEdges } from '../core/queries/api-trace.js'
import { projectsRoutes } from './routes/projects.js'
import { createMcpServer } from '../mcp/server.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { SymbolKind } from '../shared/types.js'

export function parseIntParam(val: string | undefined, max = 100): number | undefined {
	if (!val) return undefined
	const n = Number(val)
	return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : undefined
}

export async function startWebServer(projectRoot: string, opts: { port: number; open: boolean }) {
	addProject(projectRoot)
	const outDir = await buildClient(projectRoot)
	const app = new Hono()

	// helper: resolve engine for a request
	const eng = (c: any) => getOrCreateEngine(c.req.query('project'), projectRoot)

	// project management
	app.route('/api/projects', projectsRoutes())

	// data routes (engine resolved per-request)
	app.get('/api/status', (c) => {
		try { return c.json(eng(c).status()) }
		catch (e) { log.error(`status: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/search', async (c) => {
		const q = c.req.query('q')
		if (!q) return c.json({ error: 'q required' }, 400)
		try {
			const semantic = c.req.query('semantic') === 'true'
			if (semantic) return c.json(await eng(c).semanticSearch(q, { limit: parseIntParam(c.req.query('limit'), 500) }))
			return c.json(eng(c).search(q, { kind: c.req.query('kind') as SymbolKind | undefined, limit: parseIntParam(c.req.query('limit'), 500) }))
		} catch (e) { log.error(`search: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/files', (c) => {
		try { return c.json(eng(c).files()) }
		catch (e) { log.error(`files: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/files/symbols', (c) => {
		const path = c.req.query('path')
		if (!path) return c.json({ error: 'path required' }, 400)
		try { return c.json(eng(c).fileSymbols(path)) }
		catch (e) { log.error(`files/symbols: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/deps', (c) => {
		const symbol = c.req.query('symbol')
		if (!symbol) return c.json({ error: 'symbol required' }, 400)
		try {
			const result = eng(c).deps(symbol, { direction: c.req.query('direction') as any, depth: parseIntParam(c.req.query('depth'), 10) })
			if (!result) return c.json({ error: 'symbol not found' }, 404)
			return c.json(result)
		} catch (e) { log.error(`deps: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/blast', (c) => {
		const target = c.req.query('target')
		if (!target) return c.json({ error: 'target required' }, 400)
		try {
			const result = eng(c).blast(target, { depth: parseIntParam(c.req.query('depth'), 10) })
			if (!result) return c.json({ error: 'symbol not found' }, 404)
			return c.json(result)
		} catch (e) { log.error(`blast: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/trace', (c) => {
		const from = c.req.query('from'), to = c.req.query('to')
		if (!from || !to) return c.json({ error: 'from and to required' }, 400)
		try {
			const result = eng(c).trace(from, to, { maxPaths: parseIntParam(c.req.query('maxPaths'), 50), maxDepth: parseIntParam(c.req.query('maxDepth'), 10) })
			if (!result) return c.json({ error: 'could not resolve both symbols' }, 404)
			return c.json(result)
		} catch (e) { log.error(`trace: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/dead-code', (c) => {
		try { return c.json(eng(c).deadCode({ kind: c.req.query('kind') as SymbolKind | undefined, path: c.req.query('path') ?? undefined })) }
		catch (e) { log.error(`dead-code: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/symbol', async (c) => {
		const q = c.req.query('q')
		if (!q) return c.json({ error: 'q required' }, 400)
		try {
			if (c.req.query('detail') === 'true') {
				const result = await eng(c).symbolDetail(q)
				if (!result) return c.json({ error: 'symbol not found' }, 404)
				return c.json(result)
			}
			const result = eng(c).resolveSymbol(q)
			if (!result) return c.json({ error: 'symbol not found' }, 404)
			return c.json(result)
		} catch (e) { log.error(`symbol: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/wiki', async (c) => {
		const { marked } = await import('marked')
		const symbolQuery = c.req.query('symbol')
		try {
			if (!symbolQuery) {
				// check if requesting a file summary
				const filePath = c.req.query('file')
				if (filePath) {
					const engine = eng(c)
					let fileSummary: string | null = null
					try {
						fileSummary = engine.getFileSummary(filePath)
					} catch { /* no summaries table */ }
					return c.json({ type: 'file', path: filePath, summary: fileSummary, symbols: engine.fileSymbols(filePath) })
				}
				return c.json({ type: 'index', files: eng(c).files().map((f) => ({ path: f.path, language: f.language, symbolCount: f.symbolCount })) })
			}
			const engine = eng(c)
			const detail = await engine.symbolDetail(symbolQuery)
			if (!detail) return c.json({ error: 'symbol not found' }, 404)
			const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
			const { symbol, summary, upstream, downstream, sourceCode } = detail

			let md = `# ${esc(symbol.kind)} \`${esc(symbol.name)}\`\n\n**File:** \`${esc(symbol.filePath)}:${symbol.lineStart}\`\n\n`
			if (symbol.signature) md += `**Signature:** \`${esc(symbol.signature)}\`\n\n`
			if (symbol.isExported) md += `*exported*\n\n`
			if (summary) md += `> ${esc(summary)}\n\n`

			// look up flows via engine (not store directly)
			try {
				const allFlows = engine.flows()
				const sym = engine.resolveSymbol(symbolQuery)
				if (sym) {
					const memberFlows = allFlows.filter((f) => f.symbols.some((s) => s.qualifiedName === sym.qualifiedName))
					if (memberFlows.length > 0) {
						md += `**Flows:** ${memberFlows.map((f) => esc(f.name)).join(', ')}\n\n`
					}
				}
			} catch { /* flows not available */ }

			if (symbol.docComment) md += `${esc(symbol.docComment)}\n\n`
			if (sourceCode) md += `\`\`\`typescript\n${esc(sourceCode)}\n\`\`\`\n\n`
			if (upstream.length > 0) { md += `## depends on\n\n`; for (const d of upstream) md += `- \`${esc(d.symbol.name)}\` (${esc(d.edgeKind)})\n`; md += '\n' }
			if (downstream.length > 0) { md += `## depended on by\n\n`; for (const d of downstream) md += `- \`${esc(d.symbol.name)}\` (${esc(d.edgeKind)})\n`; md += '\n' }
			return c.json({ type: 'symbol', symbol, html: await marked(md) })
		} catch (e) { log.error(`wiki: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/flows', (c) => {
		try { return c.json(eng(c).flows()) }
		catch (e) { log.error(`flows: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/duplicates', (c) => {
		try { return c.json(eng(c).duplicates()) }
		catch (e) { log.error(`duplicates: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/cross-edges', (c) => {
		const symbol = c.req.query('symbol')
		const projectId = c.req.query('project')
		if (!symbol || !projectId) return c.json({ error: 'symbol and project required' }, 400)
		try { return c.json(eng(c).getCrossProjectEdges(projectId, symbol)) }
		catch (e) { log.error(`cross-edges: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.post('/api/build-cross-edges', async (c) => {
		try {
			const body = await c.req.json()
			const { projectId } = body
			if (!projectId) return c.json({ error: 'projectId required' }, 400)
			const project = getProject(projectId)
			if (!project) return c.json({ error: 'project not found' }, 404)
			const linked = getLinkedProjects(projectId)
			const engine = getOrCreateEngine(projectId, projectRoot)
			const localStore = engine.getStoreForCrossProject()
			let totalEdges = 0
			for (const link of linked) {
				const remoteEngine = getOrCreateEngine(link.id)
				if (!remoteEngine) continue
				const remoteStore = remoteEngine.getStoreForCrossProject()
				totalEdges += buildCrossProjectEdges(localStore, projectId, remoteStore, link.id)
			}
			return c.json({ edges: totalEdges, linkedProjects: linked.length })
		} catch (e) { log.error(`build-cross-edges: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/summarize', async (c) => {
		const q = c.req.query('q')
		if (!q) return c.json({ error: 'q required' }, 400)
		try {
			const result = await eng(c).summarize(q, { model: c.req.query('model') ?? undefined })
			return c.json(result)
		} catch (e) { log.error(`summarize: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/api-trace', (c) => {
		const pattern = c.req.query('pattern')
		if (!pattern) return c.json({ error: 'pattern required' }, 400)
		try { return c.json(eng(c).traceApi(pattern)) }
		catch (e) { log.error(`api-trace: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	// MCP over HTTP
	const defaultEngine = getOrCreateEngine(undefined, projectRoot)
	const mcpServer = createMcpServer(defaultEngine)
	const mcpTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
	mcpServer.connect(mcpTransport)
	app.all('/mcp', async (c) => {
		try { return await mcpTransport.handleRequest(c.req.raw) }
		catch (e) { log.error(`mcp http: ${e}`); return c.json({ error: 'mcp request failed' }, 500) }
	})

	// static files + SPA fallback
	const indexPath = join(outDir, 'index.html')
	if (existsSync(indexPath)) {
		const indexHtml = await Bun.file(indexPath).text()
		app.get('*', async (c) => {
			const urlPath = new URL(c.req.url).pathname
			if (urlPath !== '/') {
				const filePath = join(outDir, urlPath)
				if (!filePath.startsWith(outDir + '/')) return c.html(indexHtml)
				const file = Bun.file(filePath)
				if (await file.exists()) return new Response(file)
			}
			return c.html(indexHtml)
		})
	}

	const server = Bun.serve({ fetch: app.fetch, port: opts.port, hostname: '127.0.0.1' })
	log.info(`atlas web UI: http://localhost:${server.port}`)

	if (opts.open) {
		const url = `http://localhost:${server.port}`
		try { if (process.platform === 'darwin') Bun.spawn(['open', url]); else if (process.platform === 'linux') Bun.spawn(['xdg-open', url]) }
		catch { /* user can open manually */ }
	}

	const shutdown = () => { closeAll(); process.exit(0) }
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
	await new Promise(() => {})
}
