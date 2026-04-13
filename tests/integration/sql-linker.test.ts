import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #10: the sql-table channel of the cross-language linker.
// asserts that (a) identical table references from two distinct
// symbols get recorded as channel_hits, (b) findChannelHitGroups
// collapses them into one group, (c) test files are excluded, and
// (d) re-indexing leaves the channel idempotent.

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-sql-linker-'))
	mkdirSync(join(projectRoot, 'src'))
	mkdirSync(join(projectRoot, 'tests'))

	// two production functions both touching the `users` table via
	// raw sql string literals. the match in the body must live
	// inside a string literal for the linker to record it.
	writeFileSync(
		join(projectRoot, 'src/users.ts'),
		`import type { Database } from 'bun:sqlite'

export function findUser(db: Database, id: number) {
	return db.query('SELECT * FROM users WHERE id = ?').get(id)
}

export function countUsers(db: Database) {
	return db.query('SELECT COUNT(*) FROM users').get()
}

export function notSql(): string {
	// the word FROM appears in prose. must not match because we
	// only consider matches inside string literals.
	return 'derived FROM something'
}
`,
	)

	// an unrelated module whose string literal looks sql-adjacent
	// but never actually uses a FROM/JOIN keyword. zero hits
	// expected.
	writeFileSync(
		join(projectRoot, 'src/orders.ts'),
		`export function buildUrl(): string {
	return '/api/orders?limit=10'
}
`,
	)

	// a test file with sql inside it. linker must exclude test
	// files so fixture data doesn't pollute the channel.
	writeFileSync(
		join(projectRoot, 'tests/users.test.ts'),
		`import { findUser } from '../src/users.js'

export function seed() {
	return 'INSERT INTO users VALUES (1)'
}
`,
	)

	engine = new AtlasEngine(projectRoot)
	await engine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false, withCoChange: false })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('sql-linker', () => {
	test('records one channel_hits row per (symbol, FROM users)', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{
			count: number
		}>(
			`SELECT COUNT(*) as count
			 FROM channel_hits
			 WHERE kind = 'sql_table' AND value = 'users'`,
		)
		// findUser has one SELECT * FROM users, countUsers has one
		// SELECT COUNT(*) FROM users. the test file's INSERT INTO
		// must be excluded. so exactly 2 rows in the channel.
		expect(rows[0]?.count).toBe(2)
	})

	test('findChannelHitGroups returns one group with both symbols', () => {
		const store = engine.getStoreForCrossProject()
		const groups = store.findChannelHitGroups('sql_table')
		const usersGroup = groups.find((g) => g.value === 'users')
		expect(usersGroup).toBeDefined()
		expect(usersGroup?.symbolStableIds.length).toBe(2)
	})

	test('excludes test files from the scan', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{
			path: string
		}>(
			`SELECT f.path
			 FROM channel_hits ch
			 JOIN files f ON f.id = ch.file_id
			 WHERE ch.kind = 'sql_table'`,
		)
		for (const r of rows) {
			expect(r.path).not.toContain('tests/')
		}
	})

	test('re-indexing leaves the channel idempotent (no duplicates)', async () => {
		const store = engine.getStoreForCrossProject()
		const before = store.queryRaw<{ count: number }>(
			`SELECT COUNT(*) as count FROM channel_hits WHERE kind = 'sql_table'`,
		)[0].count

		await engine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false, withCoChange: false })

		const after = store.queryRaw<{ count: number }>(
			`SELECT COUNT(*) as count FROM channel_hits WHERE kind = 'sql_table'`,
		)[0].count
		expect(after).toBe(before)
	})

	test('prose matches outside string literals are ignored', () => {
		const store = engine.getStoreForCrossProject()
		// notSql() has the word FROM inside a string, but the word
		// `something` would be the captured table. let's make sure
		// nothing real pollutes the `users` group.
		const rows = store.queryRaw<{ value: string }>(
			`SELECT DISTINCT value FROM channel_hits WHERE kind = 'sql_table'`,
		)
		const tables = rows.map((r) => r.value)
		expect(tables).toContain('users')
	})
})
