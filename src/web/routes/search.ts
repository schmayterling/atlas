import { Hono } from 'hono'
import type { AtlasEngine } from '../../core/engine.js'
import type { SymbolKind } from '../../shared/types.js'
import { log } from '../../shared/logger.js'
import { parseIntParam } from '../server.js'

export function searchRoutes(engine: AtlasEngine) {
	const app = new Hono()
	app.get('/', async (c) => {
		const q = c.req.query('q')
		if (!q) return c.json({ error: 'q parameter required' }, 400)

		const kind = c.req.query('kind') as SymbolKind | undefined
		const limit = parseIntParam(c.req.query('limit'), 500)
		const semantic = c.req.query('semantic') === 'true'

		try {
			if (semantic) {
				const result = await engine.semanticSearch(q, { limit })
				return c.json(result)
			}
			return c.json(engine.search(q, { kind, limit }))
		} catch (e) {
			log.error(`search: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})
	return app
}
