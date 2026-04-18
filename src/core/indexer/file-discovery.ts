import { readdirSync, realpathSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import type { AtlasConfig } from '../../shared/config.js'
import { log } from '../../shared/logger.js'
import { toForwardSlash } from '../../shared/paths.js'
import { readGitignore } from './gitignore.js'

export interface DiscoveredFile {
	path: string
	absolutePath: string
	language: string
	sizeBytes: number
	isTest: boolean
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
	// merge in patterns from .gitignore at project root. only the root
	// gitignore is honored — nested .gitignore files in monorepo
	// subdirs are not (yet). users with subdirs that need exclusion
	// should put them in atlas.config.json's exclude array.
	const gitignore = readGitignore(projectRoot)
	const excludePatterns = [...config.exclude, ...gitignore.excludePatterns]
	const skipDirs = new Set([...SKIP_DIRS, ...gitignore.skipDirs])
	const testPatterns = config.testPatterns
	const files: DiscoveredFile[] = []

	// resolve projectRoot's own realpath once so the per-file symlink
	// containment check below compares realpath-to-realpath. on macOS
	// /tmp is a symlink to /private/tmp, so a test that indexes a
	// mkdtempSync directory would otherwise see every file as
	// escaping projectRoot. see #75 deep-review pass 6.
	let rootReal: string
	try {
		rootReal = realpathSync(projectRoot)
	} catch {
		rootReal = projectRoot
	}

	walk(projectRoot, projectRoot, rootReal, extensionToLanguage, excludePatterns, testPatterns, skipDirs, files)

	files.sort((a, b) => a.path.localeCompare(b.path))
	return files
}

function walk(
	dir: string,
	projectRoot: string,
	rootReal: string,
	extensionToLanguage: Map<string, string>,
	excludePatterns: string[],
	testPatterns: string[],
	skipDirs: Set<string>,
	results: DiscoveredFile[],
) {
	let names: string[]
	try {
		names = readdirSync(dir, { encoding: 'utf-8' }) as string[]
	} catch (e) {
		log.debug(`skipped directory ${dir}: ${e}`)
		return
	}

	for (const name of names) {
		const fullPath = join(dir, name)
		const relPath = toForwardSlash(relative(projectRoot, fullPath))

		let stat: ReturnType<typeof statSync>
		try {
			stat = statSync(fullPath)
		} catch (e) {
			log.debug(`skipped ${fullPath}: ${e}`)
			continue
		}

		if (stat.isDirectory()) {
			if (skipDirs.has(name)) continue
			if (matchesAnyPattern(relPath, excludePatterns)) continue
			walk(fullPath, projectRoot, rootReal, extensionToLanguage, excludePatterns, testPatterns, skipDirs, results)
		} else if (stat.isFile()) {
			if (matchesAnyPattern(relPath, excludePatterns)) continue

			const ext = extname(name)
			const language = extensionToLanguage.get(ext)
			if (!language) continue

			// symlink containment guard: statSync follows symlinks by
			// default, so a symlinked file whose real path escapes
			// projectRoot would otherwise be indexed and read. reject
			// anything whose realpath isn't under projectRoot (resolved
			// once up top so /tmp -> /private/tmp on macOS doesn't
			// trip every test-fixture). see #75 deep-review pass 6.
			let realAbs: string
			try {
				realAbs = realpathSync(fullPath)
			} catch (e) {
				log.debug(`skipped ${fullPath}: realpath failed: ${e}`)
				continue
			}
			const normRoot = rootReal.endsWith('/') ? rootReal : `${rootReal}/`
			if (realAbs !== rootReal && !realAbs.startsWith(normRoot)) {
				log.debug(`skipped ${fullPath}: resolves outside project root`)
				continue
			}

			const sizeBytes = stat.size

			results.push({
				path: relPath,
				absolutePath: fullPath,
				language,
				sizeBytes,
				isTest: matchesAnyPattern(relPath, testPatterns),
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

	// **/dir/** -> matches any path containing /dir/. checked BEFORE the
	// **/<glob> branch because '**/tests/**' would otherwise be parsed as a
	// flat-file glob ('tests/**') and never match directory descendants.
	if (pattern.startsWith('**/') && pattern.endsWith('/**')) {
		const dir = pattern.slice(3, -3)
		if (!dir) return false
		return path.includes(`/${dir}/`) || path.startsWith(`${dir}/`)
	}

	// **/*.foo.* or **/*.ext -> matches pattern like **/*.test.* or **/*.ts
	if (pattern.startsWith('**/') && pattern.includes('*')) {
		// extract the part after **/ e.g. "*.test.*" or "*.ts"
		const glob = pattern.slice(3)
		// convert simple glob to regex: * becomes [^/]*, . is escaped
		const regexStr = glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')
		try {
			const regex = new RegExp(`(^|/)${regexStr}$`)
			return regex.test(path)
		} catch {
			return false
		}
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

