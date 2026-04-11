import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'

export function statusRoutes(engine: AtlasEngine) {
	const app = new Hono()
	app.get('/', (c) => {
		try {
			return c.json(engine.status())
		} catch (e) {
			return c.json({ error: String(e) }, 500)
		}
	})
	return app
}
