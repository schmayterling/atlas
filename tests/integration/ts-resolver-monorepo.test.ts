import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #46: the TS resolver used to build a single ts.Program from
// the project root's nearest tsconfig, so workspace-local path aliases
// (paths + baseUrl in apps/*/tsconfig.json) never resolved for files
// outside that single compiler program. this fixture sets up a tiny
// monorepo with two apps; app-a imports from app-b via a path alias
// declared in app-a's tsconfig. after the bucket-by-tsconfig fix, the
// resolver creates one ts.Program per tsconfig so the alias resolves
// and the cross-file edge shows up.

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-monorepo-'))

	mkdirSync(join(projectRoot, 'apps/app-a/src'), { recursive: true })
	mkdirSync(join(projectRoot, 'apps/app-b/src'), { recursive: true })

	// app-a owns its own tsconfig with a path alias that points at app-b.
	// the only way TS resolves `@b/lib/foo` is via this tsconfig's paths
	// entry; the root of atlas has no tsconfig, so the old single-program
	// path would silently fail to resolve.
	writeFileSync(
		join(projectRoot, 'apps/app-a/tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'esnext',
				module: 'esnext',
				moduleResolution: 'bundler',
				baseUrl: '.',
				paths: {
					'@b/*': ['../app-b/src/*'],
				},
			},
			include: ['src/**/*'],
		}),
	)

	writeFileSync(
		join(projectRoot, 'apps/app-b/tsconfig.json'),
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
		join(projectRoot, 'apps/app-b/src/shared.ts'),
		`export function sharedHelper(): string { return 'hello from b' }\n`,
	)

	writeFileSync(
		join(projectRoot, 'apps/app-a/src/consumer.ts'),
		`import { sharedHelper } from '@b/shared.js'

export function consume(): string {
	return sharedHelper()
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

describe('ts-resolver monorepo buckets', () => {
	test('resolves cross-workspace imports via the workspace tsconfig path alias', () => {
		const store = engine.getStoreForCrossProject()
		// the alias `@b/shared.js` in app-a/src/consumer.ts must resolve to
		// app-b/src/shared.ts via the path alias in apps/app-a/tsconfig.json.
		// that only works if the resolver picks the right tsconfig for each
		// bucket. a single-program run would fail because apps/app-a's
		// paths aren't visible from the repo root.
		const resolvedCallEdges = store.queryRaw<{ count: number }>(
			`SELECT COUNT(*) as count
			 FROM edges e
			 JOIN symbols src ON src.stable_id = e.source_id
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 JOIN files srcf ON srcf.id = src.file_id
			 JOIN files tgtf ON tgtf.id = tgt.file_id
			 WHERE e.kind = 'calls'
			 AND e.confidence = 'resolved'
			 AND e.file_id IS NULL
			 AND src.name = 'consume'
			 AND tgt.name = 'sharedHelper'
			 AND srcf.path = 'apps/app-a/src/consumer.ts'
			 AND tgtf.path = 'apps/app-b/src/shared.ts'`,
		)
		expect(resolvedCallEdges[0]?.count ?? 0).toBeGreaterThan(0)
	})

	test('resolves the import row with a real target_file_id', () => {
		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{
			importPath: string
			targetFileId: number | null
		}>(
			`SELECT i.import_path as importPath, i.target_file_id as targetFileId
			 FROM imports i
			 JOIN files f ON f.id = i.source_file_id
			 WHERE f.path = 'apps/app-a/src/consumer.ts'`,
		)
		const aliased = rows.find((r) => r.importPath === '@b/shared.js')
		expect(aliased).toBeDefined()
		expect(aliased?.targetFileId).not.toBeNull()
	})
})
