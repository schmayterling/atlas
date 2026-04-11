import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'

export function depsRoutes(engine: AtlasEngine) {
	const app = new Hono()
	app.get('/', (c) => {
		const symbol = c.req.query('symbol')
		if (!symbol) return c.json({ error: 'symbol parameter required' }, 400)
		try {
			const result = engine.deps(symbol, {
				direction: (c.req.query('direction') as 'upstream' | 'downstream' | 'both') ?? undefined,
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
