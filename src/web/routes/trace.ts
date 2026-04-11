import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'
import { log } from '../../shared/logger.js'
import { parseIntParam } from '../server.js'

export function traceRoutes(engine: AtlasEngine) {
	const app = new Hono()
	app.get('/', (c) => {
		const from = c.req.query('from')
		const to = c.req.query('to')
		if (!from || !to) return c.json({ error: 'from and to parameters required' }, 400)
		try {
			const result = engine.trace(from, to, {
				maxPaths: parseIntParam(c.req.query('maxPaths'), 50),
				maxDepth: parseIntParam(c.req.query('maxDepth'), 10),
			})
			if (!result) return c.json({ error: 'could not resolve both symbols' }, 404)
			return c.json(result)
		} catch (e) {
			log.error(`trace: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})
	return app
}
