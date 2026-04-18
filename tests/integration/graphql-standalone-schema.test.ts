import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import type { AtlasEngine } from '../../src/core/engine.js'
import { addProject } from '../../src/core/registry.js'
import { closeAll, getOrCreateEngine } from '../../src/core/engine-pool.js'

// covers #66: standalone .graphql / .graphqls / .gql schema files
// now register in the files table (language='graphql', 0 symbols) so
// channel_hits.file_id has a real target. the graphql linker walks
// them and emits one hit per top-level type/input/enum definition.

let root: string
let engine: AtlasEngine

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'atlas-gql-standalone-'))

	writeFileSync(
		join(root, 'schema.graphql'),
		`type User {
	id: ID!
	name: String!
}

type Order {
	id: ID!
	user: User!
}

input CreateUserInput {
	name: String!
}
`,
	)

	writeFileSync(
		join(root, 'user.ts'),
		`export interface User {
	id: string
	name: string
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

describe('graphql standalone schema extraction (#66)', () => {
	test('schema file is registered with language graphql', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ path: string; language: string | null }>(
			`SELECT path, language FROM files WHERE path LIKE '%.graphql'`,
		)
		expect(rows.length).toBe(1)
		expect(rows[0].path).toBe('schema.graphql')
		expect(rows[0].language).toBe('graphql')
	})

	test('top-level type, input, and enum definitions emit channel hits', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ value: string; metadata: string | null }>(
			`SELECT value, metadata FROM channel_hits WHERE kind = 'graphql_type'`,
		)
		const values = rows.map((r) => r.value)
		expect(values).toContain('User')
		expect(values).toContain('Order')
		expect(values).toContain('CreateUserInput')
		// metadata records the schemaPath so downstream tooling can
		// locate the source.
		const userRow = rows.find((r) => r.value === 'User' && r.metadata?.includes('schema_file'))
		expect(userRow).toBeDefined()
	})

	test('User groups under listChannels across the ts interface and the schema (#66 cross-language mirror)', () => {
		// the standalone linker emits a cross-language mirror hit against
		// any ts/go interface/type/class sharing the name, so listChannels
		// groups the schema-side User with the ts interface User. this is
		// the acceptance criterion on #66.
		const groups = engine.listChannels('graphql_type')
		const user = groups.find((g) => g.value === 'User')
		expect(user).toBeDefined()
		expect(user!.symbolStableIds.length).toBeGreaterThanOrEqual(2)
	})
})
