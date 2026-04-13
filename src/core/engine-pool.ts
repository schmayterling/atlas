import { AtlasEngine } from './engine.js'
import {
	getActiveProject,
	getProject,
	listProjects,
} from './registry.js'
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
	// active project set via `atlas use` wins over first-registered. this
	// keeps the cli, stdio mcp, and web ui all resolving to the same
	// engine when no explicit project is passed.
	const activeId = getActiveProject()
	if (activeId) {
		const engine = getEngine(activeId)
		if (engine) return { engine, projectId: activeId }
		log.warn(`active project "${activeId}" is not registered; falling back to first project`)
	}

	const projects = listProjects()
	if (projects.length === 0) return null

	const first = projects[0]
	const engine = getEngine(first.id)
	if (!engine) return null
	return { engine, projectId: first.id }
}

export function getOrCreateEngine(projectId: string | undefined, fallbackRoot?: string): AtlasEngine {
	// explicit -p / ?project= wins over everything.
	if (projectId) {
		const engine = getEngine(projectId)
		if (engine) return engine
	}

	// active project via `atlas use <id>` wins over the raw fallback root.
	// this makes cli + stdio mcp + web all follow the same resolution
	// order so `atlas use foo` actually steers all three.
	const def = getDefaultEngine()
	if (def) return def.engine

	// last resort: spin up an engine rooted at whatever directory the
	// caller had (cwd for CLI, projectRoot for MCP/web). used only when
	// no project is registered at all.
	if (fallbackRoot) {
		const cached = engines.get(fallbackRoot)
		if (cached) return cached
		const engine = new AtlasEngine(fallbackRoot)
		engines.set(fallbackRoot, engine)
		return engine
	}

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
