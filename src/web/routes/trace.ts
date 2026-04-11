import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'

export function traceRoutes(engine: AtlasEngine) {
	const app = new Hono()
	app.get('/', (c) => {
		const from = c.req.query('from')
		const to = c.req.query('to')
		if (!from || !to) return c.json({ error: 'from and to parameters required' }, 400)
		try {
			const result = engine.trace(from, to, {
				maxPaths: c.req.query('maxPaths') ? Number(c.req.query('maxPaths')) : undefined,
				maxDepth: c.req.query('maxDepth') ? Number(c.req.query('maxDepth')) : undefined,
			})
			if (!result) return c.json({ error: 'could not resolve both symbols' }, 404)
			return c.json(result)
		} catch (e) {
			return c.json({ error: String(e) }, 500)
		}
	})
	return app
}
