import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'

export function filesRoutes(engine: AtlasEngine) {
	const app = new Hono()

	app.get('/', (c) => {
		try {
			return c.json(engine.files())
		} catch (e) {
			return c.json({ error: String(e) }, 500)
		}
	})

	app.get('/symbols', (c) => {
		const path = c.req.query('path')
		if (!path) return c.json({ error: 'path parameter required' }, 400)
		try {
			return c.json(engine.fileSymbols(path))
		} catch (e) {
			return c.json({ error: String(e) }, 500)
		}
	})

	return app
}
