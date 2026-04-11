import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
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
}

const REGISTRY_DIR = join(process.env.HOME ?? '~', '.atlas')
const REGISTRY_PATH = join(REGISTRY_DIR, 'registry.json')

function readRegistry(): RegistryData {
	if (!existsSync(REGISTRY_PATH)) {
		return { projects: [], links: [] }
	}
	try {
		return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'))
	} catch (e) {
		log.warn(`failed to read registry: ${e}`)
		return { projects: [], links: [] }
	}
}

function writeRegistry(data: RegistryData) {
	if (!existsSync(REGISTRY_DIR)) {
		mkdirSync(REGISTRY_DIR, { recursive: true })
	}
	writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2))
}

function generateId(root: string): string {
	return basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-')
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

	const id = generateId(absRoot)
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
