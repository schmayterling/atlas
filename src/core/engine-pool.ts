import { resolve } from 'node:path'
import { AtlasEngine } from './engine.js'
import {
	getActiveProject,
	getProject,
	getProjectByRoot,
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
	// engine when no explicit project is passed AND no fallback root is
	// available. callers with a fallback root (the common CLI case where
	// commander defaults -p to cwd) take a different path in
	// getOrCreateEngine and never reach this default.
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

// resolution order, post-#8a:
//   1. explicit projectId (mcp ?project=, internal callers that already
//      know the registered id) — always wins.
//   2. fallbackRoot, resolved against the registry by absolute path:
//      - if the path matches a registered project → reuse that project's
//        engine (so addressing by path is equivalent to addressing by id
//        for any registered project).
//      - otherwise → anchor a fresh engine at the exact path. this is
//        critical for cli ergonomics: passing `-p /tmp/scratch` must
//        operate on /tmp/scratch even when an unrelated active project
//        is registered (see issue #8a / codex finding 1).
//   3. active project via `atlas use <id>` wins only when neither an
//      explicit id nor a fallback root is supplied. this path is
//      reached by stdio mcp and web routes that genuinely have no
//      project context.
export function getOrCreateEngine(projectId: string | undefined, fallbackRoot?: string): AtlasEngine {
	if (projectId) {
		const engine = getEngine(projectId)
		if (engine) return engine
	}

	if (fallbackRoot) {
		const absRoot = resolve(fallbackRoot)
		const registered = getProjectByRoot(absRoot)
		if (registered) {
			const engine = getEngine(registered.id)
			if (engine) return engine
		}
		const cached = engines.get(absRoot)
		if (cached) return cached
		const engine = new AtlasEngine(absRoot)
		engines.set(absRoot, engine)
		return engine
	}

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
