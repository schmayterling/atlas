import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentHash } from '../../shared/identity.js'
import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'
import type { DiscoveredFile } from './file-discovery.js'

export interface ChangeSet {
	added: string[]
	modified: string[]
	deleted: string[]
	configChanged: boolean
	branchChanged: boolean
	isFullReindex: boolean
}

export function detectChanges(
	projectRoot: string,
	discoveredFiles: DiscoveredFile[],
	store: AtlasStore,
): ChangeSet {
	const existingFiles = store.getAllFiles()

	// first-time index: everything is new
	if (existingFiles.length === 0) {
		return {
			added: discoveredFiles.map((f) => f.path),
			modified: [],
			deleted: [],
			configChanged: false,
			branchChanged: false,
			isFullReindex: true,
		}
	}

	const configChanged = hasConfigChanged(projectRoot, store)
	const branchChanged = hasBranchChanged(projectRoot, store)

	// if branch changed, force full reindex (resolution can change entirely)
	if (branchChanged) {
		log.info('branch changed, forcing full reindex')
		return {
			added: discoveredFiles.map((f) => f.path),
			modified: [],
			deleted: [],
			configChanged,
			branchChanged: true,
			isFullReindex: true,
		}
	}

	// try git-based detection first
	const gitChanges = tryGitDiff(projectRoot, store)
	if (gitChanges) {
		return { ...gitChanges, configChanged, branchChanged: false, isFullReindex: false }
	}

	// fallback: content hash comparison
	return {
		...hashBasedDiff(discoveredFiles, store),
		configChanged,
		branchChanged: false,
		isFullReindex: false,
	}
}

function tryGitDiff(
	projectRoot: string,
	store: AtlasStore,
): { added: string[]; modified: string[]; deleted: string[] } | null {
	const lastCommit = store.getMeta('last_indexed_commit')
	if (!lastCommit || !/^[0-9a-f]{40}$/.test(lastCommit)) return null

	try {
		const result = Bun.spawnSync(
			['git', 'diff', '--name-status', lastCommit, 'HEAD'],
			{ cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
		)

		if (result.exitCode !== 0) return null

		const output = result.stdout.toString().trim()
		if (!output) return { added: [], modified: [], deleted: [] }

		const added: string[] = []
		const modified: string[] = []
		const deleted: string[] = []

		for (const line of output.split('\n')) {
			const [status, ...parts] = line.split('\t')
			const filePath = parts.join('\t')
			if (!filePath) continue

			switch (status?.[0]) {
				case 'A':
					added.push(filePath)
					break
				case 'M':
					modified.push(filePath)
					break
				case 'D':
					deleted.push(filePath)
					break
				case 'R':
					// rename: old path deleted, new path added
					if (parts[0]) deleted.push(parts[0])
					if (parts[1]) added.push(parts[1])
					break
			}
		}

		return { added, modified, deleted }
	} catch {
		return null
	}
}

function hashBasedDiff(
	discoveredFiles: DiscoveredFile[],
	store: AtlasStore,
): { added: string[]; modified: string[]; deleted: string[] } {
	const existingFiles = store.getAllFiles()
	const existingByPath = new Map(existingFiles.map((f) => [f.path, f.contentHash]))
	const discoveredPaths = new Set(discoveredFiles.map((f) => f.path))

	const added: string[] = []
	const modified: string[] = []
	const deleted: string[] = []

	for (const file of discoveredFiles) {
		const existing = existingByPath.get(file.path)
		if (!existing) {
			added.push(file.path)
		} else {
			// compare content hash
			try {
				const content = readFileSync(file.absolutePath)
				const hash = contentHash(content)
				if (hash !== existing) {
					modified.push(file.path)
				}
			} catch {
				modified.push(file.path)
			}
		}
	}

	for (const existing of existingFiles) {
		if (!discoveredPaths.has(existing.path)) {
			deleted.push(existing.path)
		}
	}

	return { added, modified, deleted }
}

function hasConfigChanged(projectRoot: string, store: AtlasStore): boolean {
	const storedHash = store.getMeta('config_hash')
	const currentHash = computeConfigHash(projectRoot)
	return storedHash !== currentHash
}

function hasBranchChanged(projectRoot: string, store: AtlasStore): boolean {
	const storedBranch = store.getMeta('last_branch')
	const currentBranch = getCurrentBranch(projectRoot)
	if (!storedBranch || !currentBranch) return false
	return storedBranch !== currentBranch
}

export function getCurrentBranch(projectRoot: string): string | null {
	try {
		const result = Bun.spawnSync(
			['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
			{ cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
		)
		if (result.exitCode !== 0) return null
		return result.stdout.toString().trim()
	} catch {
		return null
	}
}

export function getCurrentCommit(projectRoot: string): string | null {
	try {
		const result = Bun.spawnSync(
			['git', 'rev-parse', 'HEAD'],
			{ cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
		)
		if (result.exitCode !== 0) return null
		return result.stdout.toString().trim()
	} catch {
		return null
	}
}

export function computeConfigHash(projectRoot: string): string {
	const parts: string[] = []

	for (const configFile of ['tsconfig.json', 'package.json']) {
		try {
			const content = readFileSync(join(projectRoot, configFile), 'utf-8')
			parts.push(content)
		} catch {
			// file doesn't exist, that's fine
		}
	}

	return contentHash(parts.join('\n'))
}
