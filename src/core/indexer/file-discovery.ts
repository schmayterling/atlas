import { readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import type { AtlasConfig } from '../../shared/config.js'

export interface DiscoveredFile {
	path: string
	absolutePath: string
	language: string
	sizeBytes: number
}

// directories to always skip
const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'.atlas',
	'.next',
	'.nuxt',
	'.output',
	'coverage',
	'__pycache__',
])

export function discoverFiles(projectRoot: string, config: AtlasConfig): DiscoveredFile[] {
	const extensionToLanguage = buildExtensionMap(config)
	const excludePatterns = config.exclude
	const files: DiscoveredFile[] = []

	walk(projectRoot, projectRoot, extensionToLanguage, excludePatterns, files)

	files.sort((a, b) => a.path.localeCompare(b.path))
	return files
}

function walk(
	dir: string,
	projectRoot: string,
	extensionToLanguage: Map<string, string>,
	excludePatterns: string[],
	results: DiscoveredFile[],
) {
	let names: string[]
	try {
		names = readdirSync(dir, { encoding: 'utf-8' }) as string[]
	} catch {
		return
	}

	for (const name of names) {
		const fullPath = join(dir, name)
		const relPath = toForwardSlash(relative(projectRoot, fullPath))

		let stat: ReturnType<typeof statSync>
		try {
			stat = statSync(fullPath)
		} catch {
			continue
		}

		if (stat.isDirectory()) {
			if (SKIP_DIRS.has(name)) continue
			if (matchesAnyPattern(relPath, excludePatterns)) continue
			walk(fullPath, projectRoot, extensionToLanguage, excludePatterns, results)
		} else if (stat.isFile()) {
			if (matchesAnyPattern(relPath, excludePatterns)) continue

			const ext = extname(name)
			const language = extensionToLanguage.get(ext)
			if (!language) continue

			const sizeBytes = stat.size

			results.push({
				path: relPath,
				absolutePath: fullPath,
				language,
				sizeBytes,
			})
		}
	}
}

function buildExtensionMap(config: AtlasConfig): Map<string, string> {
	const map = new Map<string, string>()
	for (const [language, def] of Object.entries(config.languages)) {
		for (const ext of def.extensions) {
			map.set(ext, language)
		}
	}
	return map
}

// simple glob matching for exclude patterns
// supports: **/dir/**, *.ext, dir/*, prefix**
function matchesAnyPattern(path: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (matchPattern(path, pattern)) return true
	}
	return false
}

function matchPattern(path: string, pattern: string): boolean {
	// exact match
	if (path === pattern) return true

	// **/*.ext -> matches any file with that extension
	if (pattern.startsWith('**/') && pattern.includes('*.')) {
		const ext = pattern.slice(pattern.lastIndexOf('.'))
		return path.endsWith(ext)
	}

	// **/dir/** -> matches any path containing /dir/
	if (pattern.startsWith('**/') && pattern.endsWith('/**')) {
		const dir = pattern.slice(3, -3)
		return path.includes(`/${dir}/`) || path.startsWith(`${dir}/`)
	}

	// **/dir -> matches directory name anywhere
	if (pattern.startsWith('**/')) {
		const suffix = pattern.slice(3)
		return path.endsWith(suffix) || path.includes(`/${suffix}/`)
	}

	// *.ext -> matches extension
	if (pattern.startsWith('*.')) {
		const ext = pattern.slice(1)
		return path.endsWith(ext)
	}

	return false
}

function toForwardSlash(p: string): string {
	return p.replace(/\\/g, '/')
}
