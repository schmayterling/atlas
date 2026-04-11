import { Hono } from 'hono'
import { log } from '../../shared/logger.js'
import { listProjects, addProject, removeProject, linkProjects, getProjectLinks } from '../../core/registry.js'

export function projectsRoutes() {
	const app = new Hono()

	app.get('/', (c) => {
		try {
			const projects = listProjects()
			const links = getProjectLinks()
			return c.json({ projects, links })
		} catch (e) {
			log.error(`projects: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})

	app.post('/add', async (c) => {
		try {
			const body = await c.req.json()
			const { root, name } = body
			if (!root) return c.json({ error: 'root path required' }, 400)
			const project = addProject(root, name)
			return c.json(project)
		} catch (e) {
			log.error(`projects/add: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})

	app.post('/remove', async (c) => {
		try {
			const body = await c.req.json()
			const { id } = body
			if (!id) return c.json({ error: 'id required' }, 400)
			const removed = removeProject(id)
			return c.json({ removed })
		} catch (e) {
			log.error(`projects/remove: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})

	app.post('/link', async (c) => {
		try {
			const body = await c.req.json()
			const { from, to, type } = body
			if (!from || !to) return c.json({ error: 'from and to project IDs required' }, 400)
			const linked = linkProjects(from, to, type ?? 'api')
			return c.json({ linked })
		} catch (e) {
			log.error(`projects/link: ${e instanceof Error ? e.stack : e}`)
			return c.json({ error: String(e) }, 500)
		}
	})

	return app
}
