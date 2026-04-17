import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import type { AtlasEngine } from '../../src/core/engine.js'
import { addProject } from '../../src/core/registry.js'
import { closeAll, getOrCreateEngine } from '../../src/core/engine-pool.js'

// covers #64: channel linkers use JS regex `.index` (UTF-16 code
// units) as the offset into store.getSymbolContainingByte, which
// stores tree-sitter's startIndex (also UTF-16 code units). the
// audit confirmed these units match, so a source file containing
// non-ASCII characters before the regex hit must still attribute
// the hit to the correct enclosing symbol.

let root: string
let engine: AtlasEngine

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'atlas-nonascii-offsets-'))

	// emoji + accented chars appear in string literals and comments
	// BEFORE the actual SQL / env / queue / gql matches. if the
	// extractor and linker ever disagree on units, the enclosing
	// symbol lookup will miss and the hit row will not be created.
	writeFileSync(
		join(root, 'service.ts'),
		`// café ☕ handling module
const HEADER = 'prélude — 🎉'

export function getUsers() {
	const sql = 'SELECT * FROM users WHERE active = 1'
	const key = process.env.STRIPE_KEY
	return { sql, key, marker: HEADER }
}
`,
	)

	const project = addProject(root)
	engine = getOrCreateEngine(project.id, root)
	await engine.index({ noEmbed: true, noSummarize: true, force: true, withGitHub: false })
})

afterAll(() => {
	closeAll()
	rmSync(root, { recursive: true, force: true })
})

describe('channel linkers with non-ASCII source (#64)', () => {
	test('sql table hits attribute to the enclosing function despite preceding unicode', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ value: string; symbol_stable_id: string }>(
			`SELECT value, symbol_stable_id FROM channel_hits WHERE kind = 'sql_table'`,
		)
		const users = rows.find((r) => r.value === 'users')
		expect(users).toBeDefined()
		const sym = store.queryRawWithParams<{ name: string }>(
			`SELECT name FROM symbols WHERE stable_id = ?`,
			users!.symbol_stable_id,
		)
		expect(sym[0]?.name).toBe('getUsers')
	})

	test('env var hits attribute to the enclosing function despite preceding unicode', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ value: string; symbol_stable_id: string }>(
			`SELECT value, symbol_stable_id FROM channel_hits WHERE kind = 'env_var'`,
		)
		const stripe = rows.find((r) => r.value === 'STRIPE_KEY')
		expect(stripe).toBeDefined()
		const sym = store.queryRawWithParams<{ name: string }>(
			`SELECT name FROM symbols WHERE stable_id = ?`,
			stripe!.symbol_stable_id,
		)
		expect(sym[0]?.name).toBe('getUsers')
	})
})
