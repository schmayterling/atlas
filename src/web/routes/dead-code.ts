import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'

export function deadCodeRoutes(engine: AtlasEngine) {
	const app = new Hono()
	app.get('/', (c) => {
		try {
			return c.json(engine.deadCode({
				kind: c.req.query('kind') as any,
				path: c.req.query('path') ?? undefined,
			}))
		} catch (e) {
			return c.json({ error: String(e) }, 500)
		}
	})
	return app
}
