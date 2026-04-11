import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { AtlasEngine } from '../core/engine.js'
import { log } from '../shared/logger.js'
import { buildClient } from './build.js'
import { statusRoutes } from './routes/status.js'
import { searchRoutes } from './routes/search.js'
import { filesRoutes } from './routes/files.js'
import { depsRoutes } from './routes/deps.js'
import { blastRoutes } from './routes/blast.js'
import { traceRoutes } from './routes/trace.js'
import { deadCodeRoutes } from './routes/dead-code.js'
import { symbolRoutes } from './routes/symbol.js'
import { wikiRoutes } from './routes/wiki.js'
import { createMcpServer } from '../mcp/server.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

export function parseIntParam(val: string | undefined, max = 100): number | undefined {
	if (!val) return undefined
	const n = Number(val)
	return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : undefined
}

export async function startWebServer(projectRoot: string, opts: { port: number; open: boolean }) {
	const engine = new AtlasEngine(projectRoot)

	const outDir = await buildClient(projectRoot)

	const app = new Hono()

	app.route('/api/status', statusRoutes(engine))
	app.route('/api/search', searchRoutes(engine))
	app.route('/api/files', filesRoutes(engine))
	app.route('/api/deps', depsRoutes(engine))
	app.route('/api/blast', blastRoutes(engine))
	app.route('/api/trace', traceRoutes(engine))
	app.route('/api/dead-code', deadCodeRoutes(engine))
	app.route('/api/symbol', symbolRoutes(engine))
	app.route('/api/wiki', wikiRoutes(engine))

	// MCP over HTTP (streamable HTTP transport)
	const mcpServer = createMcpServer(engine)
	const mcpTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
	mcpServer.connect(mcpTransport)
	app.all('/mcp', async (c) => {
		try {
			const response = await mcpTransport.handleRequest(c.req.raw)
			return response
		} catch (e) {
			log.error(`mcp http: ${e}`)
			return c.json({ error: 'mcp request failed' }, 500)
		}
	})

	// static files + SPA fallback
	const indexPath = join(outDir, 'index.html')
	if (existsSync(indexPath)) {
		const indexHtml = await Bun.file(indexPath).text()

		app.get('*', async (c) => {
			const urlPath = new URL(c.req.url).pathname
			if (urlPath !== '/') {
				const filePath = join(outDir, urlPath)
				// prevent path traversal: resolved path must stay inside outDir
				if (!filePath.startsWith(outDir + '/')) {
					return c.html(indexHtml)
				}
				const file = Bun.file(filePath)
				if (await file.exists()) {
					return new Response(file)
				}
			}
			return c.html(indexHtml)
		})
	}

	const server = Bun.serve({
		fetch: app.fetch,
		port: opts.port,
		hostname: '127.0.0.1',
	})

	log.info(`atlas web UI: http://localhost:${server.port}`)

	if (opts.open) {
		const url = `http://localhost:${server.port}`
		try {
			if (process.platform === 'darwin') Bun.spawn(['open', url])
			else if (process.platform === 'linux') Bun.spawn(['xdg-open', url])
		} catch {
			// user can open manually
		}
	}

	const shutdown = () => {
		engine.close()
		process.exit(0)
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	await new Promise(() => {})
}
