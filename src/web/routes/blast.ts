import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'

export function blastRoutes(engine: AtlasEngine) {
	const app = new Hono()
	app.get('/', (c) => {
		const target = c.req.query('target')
		if (!target) return c.json({ error: 'target parameter required' }, 400)
		try {
			const result = engine.blast(target, {
				depth: c.req.query('depth') ? Number(c.req.query('depth')) : undefined,
			})
			if (!result) return c.json({ error: 'symbol not found' }, 404)
			return c.json(result)
		} catch (e) {
			return c.json({ error: String(e) }, 500)
		}
	})
	return app
}
