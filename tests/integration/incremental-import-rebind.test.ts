import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #35: during incremental re-indexing the step 4 delete of a
// modified file's row cascades files.id -> imports.target_file_id via
// ON DELETE SET NULL, orphaning every unchanged file that imports
// it. step 6's resolveProject only re-runs over state.absolutePaths
// (modified files), so the orphaned importer rows stay NULL until a
// full re-index. the indexer now runs a rebindNullTargetImports
// pass after cross-file resolution that repairs those rows.

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-rebind-'))

	mkdirSync(join(projectRoot, 'src'), { recursive: true })

	writeFileSync(
		join(projectRoot, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'esnext',
				module: 'esnext',
				moduleResolution: 'bundler',
			},
			include: ['src/**/*'],
		}),
	)

	writeFileSync(
		join(projectRoot, 'src/store.ts'),
		`export class Store {
	get(id: string): string { return id }
}
`,
	)

	writeFileSync(
		join(projectRoot, 'src/consumer.ts'),
		`import { Store } from './store.js'

export function useStore(): string {
	const s = new Store()
	return s.get('x')
}
`,
	)

	engine = new AtlasEngine(projectRoot)
	await engine.index({
		noEmbed: true,
		noSummarize: true,
		force: true,
		withGitHub: false,
		withCoChange: false,
	})
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('incremental import rebind (#35)', () => {
	test('repairs NULL target_file_id left by step-4 cascade on modified file', async () => {
		const store = engine.getStoreForCrossProject()

		// sanity: full index left the importer resolved.
		const before = store.queryRaw<{ targetFileId: number | null }>(
			`SELECT i.target_file_id as targetFileId
			 FROM imports i
			 JOIN files f ON f.id = i.source_file_id
			 WHERE f.path = 'src/consumer.ts' AND i.import_path = './store.js'`,
		)
		expect(before[0]?.targetFileId).not.toBeNull()

		// modify the imported file. step 4 will delete it, cascading
		// imports.target_file_id -> NULL for consumer.ts. step 5
		// reinserts store.ts with a new file_id. step 6's rebind
		// should then repair consumer.ts's orphaned row.
		writeFileSync(
			join(projectRoot, 'src/store.ts'),
			`export class Store {
	get(id: string): string { return id }
	set(id: string, v: string): void {}
}
`,
		)
		await engine.index({
			noEmbed: true,
			noSummarize: true,
			force: false,
			withGitHub: false,
			withCoChange: false,
		})

		const after = store.queryRaw<{ targetFileId: number | null }>(
			`SELECT i.target_file_id as targetFileId
			 FROM imports i
			 JOIN files f ON f.id = i.source_file_id
			 WHERE f.path = 'src/consumer.ts' AND i.import_path = './store.js'`,
		)
		expect(after[0]?.targetFileId).not.toBeNull()
	})
})
