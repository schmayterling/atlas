import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentHash } from '../../shared/identity.js'
import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'
import type { DiscoveredFile } from './file-discovery.js'

export interface FileRename {
	oldPath: string
	newPath: string
}

export interface ChangeSet {
	added: string[]
	modified: string[]
	deleted: string[]
	// renames detected from git diff -M. the old path is absent from
	// deleted and the new path is absent from added: the rename handler
	// in the indexer rewrites identity in place instead. rename-with-edit
	// also appears in modified (same newPath) so step 5 re-parses the
	// content, but step 4 still uses files.path so the cascade works.
	renames: FileRename[]
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
			renames: [],
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
			renames: [],
			configChanged,
			branchChanged: true,
			isFullReindex: true,
		}
	}

	// try git-based detection first
	const gitChanges = detectChangesViaGit(projectRoot, store, discoveredFiles, existingFiles)
	if (gitChanges) {
		return { ...gitChanges, configChanged, branchChanged: false, isFullReindex: false }
	}

	// fallback: content hash comparison. hash-based diff can't detect
	// renames (it has no git to ask) so renames degrade to add+delete.
	return {
		...hashBasedDiff(discoveredFiles, existingFiles),
		renames: [],
		configChanged,
		branchChanged: false,
		isFullReindex: false,
	}
}

// hybrid detector: uses `git diff -M` for the modified + rename sets and
// falls back to a set difference between discovered + existing files for
// added/deleted. set diff is the only way to catch untracked files (which
// git diff omits) and makes the function tolerant of empty git output.
// renames are returned as {oldPath, newPath} pairs so the indexer can
// rewrite symbol identity in place without a delete+insert cycle.
function detectChangesViaGit(
	projectRoot: string,
	store: AtlasStore,
	discoveredFiles: DiscoveredFile[],
	existingFiles: { path: string }[],
): { added: string[]; modified: string[]; deleted: string[]; renames: FileRename[] } | null {
	const lastCommit = store.getMeta('last_indexed_commit')
	if (!lastCommit || !/^[0-9a-f]{40}$/.test(lastCommit)) return null

	// `git diff --name-status -M <lastCommit>` (no second ref) compares the
	// working tree to the commit, so it sees both committed deltas and
	// uncommitted edits to tracked files. -M enables rename detection so
	// R<score>\told\tnew rows surface instead of degrading to add+delete.
	// untracked files are still missed by git diff; those are caught by
	// the set diff against the store below.
	const gitModified = new Set<string>()
	const renames: FileRename[] = []
	try {
		const result = Bun.spawnSync(
			['git', 'diff', '--name-status', '-M', lastCommit],
			{ cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
		)
		if (result.exitCode !== 0) return null

		for (const line of result.stdout.toString().split('\n')) {
			if (!line) continue
			const [status, ...parts] = line.split('\t')
			if (parts.length === 0) continue
			const code = status?.[0]
			if (code === 'M' || code === 'T') {
				gitModified.add(parts.join('\t'))
			} else if (code === 'R' && parts.length >= 2) {
				// R<score>\told\tnew. record the pair so the rename step
				// in the indexer can rewrite identity, and also mark the new
				// path as modified so content edits on top of the rename are
				// re-parsed by step 5.
				renames.push({ oldPath: parts[0], newPath: parts[1] })
				gitModified.add(parts[1])
			}
		}
	} catch {
		return null
	}

	// strip rename sources from "deleted": the rename handler updates
	// the existing file row in place. rename targets do NOT get stripped
	// from "added" or "modified": the rename handler rewrites FK tables
	// keyed by stable_id, but content edits on top of the rename still
	// need step 5 to re-parse and refresh symbols, edges, hashes, and
	// line ranges. so:
	//   - renamed source: drop from deleted (file row is preserved)
	//   - renamed target: drop from added (row already exists) but if
	//     git sees a concurrent content edit, push into modified so
	//     step 5 re-parses
	const renamedOld = new Set(renames.map((r) => r.oldPath))
	const renamedNew = new Set(renames.map((r) => r.newPath))

	const existingPaths = new Set(existingFiles.map((f) => f.path))
	const added: string[] = []
	const modified: string[] = []
	const deleted: string[] = []
	const seen = new Set<string>()

	for (const file of discoveredFiles) {
		seen.add(file.path)
		if (renamedNew.has(file.path)) {
			// rename target: handler owns the file row. re-parse only when
			// git flagged a content delta on top of the rename (rename+edit).
			if (gitModified.has(file.path)) modified.push(file.path)
			continue
		}
		if (!existingPaths.has(file.path)) {
			added.push(file.path)
		} else if (gitModified.has(file.path)) {
			modified.push(file.path)
		}
	}
	for (const f of existingFiles) {
		if (seen.has(f.path)) continue
		if (renamedOld.has(f.path)) continue // handled by rename step
		deleted.push(f.path)
	}

	return { added, modified, deleted, renames }
}

function hashBasedDiff(
	discoveredFiles: DiscoveredFile[],
	existingFiles: { path: string; contentHash: string }[],
): { added: string[]; modified: string[]; deleted: string[] } {
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

function runGitRevParse(projectRoot: string, args: string[]): string | null {
	try {
		const result = Bun.spawnSync(
			['git', 'rev-parse', ...args],
			{ cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
		)
		if (result.exitCode !== 0) return null
		return result.stdout.toString().trim()
	} catch {
		return null
	}
}

export function getCurrentBranch(projectRoot: string): string | null {
	return runGitRevParse(projectRoot, ['--abbrev-ref', 'HEAD'])
}

export function getCurrentCommit(projectRoot: string): string | null {
	return runGitRevParse(projectRoot, ['HEAD'])
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
