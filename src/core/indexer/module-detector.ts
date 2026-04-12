import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import type { DiscoveredFile } from './file-discovery.js'

// one detected repo module. kind is derived from the manifest file.
// module_path is populated when the manifest supplies it (the go.mod
// module path, the package.json "name" field, etc.) and null otherwise.
export interface RepoModule {
	id: string
	name: string
	kind: 'go' | 'node' | 'python'
	manifestPath: string
	rootDir: string
	modulePath: string | null
}

// walk the discovered file list looking for package manifest files.
// only files already returned by file-discovery are considered, so
// the usual include/exclude filters apply (no runaway node_modules
// traversal). multiple manifests of the same kind are allowed — a
// monorepo with apps/api/go.mod and apps/worker/go.mod gets two go
// modules.
export function detectRepoModules(
	projectRoot: string,
	discovered: DiscoveredFile[],
): RepoModule[] {
	// only look at known manifest file names. discovered may not
	// include manifests at all (they're not typically .ts/.go/.py)
	// so we fall back to probing the filesystem under each directory
	// containing a discovered file. this keeps the walk bounded to
	// directories we already care about.
	const dirs = new Set<string>()
	for (const file of discovered) {
		const rel = file.path
		// collect every ancestor directory relative to the project root
		const parts = rel.split('/')
		for (let i = parts.length - 1; i >= 0; i--) {
			const sub = parts.slice(0, i).join('/')
			dirs.add(sub)
		}
	}

	const modules: RepoModule[] = []
	const seen = new Set<string>()

	for (const dir of dirs) {
		probeManifest(projectRoot, dir, 'go', modules, seen)
		probeManifest(projectRoot, dir, 'node', modules, seen)
		probeManifest(projectRoot, dir, 'python', modules, seen)
	}

	return modules
}

const MANIFEST_NAMES: Record<RepoModule['kind'], string[]> = {
	go: ['go.mod'],
	node: ['package.json'],
	python: ['pyproject.toml', 'setup.py'],
}

function probeManifest(
	projectRoot: string,
	relDir: string,
	kind: RepoModule['kind'],
	out: RepoModule[],
	seen: Set<string>,
): void {
	for (const name of MANIFEST_NAMES[kind]) {
		const relManifest = relDir ? `${relDir}/${name}` : name
		if (seen.has(relManifest)) continue
		const absPath = join(projectRoot, relManifest)
		if (!existsSync(absPath)) continue
		seen.add(relManifest)

		try {
			const rawContent = readFileSync(absPath, 'utf-8')
			const parsed = parseManifest(kind, rawContent)
			if (!parsed) continue
			const id = createHash('sha256').update(relManifest).digest('hex').slice(0, 16)
			out.push({
				id,
				name: parsed.name,
				kind,
				manifestPath: relManifest,
				rootDir: relDir,
				modulePath: parsed.modulePath,
			})
		} catch {
			// manifest exists but can't be parsed — skip silently so a
			// malformed package.json doesn't break indexing.
		}
	}
}

interface ParsedManifest {
	name: string
	modulePath: string | null
}

function parseManifest(kind: RepoModule['kind'], content: string): ParsedManifest | null {
	if (kind === 'go') {
		// first `module <path>` line wins. stdlib gomod files always
		// emit the module directive.
		const match = content.match(/^\s*module\s+(\S+)/m)
		if (!match) return null
		const modulePath = match[1]
		const parts = modulePath.split('/')
		return { name: parts[parts.length - 1] || modulePath, modulePath }
	}
	if (kind === 'node') {
		try {
			const data = JSON.parse(content)
			if (typeof data?.name !== 'string' || !data.name) return null
			return { name: data.name, modulePath: data.name }
		} catch {
			return null
		}
	}
	if (kind === 'python') {
		// pyproject.toml or setup.py — we don't parse either fully.
		// extract a plausible name from common shapes.
		const pyproj = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m)
		if (pyproj) return { name: pyproj[1], modulePath: pyproj[1] }
		const setupPy = content.match(/name\s*=\s*["']([^"']+)["']/)
		if (setupPy) return { name: setupPy[1], modulePath: setupPy[1] }
		return null
	}
	return null
}

// match a file path to the most specific repo module whose rootDir is
// a prefix of the file's path. returns null when no module covers it
// (e.g. files in the repo root with no top-level package.json).
export function matchFileToModule(
	filePath: string,
	modules: RepoModule[],
): RepoModule | null {
	let best: RepoModule | null = null
	let bestLen = -1
	for (const mod of modules) {
		if (mod.rootDir === '') {
			if (bestLen < 0) {
				best = mod
				bestLen = 0
			}
			continue
		}
		if (filePath === mod.rootDir || filePath.startsWith(`${mod.rootDir}/`)) {
			if (mod.rootDir.length > bestLen) {
				best = mod
				bestLen = mod.rootDir.length
			}
		}
	}
	return best
}

// exported for tests: the raw path-to-prefix match helper without
// requiring a real DiscoveredFile list.
export function _testOnlyRelative(root: string, abs: string): string {
	return relative(root, abs)
}
