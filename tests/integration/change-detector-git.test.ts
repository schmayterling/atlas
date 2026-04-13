import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectChanges } from '../../src/core/indexer/change-detector.js'
import type { DiscoveredFile } from '../../src/core/indexer/file-discovery.js'
import type { AtlasStore } from '../../src/core/storage/store.js'
import { createTempStore, type TempStore } from '../helpers/tmp-store.js'

let temp: TempStore
let store: AtlasStore
let repoRoot: string

function git(args: string[], cwd: string): string {
	const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
	if (r.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`)
	}
	return r.stdout.toString().trim()
}

function makeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), 'atlas-cd-test-'))
	git(['init', '-q', '-b', 'main'], root)
	git(['config', 'user.email', 'test@example.com'], root)
	git(['config', 'user.name', 'Test User'], root)
	git(['config', 'commit.gpgsign', 'false'], root)
	return root
}

function commit(root: string, files: Record<string, string>, message: string): string {
	for (const [path, content] of Object.entries(files)) {
		writeFileSync(join(root, path), content)
	}
	git(['add', '-A'], root)
	git(['commit', '-q', '-m', message], root)
	return git(['rev-parse', 'HEAD'], root)
}

function df(root: string, path: string): DiscoveredFile {
	return { path, absolutePath: join(root, path), language: 'typescript', sizeBytes: 1, isTest: false }
}

beforeEach(() => {
	temp = createTempStore()
	store = temp.store
	repoRoot = makeRepo()
})

afterEach(() => {
	temp.cleanup()
	rmSync(repoRoot, { recursive: true, force: true })
})

describe('detectChanges (git path)', () => {
	test('untracked file is detected as added even when git diff is empty', () => {
		const head = commit(repoRoot, { 'a.ts': 'a' }, 'init')
		store.insertFile('a.ts', 'h-a', 'typescript', 1)
		store.setMeta('last_indexed_commit', head)
		store.setMeta('last_branch', 'main')

		// new file on disk, never staged or committed
		writeFileSync(join(repoRoot, 'b.ts'), 'b')

		const changes = detectChanges(repoRoot, [df(repoRoot, 'a.ts'), df(repoRoot, 'b.ts')], store)
		expect(changes.added).toEqual(['b.ts'])
		expect(changes.modified).toEqual([])
		expect(changes.deleted).toEqual([])
	})

	test('uncommitted edit to a tracked file is detected as modified', () => {
		const head = commit(repoRoot, { 'a.ts': 'original' }, 'init')
		store.insertFile('a.ts', 'h-a', 'typescript', 1)
		store.setMeta('last_indexed_commit', head)
		store.setMeta('last_branch', 'main')

		// edit without committing
		writeFileSync(join(repoRoot, 'a.ts'), 'edited content')

		const changes = detectChanges(repoRoot, [df(repoRoot, 'a.ts')], store)
		expect(changes.modified).toEqual(['a.ts'])
		expect(changes.added).toEqual([])
		expect(changes.deleted).toEqual([])
	})

	test('file removed from disk is detected as deleted', () => {
		const head = commit(repoRoot, { 'a.ts': 'a', 'b.ts': 'b' }, 'init')
		store.insertFile('a.ts', 'h-a', 'typescript', 1)
		store.insertFile('b.ts', 'h-b', 'typescript', 1)
		store.setMeta('last_indexed_commit', head)
		store.setMeta('last_branch', 'main')

		unlinkSync(join(repoRoot, 'b.ts'))

		const changes = detectChanges(repoRoot, [df(repoRoot, 'a.ts')], store)
		expect(changes.deleted).toEqual(['b.ts'])
		expect(changes.added).toEqual([])
		expect(changes.modified).toEqual([])
	})

	test('committed delta since last index is detected as modified', () => {
		const first = commit(repoRoot, { 'a.ts': 'v1' }, 'init')
		store.insertFile('a.ts', 'h-a-v1', 'typescript', 1)
		store.setMeta('last_indexed_commit', first)
		store.setMeta('last_branch', 'main')

		// commit a change to a.ts after the watermark
		commit(repoRoot, { 'a.ts': 'v2' }, 'edit a')

		const changes = detectChanges(repoRoot, [df(repoRoot, 'a.ts')], store)
		expect(changes.modified).toEqual(['a.ts'])
	})

	test('mixed: untracked add + uncommitted edit + on-disk delete in one pass', () => {
		const head = commit(repoRoot, { 'a.ts': 'a', 'b.ts': 'b' }, 'init')
		store.insertFile('a.ts', 'h-a', 'typescript', 1)
		store.insertFile('b.ts', 'h-b', 'typescript', 1)
		store.setMeta('last_indexed_commit', head)
		store.setMeta('last_branch', 'main')

		writeFileSync(join(repoRoot, 'a.ts'), 'edited')
		unlinkSync(join(repoRoot, 'b.ts'))
		writeFileSync(join(repoRoot, 'c.ts'), 'c')

		const changes = detectChanges(repoRoot, [df(repoRoot, 'a.ts'), df(repoRoot, 'c.ts')], store)
		expect(changes.added).toEqual(['c.ts'])
		expect(changes.modified).toEqual(['a.ts'])
		expect(changes.deleted).toEqual(['b.ts'])
	})

	test('committed rename appears as renames, not add+delete', () => {
		const first = commit(repoRoot, { 'foo.ts': 'export function hello() { return 1 }\n' }, 'init')
		store.insertFile('foo.ts', 'h-foo', 'typescript', 1)
		store.setMeta('last_indexed_commit', first)
		store.setMeta('last_branch', 'main')

		git(['mv', 'foo.ts', 'bar.ts'], repoRoot)
		commit(repoRoot, {}, 'rename foo -> bar')

		const changes = detectChanges(repoRoot, [df(repoRoot, 'bar.ts')], store)
		expect(changes.renames).toHaveLength(1)
		expect(changes.renames[0]).toEqual({ oldPath: 'foo.ts', newPath: 'bar.ts' })
		// old path is NOT in deleted; new path is NOT in added. the new path
		// should appear in modified so step 5 can still re-parse in case of
		// concurrent edits (git still reports R for pure renames).
		expect(changes.deleted).not.toContain('foo.ts')
		expect(changes.added).not.toContain('bar.ts')
	})

	test('rename + small content edit surfaces the pair and marks the new path modified', () => {
		// write a file big enough that a single-line edit stays above git's
		// default 50% similarity threshold for rename detection.
		const body =
			[
				'export function hello() {',
				'  const a = 1',
				'  const b = 2',
				'  const c = 3',
				'  const d = 4',
				'  const e = 5',
				'  return a + b + c + d + e',
				'}',
				'',
				'export function world() {',
				'  return hello() * 2',
				'}',
				'',
			].join('\n')
		const first = commit(repoRoot, { 'foo.ts': body }, 'init')
		store.insertFile('foo.ts', 'h-foo', 'typescript', body.length)
		store.setMeta('last_indexed_commit', first)
		store.setMeta('last_branch', 'main')

		// rename-with-small-edit in one commit; git should still report R
		git(['mv', 'foo.ts', 'bar.ts'], repoRoot)
		writeFileSync(join(repoRoot, 'bar.ts'), body.replace('const a = 1', 'const a = 7'))
		commit(repoRoot, {}, 'rename + edit')

		const changes = detectChanges(repoRoot, [df(repoRoot, 'bar.ts')], store)
		expect(changes.renames).toHaveLength(1)
		expect(changes.renames[0]).toEqual({ oldPath: 'foo.ts', newPath: 'bar.ts' })
	})

	test('stale lastCommit (force-pushed-away) falls back to hash-based diff', () => {
		// the watermark hash exists nowhere; git diff will fail and tryGitDiff
		// must return null so the hash-based fallback handles detection.
		commit(repoRoot, { 'a.ts': 'a' }, 'init')
		store.insertFile('a.ts', 'h-a', 'typescript', 1)
		store.setMeta('last_indexed_commit', '0'.repeat(40))
		store.setMeta('last_branch', 'main')

		writeFileSync(join(repoRoot, 'b.ts'), 'b')

		const changes = detectChanges(repoRoot, [df(repoRoot, 'a.ts'), df(repoRoot, 'b.ts')], store)
		expect(changes.added).toEqual(['b.ts'])
	})
})
