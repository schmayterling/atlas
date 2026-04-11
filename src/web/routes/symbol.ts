import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'
import { log } from '../../shared/logger.js'

export function symbolRoutes(engine: AtlasEngine) {
	const app = new Hono()
	app.get('/', async (c) => {
		const q = c.req.query('q')
		if (!q) return c.json({ error: 'q parameter required' }, 400)
		try {
			const detail = c.req.query('detail') === 'true'
			if (detail) {
				const result = await engine.symbolDetail(q)
				if (!result) return c.json({ error: 'symbol not found' }, 404)
				return c.json(result)
			}
			const result = engine.resolveSymbol(q)
			if (!result) return c.json({ error: 'symbol not found' }, 404)
			return c.json(result)
		} catch (e) {
			log.error(`symbol: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})
	return app
}
