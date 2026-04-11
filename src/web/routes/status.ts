import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'
import { log } from '../../shared/logger.js'

export function statusRoutes(engine: AtlasEngine) {
	const app = new Hono()
	app.get('/', (c) => {
		try {
			return c.json(engine.status())
		} catch (e) {
			log.error(`status: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})
	return app
}
