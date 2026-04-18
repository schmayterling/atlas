import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { log } from '../shared/logger.js'
import { buildClient } from './build.js'
import { getOrCreateEngine, closeAll } from '../core/engine-pool.js'
import { addProject, getLinkedProjects, getProject } from '../core/registry.js'
import { projectsRoutes } from './routes/projects.js'
import { createMcpServer } from '../mcp/server.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { SymbolKind } from '../shared/types.js'

export function parseIntParam(val: string | undefined, max = 100): number | undefined {
	if (!val) return undefined
	const n = Number(val)
	return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : undefined
}

// build the Hono app with all routes wired up. extracted from
// startWebServer so tests can call app.request('/api/...') in-process
// without spinning up Bun.serve. pass outDir=null to skip the SPA static
// file fallback (tests don't need it).
export function createApp(projectRoot: string, outDir: string | null = null): Hono {
	addProject(projectRoot)
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
			const includeTests = c.req.query('includeTests') === 'true'
			const semantic = c.req.query('semantic') === 'true'
			if (semantic) return c.json(await eng(c).semanticSearch(q, { limit: parseIntParam(c.req.query('limit'), 500), includeTests }))
			return c.json(eng(c).search(q, { kind: c.req.query('kind') as SymbolKind | undefined, limit: parseIntParam(c.req.query('limit'), 500), includeTests }))
		} catch (e) { log.error(`search: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/files', (c) => {
		try { return c.json(eng(c).files({ includeTests: c.req.query('includeTests') === 'true' })) }
		catch (e) { log.error(`files: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	// LOOKUP surface: user explicitly asked for the symbols at a specific
	// path, return them whether or not the file is a test.
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
		try { return c.json(eng(c).deadCode({ kind: c.req.query('kind') as SymbolKind | undefined, path: c.req.query('path') ?? undefined, includeTests: c.req.query('includeTests') === 'true' })) }
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

	app.get('/api/article/file', (c) => {
		const path = c.req.query('path')
		if (!path) return c.json({ error: 'path required' }, 400)
		try {
			const result = eng(c).fileArticle(path)
			if (!result) return c.json({ error: 'file not found' }, 404)
			return c.json(result)
		} catch (e) { log.error(`article/file: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/article/symbol', async (c) => {
		const q = c.req.query('q')
		if (!q) return c.json({ error: 'q required' }, 400)
		try {
			const result = await eng(c).symbolArticle(q)
			if (!result) return c.json({ error: 'symbol not found' }, 404)
			return c.json(result)
		} catch (e) { log.error(`article/symbol: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
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
				return c.json({ type: 'index', files: eng(c).files({ includeTests: c.req.query('includeTests') === 'true' }).map((f) => ({ path: f.path, language: f.language, symbolCount: f.symbolCount })) })
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

			// last changed + top contributors from git history (skipped if no git data)
			try {
				const last = engine.lastChanged(symbol.filePath)
				if (last) {
					const date = new Date(last.authoredAt).toISOString().slice(0, 10)
					md += `**Last changed:** ${date} by ${esc(last.authorName)} (${esc(last.subject)})\n\n`
				}
				const contribs = engine.contributors(symbol.filePath).slice(0, 3)
				if (contribs.length > 0) {
					md += `**Top contributors:** ${contribs.map((c) => `${esc(c.authorName)} (${c.commits})`).join(', ')}\n\n`
				}
			} catch { /* git history not available */ }

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
			let totalEdges = 0
			for (const link of linked) {
				const remoteEngine = getOrCreateEngine(link.id)
				if (!remoteEngine) continue
				const counts = engine.buildCrossProjectEdges(projectId, remoteEngine, link.id)
				totalEdges += counts.routeMatches
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

	// #70 surfaces channel_hits (+ metadata) to the web consumer so cli,
	// mcp, and web all agree. default kind matches the cli default.
	app.get('/api/channels', (c) => {
		try {
			const kind = c.req.query('kind') ?? 'sql_table'
			return c.json({ kind, groups: eng(c).listChannels(kind) })
		} catch (e) {
			log.error(`channels/list: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})

	app.get('/api/channels/show', (c) => {
		const kind = c.req.query('kind')
		const value = c.req.query('value')
		if (!kind || !value) return c.json({ error: 'kind and value required' }, 400)
		try {
			return c.json({ kind, value, ...eng(c).showChannel(kind, value) })
		} catch (e) {
			log.error(`channels/show: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})

	app.get('/api/git/churn', (c) => {
		try {
			const limit = parseIntParam(c.req.query('limit'), 500) ?? 50
			const sinceDays = parseIntParam(c.req.query('sinceDays'), 3650)
			const since = sinceDays ? Date.now() - sinceDays * 86400_000 : undefined
			return c.json(eng(c).churn({ limit, pathPrefix: c.req.query('path'), since }))
		} catch (e) { log.error(`git/churn: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/git/history', (c) => {
		const file = c.req.query('file')
		if (!file) return c.json({ error: 'file required' }, 400)
		try { return c.json(eng(c).fileHistory(file)) }
		catch (e) { log.error(`git/history: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/git/contributors', (c) => {
		try { return c.json(eng(c).contributors(c.req.query('file'))) }
		catch (e) { log.error(`git/contributors: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/git/co-change', (c) => {
		try {
			const limit = parseIntParam(c.req.query('limit'), 500) ?? 50
			const minCount = parseIntParam(c.req.query('minCount'), 1000) ?? 2
			return c.json(eng(c).coChange({ filePath: c.req.query('file'), limit, minCount }))
		} catch (e) { log.error(`git/co-change: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/subsystems', (c) => {
		try { return c.json(eng(c).subsystems()) }
		catch (e) { log.error(`subsystems: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/entry-points', (c) => {
		try {
			const limit = parseIntParam(c.req.query('limit'), 50) ?? 8
			return c.json(eng(c).topExported(limit))
		} catch (e) { log.error(`entry-points: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/hot-fragile', (c) => {
		try {
			const limit = parseIntParam(c.req.query('limit'), 500) ?? 20
			return c.json(eng(c).hotFragile({ limit }))
		} catch (e) { log.error(`hot-fragile: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/hotspots', (c) => {
		try {
			const limit = parseIntParam(c.req.query('limit'), 500) ?? 20
			const coverageRaw = c.req.query('coverage')
			const coverage =
				coverageRaw === 'called' || coverageRaw === 'imported' || coverageRaw === 'none'
					? (coverageRaw as 'called' | 'imported' | 'none')
					: undefined
			return c.json(eng(c).hotspots({ limit, coverage }))
		} catch (e) { log.error(`hotspots: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/test-coverage', (c) => {
		const symbol = c.req.query('symbol')
		if (!symbol) return c.json({ error: 'symbol required' }, 400)
		try {
			const result = eng(c).testCoverage(symbol)
			if (!result) return c.json({ error: 'symbol not found' }, 404)
			return c.json(result)
		} catch (e) { log.error(`test-coverage: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	app.get('/api/subsystem', (c) => {
		const id = c.req.query('id')
		if (!id) return c.json({ error: 'id required' }, 400)
		try {
			const detail = eng(c).subsystem(id)
			if (!detail) return c.json({ error: 'subsystem not found' }, 404)
			return c.json(detail)
		} catch (e) { log.error(`subsystem: ${e instanceof Error ? e.stack : e}`); return c.json({ error: String(e) }, 500) }
	})

	// MCP over HTTP. the streamable transport is stateless
	// (sessionIdGenerator: undefined) and the SDK refuses to reuse one
	// across requests, so we build a fresh server+transport per call. the
	// underlying engine is cached by getOrCreateEngine, so the only
	// per-request cost is wiring up the tool registrations. routing on
	// ?project= means /mcp?project=foo hits foo's engine instead of always
	// the default one.
	app.all('/mcp', async (c) => {
		try {
			const engine = getOrCreateEngine(c.req.query('project'), projectRoot)
			const server = createMcpServer(engine)
			const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
			await server.connect(transport)
			return await transport.handleRequest(c.req.raw)
		} catch (e) {
			log.error(`mcp http: ${e}`)
			return c.json({ error: 'mcp request failed' }, 500)
		}
	})

	// static files + SPA fallback (skipped when outDir is null, i.e. in tests)
	if (outDir !== null) {
		const staticDir = outDir
		const indexPath = join(staticDir, 'index.html')
		if (existsSync(indexPath)) {
			app.get('*', async (c) => {
				const urlPath = new URL(c.req.url).pathname
				if (urlPath !== '/') {
					const filePath = join(staticDir, urlPath)
					if (filePath.startsWith(staticDir + '/')) {
						const file = Bun.file(filePath)
						if (await file.exists()) return new Response(file)
					}
				}
				return c.html(await Bun.file(indexPath).text())
			})
		}
	}

	return app
}

export async function startWebServer(projectRoot: string, opts: { port: number; open: boolean }) {
	const outDir = await buildClient(projectRoot)
	const app = createApp(projectRoot, outDir)

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
