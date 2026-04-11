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

export async function startWebServer(projectRoot: string, opts: { port: number; open: boolean }) {
	const engine = new AtlasEngine(projectRoot)

	// build frontend
	const outDir = await buildClient(projectRoot)

	const app = new Hono()

	// API routes
	app.route('/api/status', statusRoutes(engine))
	app.route('/api/search', searchRoutes(engine))
	app.route('/api/files', filesRoutes(engine))
	app.route('/api/deps', depsRoutes(engine))
	app.route('/api/blast', blastRoutes(engine))
	app.route('/api/trace', traceRoutes(engine))
	app.route('/api/dead-code', deadCodeRoutes(engine))
	app.route('/api/symbol', symbolRoutes(engine))
	app.route('/api/wiki', wikiRoutes(engine))

	// static files + SPA fallback
	const indexPath = join(outDir, 'index.html')
	if (existsSync(indexPath)) {
		const indexHtml = await Bun.file(indexPath).text()

		app.get('*', async (c) => {
			// try to serve static file from outDir
			const urlPath = new URL(c.req.url).pathname
			if (urlPath !== '/') {
				const filePath = join(outDir, urlPath)
				const file = Bun.file(filePath)
				if (await file.exists()) {
					return new Response(file)
				}
			}
			// SPA fallback
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
		// auto-open browser
		const url = `http://localhost:${server.port}`
		try {
			if (process.platform === 'darwin') Bun.spawn(['open', url])
			else if (process.platform === 'linux') Bun.spawn(['xdg-open', url])
		} catch {
			// ignore, user can open manually
		}
	}

	// keep process alive
	await new Promise(() => {})
}
