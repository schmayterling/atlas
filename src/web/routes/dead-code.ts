import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'
import type { SymbolKind } from '../../shared/types.js'
import { log } from '../../shared/logger.js'

export function deadCodeRoutes(engine: AtlasEngine) {
	const app = new Hono()
	app.get('/', (c) => {
		try {
			return c.json(
				engine.deadCode({
					kind: c.req.query('kind') as SymbolKind | undefined,
					path: c.req.query('path') ?? undefined,
				}),
			)
		} catch (e) {
			log.error(`dead-code: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})
	return app
}
