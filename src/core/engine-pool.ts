import { AtlasEngine } from './engine.js'
import { listProjects, getProject, type ProjectEntry } from './registry.js'
import { log } from '../shared/logger.js'

const engines = new Map<string, AtlasEngine>()

export function getEngine(projectId: string): AtlasEngine | null {
	const cached = engines.get(projectId)
	if (cached) return cached

	const project = getProject(projectId)
	if (!project) return null

	const engine = new AtlasEngine(project.root)
	engines.set(projectId, engine)
	return engine
}

export function getDefaultEngine(): { engine: AtlasEngine; projectId: string } | null {
	const projects = listProjects()
	if (projects.length === 0) return null

	const first = projects[0]
	const engine = getEngine(first.id)
	if (!engine) return null
	return { engine, projectId: first.id }
}

export function getOrCreateEngine(projectId: string | undefined, fallbackRoot?: string): AtlasEngine {
	// if projectId provided, look it up in registry
	if (projectId) {
		const engine = getEngine(projectId)
		if (engine) return engine
	}

	// if no registry or project not found, use fallback root
	if (fallbackRoot) {
		const cached = engines.get(fallbackRoot)
		if (cached) return cached
		const engine = new AtlasEngine(fallbackRoot)
		engines.set(fallbackRoot, engine)
		return engine
	}

	// try default project
	const def = getDefaultEngine()
	if (def) return def.engine

	throw new Error('no project available. run `atlas projects add .` to register a project.')
}

export function closeAll() {
	for (const [id, engine] of engines) {
		try {
			engine.close()
		} catch (e) {
			log.debug(`failed to close engine ${id}: ${e}`)
		}
	}
	engines.clear()
}
