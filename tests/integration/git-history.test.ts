import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingestGitHistory, parseGitLog } from '../../src/core/indexer/git-history.js'
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
	const root = mkdtempSync(join(tmpdir(), 'atlas-git-test-'))
	git(['init', '-q', '-b', 'main'], root)
	git(['config', 'user.email', 'test@example.com'], root)
	git(['config', 'user.name', 'Test User'], root)
	git(['config', 'commit.gpgsign', 'false'], root)
	return root
}

function commit(root: string, files: Record<string, string>, message: string): void {
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path)
		const dir = full.slice(0, full.lastIndexOf('/'))
		if (dir && dir !== root) mkdirSync(dir, { recursive: true })
		writeFileSync(full, content)
	}
	git(['add', '-A'], root)
	git(['commit', '-q', '-m', message], root)
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

describe('parseGitLog', () => {
	const HASH_A = '0000000000000000000000000000000000000001'
	const HASH_B = '0000000000000000000000000000000000000002'
	const HASH_C = '0000000000000000000000000000000000000003'

	test('parses a single commit with one file change', () => {
		const raw = `@@ATLASCOMMIT@@${HASH_A}\tAlice\talice@x.com\t1700000000\tinitial\nA\tfile1.ts\0`
		const commits = parseGitLog(raw)
		expect(commits.length).toBe(1)
		expect(commits[0].hash).toBe(HASH_A)
		expect(commits[0].authorName).toBe('Alice')
		expect(commits[0].files.length).toBe(1)
		expect(commits[0].files[0].status).toBe('A')
		expect(commits[0].files[0].filePath).toBe('file1.ts')
	})

	test('parses a rename', () => {
		const raw = `@@ATLASCOMMIT@@${HASH_B}\tBob\tbob@x.com\t1700000001\trename\nR100\told.ts\0new.ts\0`
		const commits = parseGitLog(raw)
		expect(commits[0].files[0].status).toBe('R')
		expect(commits[0].files[0].filePath).toBe('new.ts')
		expect(commits[0].files[0].renameFrom).toBe('old.ts')
	})

	test('parses subjects containing tabs', () => {
		const raw = `@@ATLASCOMMIT@@${HASH_C}\tA\ta@x\t1700000002\tfix:\tdo a thing\nM\tx.ts\0`
		const commits = parseGitLog(raw)
		expect(commits[0].subject).toBe('fix:\tdo a thing')
	})

	test('rejects chunks whose first field is not a 40-char hex hash (COMMIT_MARKER collision guard)', () => {
		// a commit subject containing the literal marker would split mid-chunk
		// and produce a chunk whose hash field is non-hex; the parser should
		// drop it instead of inserting a junk row.
		const raw = `@@ATLASCOMMIT@@${HASH_A}\tA\ta@x\t1700000000\tweird @@ATLASCOMMIT@@junk\tB\tb@x\t1700000001\treal\nA\tfile.ts\0`
		const commits = parseGitLog(raw)
		// the only valid chunk is the leading one with HASH_A
		expect(commits.length).toBe(1)
		expect(commits[0].hash).toBe(HASH_A)
	})
})

describe('ingestGitHistory', () => {
	test('ingests commits and file changes from a fresh repo', () => {
		commit(repoRoot, { 'a.ts': 'a' }, 'add a')
		commit(repoRoot, { 'b.ts': 'b' }, 'add b')
		commit(repoRoot, { 'a.ts': 'a2' }, 'modify a')

		const result = ingestGitHistory(repoRoot, store)
		expect(result.skipped).toBe(false)
		expect(result.commitsAdded).toBe(3)
		expect(result.fileChangesAdded).toBe(3)

		const commits = store.queryRaw<{ subject: string }>('SELECT subject FROM commits')
		expect(new Set(commits.map((c) => c.subject))).toEqual(
			new Set(['add a', 'add b', 'modify a']),
		)
	})

	test('is idempotent on re-ingest with no new commits', () => {
		commit(repoRoot, { 'a.ts': 'a' }, 'add a')
		ingestGitHistory(repoRoot, store)
		const second = ingestGitHistory(repoRoot, store)
		expect(second.skipped).toBe(true)
		expect(second.reason).toBe('up to date')
		const count = store.queryRaw<{ c: number }>('SELECT COUNT(*) as c FROM commits')[0].c
		expect(count).toBe(1)
	})

	test('appends only new commits on incremental re-ingest', () => {
		commit(repoRoot, { 'a.ts': 'a' }, 'add a')
		ingestGitHistory(repoRoot, store)
		commit(repoRoot, { 'b.ts': 'b' }, 'add b')
		const result = ingestGitHistory(repoRoot, store)
		expect(result.skipped).toBe(false)
		expect(result.commitsAdded).toBe(1)
		const count = store.queryRaw<{ c: number }>('SELECT COUNT(*) as c FROM commits')[0].c
		expect(count).toBe(2)
	})

	test('detects force-push and re-ingests fully', () => {
		commit(repoRoot, { 'a.ts': 'a' }, 'add a')
		commit(repoRoot, { 'b.ts': 'b' }, 'add b')
		ingestGitHistory(repoRoot, store)

		// rewrite history: drop the second commit
		git(['reset', '--hard', 'HEAD~1'], repoRoot)
		commit(repoRoot, { 'c.ts': 'c' }, 'add c')

		const result = ingestGitHistory(repoRoot, store)
		expect(result.skipped).toBe(false)
		const subjects = new Set(
			store
				.queryRaw<{ subject: string }>('SELECT subject FROM commits')
				.map((c) => c.subject),
		)
		expect(subjects).toEqual(new Set(['add a', 'add c']))
	})

	test('records rename status with rename_from', () => {
		commit(repoRoot, { 'old.ts': 'x' }, 'add old')
		// git rename detection requires actual file move + content similarity
		Bun.spawnSync(['git', 'mv', 'old.ts', 'new.ts'], { cwd: repoRoot })
		git(['commit', '-q', '-m', 'rename'], repoRoot)

		const result = ingestGitHistory(repoRoot, store)
		expect(result.skipped).toBe(false)
		const renames = store.queryRaw<{ status: string; file_path: string; rename_from: string }>(
			"SELECT status, file_path, rename_from FROM file_changes WHERE status = 'R'",
		)
		expect(renames.length).toBe(1)
		expect(renames[0].file_path).toBe('new.ts')
		expect(renames[0].rename_from).toBe('old.ts')
	})

	test('does not skip merge commits', () => {
		commit(repoRoot, { 'a.ts': 'a' }, 'add a')
		git(['checkout', '-q', '-b', 'feature'], repoRoot)
		commit(repoRoot, { 'b.ts': 'b' }, 'add b on feature')
		git(['checkout', '-q', 'main'], repoRoot)
		commit(repoRoot, { 'c.ts': 'c' }, 'add c on main')
		git(['merge', '--no-ff', '-q', '-m', 'merge feature', 'feature'], repoRoot)

		const result = ingestGitHistory(repoRoot, store)
		const subjects = new Set(
			store.queryRaw<{ subject: string }>('SELECT subject FROM commits').map((c) => c.subject),
		)
		expect(subjects.has('merge feature')).toBe(true)
		expect(result.commitsAdded).toBeGreaterThanOrEqual(4)
	})

	test('skips when not a git repo', () => {
		const nonGit = mkdtempSync(join(tmpdir(), 'atlas-nongit-'))
		try {
			const result = ingestGitHistory(nonGit, store)
			expect(result.skipped).toBe(true)
		} finally {
			rmSync(nonGit, { recursive: true, force: true })
		}
	})
})
