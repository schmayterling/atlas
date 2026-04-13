import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #44: generated / mock / fake files are excluded from
// dead-code, hot-fragile, and hotspots queries via the engine-level
// generatedFileIds cache wired through AtlasEngine.deadCode /
// hotFragile / hotspots.

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-gen-filter-'))
	mkdirSync(join(projectRoot, 'src'), { recursive: true })
	mkdirSync(join(projectRoot, 'src/mocks'), { recursive: true })

	// real production file with an unreachable internal helper
	writeFileSync(
		join(projectRoot, 'src/real.ts'),
		`export function alive(): number { return 1 }

function unreachable(): number {
	return 2
}
`,
	)

	// generated-by-path file with its own "dead" helper that must
	// be filtered out of dead-code results
	writeFileSync(
		join(projectRoot, 'src/fake_service.ts'),
		`export function fakeAlive(): number { return 10 }

function fakeDead(): number {
	return 20
}
`,
	)

	// mocks/ directory also filtered by the generated-code path regex
	writeFileSync(
		join(projectRoot, 'src/mocks/widget.ts'),
		`export function mockWidget(): number { return 100 }

function mockPrivate(): number {
	return 200
}
`,
	)

	// fake git history so hot-fragile / hotspots consider these files
	engine = new AtlasEngine(projectRoot)
	await engine.index({ noEmbed: true, noSummarize: true, force: true })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('generated-file filter on queries', () => {
	test('dead-code excludes symbols from generated / mock / fake files', () => {
		const result = engine.deadCode()
		const names = result.symbols.map((s) => s.name)
		// real file's unreachable helper stays
		expect(names).toContain('unreachable')
		// generated file's dead helper is filtered out
		expect(names).not.toContain('fakeDead')
		// mocks/ directory is filtered out
		expect(names).not.toContain('mockPrivate')
	})

	test('generated fake files do not appear in hot-fragile output', () => {
		// add commits so hot-fragile surfaces the files (it INNER JOINs
		// file_changes so files without history are dropped)
		const store = engine.getStoreForCrossProject()
		store.queryRaw(
			`INSERT INTO commits (hash, author_name, author_email, authored_at, subject)
			 VALUES ('sha-a', 'a', 'a@x', 1700000000, 'm1'),
			        ('sha-b', 'a', 'a@x', 1700000100, 'm2'),
			        ('sha-c', 'a', 'a@x', 1700000200, 'm3')`,
		)
		store.queryRaw(
			`INSERT INTO file_changes (commit_hash, file_path, status)
			 VALUES ('sha-a', 'src/real.ts', 'A'),
			        ('sha-b', 'src/real.ts', 'M'),
			        ('sha-c', 'src/fake_service.ts', 'A'),
			        ('sha-a', 'src/mocks/widget.ts', 'A')`,
		)

		const rows = engine.hotFragile({ limit: 20 })
		const paths = rows.map((r) => r.filePath)
		expect(paths).not.toContain('src/fake_service.ts')
		expect(paths).not.toContain('src/mocks/widget.ts')
	})
})
