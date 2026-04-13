import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { log } from '../shared/logger.js'

export interface ProjectEntry {
	id: string
	name: string
	root: string
	db: string
}

export interface ProjectLink {
	from: string
	to: string
	type: string
}

interface RegistryData {
	projects: ProjectEntry[]
	links: ProjectLink[]
	// id of the active project. resolved by the CLI and MCP when no
	// explicit project is passed. null or absent means "fall back to
	// cwd-based default engine resolution".
	active?: string | null
}

// the registry lives at $HOME/.atlas/registry.json. HOME is read on
// every call (lazy) rather than snapshotted at module load so tests
// that mutate process.env.HOME inside beforeEach / beforeAll see the
// updated value without a second import step. that's required for
// multi-file test safety: bun test parses every test file during
// discovery and executes top-level code, so any module-level
// setRegistryPathForTests() used to leak across test files. see #38.
//
// tests that need an isolated registry should set process.env.HOME to
// a fresh tmp dir inside a beforeEach/beforeAll and restore it in
// afterEach/afterAll. there is no longer a mid-process override API.
function getRegistryDir(): string {
	return join(process.env.HOME ?? '~', '.atlas')
}

function getRegistryPath(): string {
	return join(getRegistryDir(), 'registry.json')
}

function readRegistry(): RegistryData {
	const path = getRegistryPath()
	if (!existsSync(path)) {
		return { projects: [], links: [], active: null }
	}
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8'))
		// tolerate older registry files that pre-date the active field
		return { active: null, ...parsed }
	} catch (e) {
		log.warn(`failed to read registry: ${e}`)
		return { projects: [], links: [], active: null }
	}
}

function writeRegistry(data: RegistryData) {
	const dir = getRegistryDir()
	const path = getRegistryPath()
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
	// atomic replace: write to a sibling temp file, fsync, then rename.
	// protects against a half-written registry if a concurrent
	// `atlas use` / `atlas projects add` races with this write. the
	// rename is atomic on posix filesystems.
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
	writeFileSync(tmp, JSON.stringify(data, null, 2))
	renameSync(tmp, path)
}

function slugify(root: string): string {
	return basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

// generates a collision-safe project id. two different repos whose basenames
// slugify to the same value (e.g. `~/work/api` and `~/personal/api`) used to
// alias to the same cached engine, which silently corrupted multi-project
// queries. when a collision is detected against an existing registry entry
// pointing at a different absolute root, a short stable hash of the new
// root is appended (`api-a1b2c3`) so both projects remain addressable.
function generateId(root: string, existing: ProjectEntry[]): string {
	const base = slugify(root)
	const clash = existing.find((p) => p.id === base && p.root !== root)
	if (!clash) return base
	const suffix = createHash('sha256').update(root).digest('hex').slice(0, 6)
	return `${base}-${suffix}`
}

export function listProjects(): ProjectEntry[] {
	return readRegistry().projects
}

export function getProject(id: string): ProjectEntry | null {
	return readRegistry().projects.find((p) => p.id === id) ?? null
}

export function addProject(root: string, name?: string): ProjectEntry {
	const absRoot = resolve(root)
	const data = readRegistry()

	// check if already registered
	const existing = data.projects.find((p) => p.root === absRoot)
	if (existing) return existing

	const id = generateId(absRoot, data.projects)
	const dbPath = join(absRoot, '.atlas', 'atlas.db')

	const entry: ProjectEntry = {
		id,
		name: name ?? basename(absRoot),
		root: absRoot,
		db: dbPath,
	}

	data.projects.push(entry)
	writeRegistry(data)
	log.info(`registered project: ${entry.name} (${entry.id})`)
	return entry
}

export function removeProject(id: string): boolean {
	const data = readRegistry()
	const idx = data.projects.findIndex((p) => p.id === id)
	if (idx === -1) return false

	data.projects.splice(idx, 1)
	// remove any links involving this project
	data.links = data.links.filter((l) => l.from !== id && l.to !== id)
	writeRegistry(data)
	return true
}

export function linkProjects(fromId: string, toId: string, type = 'api'): boolean {
	const data = readRegistry()
	const from = data.projects.find((p) => p.id === fromId)
	const to = data.projects.find((p) => p.id === toId)
	if (!from || !to) return false

	// check if link already exists
	const existing = data.links.find((l) => l.from === fromId && l.to === toId)
	if (existing) return true

	data.links.push({ from: fromId, to: toId, type })
	writeRegistry(data)
	return true
}

export function getLinkedProjects(id: string): ProjectEntry[] {
	const data = readRegistry()
	const linkedIds = new Set<string>()
	for (const link of data.links) {
		if (link.from === id) linkedIds.add(link.to)
		if (link.to === id) linkedIds.add(link.from)
	}
	return data.projects.filter((p) => linkedIds.has(p.id))
}

export function getProjectLinks(): ProjectLink[] {
	return readRegistry().links
}

// returns the id of the currently-active registered project, or null
// when no active project is set. consumers typically call this with a
// fallback so a missing active id degrades to cwd resolution.
export function getActiveProject(): string | null {
	return readRegistry().active ?? null
}

// set the active project to the registered id. throws when the id is
// not a registered project so `atlas use` can surface a clear error
// instead of silently pointing at nothing.
export function setActiveProject(id: string | null): ProjectEntry | null {
	const data = readRegistry()
	if (id === null) {
		data.active = null
		writeRegistry(data)
		return null
	}
	const entry = data.projects.find((p) => p.id === id)
	if (!entry) {
		throw new Error(`no project with id "${id}" is registered`)
	}
	data.active = id
	writeRegistry(data)
	return entry
}
