import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #24: the hot-fragile preview column previously rendered the
// LLM-generated subsystem name, which was a comma-separated list of type
// names that repeated across unrelated files. the new previewNames field
// is populated by a window-function CTE returning this file's own first-3
// untested exported callables ordered by line_start.

let projectRoot: string
let engine: AtlasEngine

beforeAll(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-hot-fragile-'))
	mkdirSync(join(projectRoot, 'src'))
	mkdirSync(join(projectRoot, '.git'))
	// fake git history so file_changes gets populated. findHotFragile INNER
	// JOINs file_changes so without a commit history the query returns
	// nothing. index-cmd reads git via libgit2/simple-git; we skip that by
	// INSERTing directly into file_changes after the index.

	// a production file with 5 exported untested callables. we expect
	// exactly the first 3 (by line_start) to land in previewNames.
	writeFileSync(
		join(projectRoot, 'src/hot.ts'),
		[
			'export function alpha(): number { return 1 }',
			'export function beta(): number { return 2 }',
			'export function gamma(): number { return 3 }',
			'export function delta(): number { return 4 }',
			'export function epsilon(): number { return 5 }',
		].join('\n'),
	)

	// a production file with ONE untested callable — previewNames should
	// contain exactly that one name, regardless of partition.
	writeFileSync(
		join(projectRoot, 'src/cold.ts'),
		'export function solo(): number { return 0 }\n',
	)

	engine = new AtlasEngine(projectRoot)
	await engine.index({ noEmbed: true, noSummarize: true, force: true })

	// fake churn so hot-fragile surfaces these files. findHotFragile joins
	// file_changes via file_path so we insert commits and file_changes rows
	// pointing at both paths.
	const store = engine.getStoreForCrossProject()
	store.queryRaw(
		`INSERT INTO commits (hash, author_name, author_email, authored_at, subject)
		 VALUES ('sha1', 'a', 'a@x', 1700000000, 'm1'),
		        ('sha2', 'a', 'a@x', 1700000100, 'm2'),
		        ('sha3', 'a', 'a@x', 1700000200, 'm3')`,
	)
	store.queryRaw(
		`INSERT INTO file_changes (commit_hash, file_path, status)
		 VALUES ('sha1', 'src/hot.ts', 'A'),
		        ('sha2', 'src/hot.ts', 'M'),
		        ('sha3', 'src/hot.ts', 'M'),
		        ('sha1', 'src/cold.ts', 'A')`,
	)
})

afterAll(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('hot-fragile previewNames', () => {
	test('emits the first 3 untested callables per file ordered by line_start', () => {
		const rows = engine.hotFragile({ limit: 10 })
		const hot = rows.find((r) => r.filePath === 'src/hot.ts')
		expect(hot).toBeDefined()
		expect(hot?.previewNames).toEqual(['alpha', 'beta', 'gamma'])
	})

	test('emits a single-entry preview for a file with one untested callable', () => {
		const rows = engine.hotFragile({ limit: 10 })
		const cold = rows.find((r) => r.filePath === 'src/cold.ts')
		expect(cold).toBeDefined()
		expect(cold?.previewNames).toEqual(['solo'])
	})

	test('preview names are the file own untested symbols, never cross-file', () => {
		const rows = engine.hotFragile({ limit: 10 })
		const hot = rows.find((r) => r.filePath === 'src/hot.ts')
		const cold = rows.find((r) => r.filePath === 'src/cold.ts')
		// the original #24 complaint was that the same 3 names repeated
		// across unrelated files. pin that they are now distinct.
		expect(hot?.previewNames).not.toEqual(cold?.previewNames)
	})

	test('explicit churnScore and fragilityScore fields match commits * untestedCount', () => {
		const rows = engine.hotFragile({ limit: 10 })
		const hot = rows.find((r) => r.filePath === 'src/hot.ts')
		expect(hot).toBeDefined()
		// pinned by the fixture's 3 commits touching hot.ts and 5
		// untested callables. churnScore is a pure churn proxy and
		// fragilityScore is the ranking dimension. #43.
		expect(hot?.churnScore).toBeGreaterThan(0)
		expect(hot?.churnScore).toBe(hot?.commits ?? -1)
		expect(hot?.fragilityScore).toBe((hot?.commits ?? 0) * (hot?.untestedCount ?? 0))
	})
})
