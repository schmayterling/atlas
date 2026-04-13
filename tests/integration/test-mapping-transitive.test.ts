import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #23: when a test reaches a target module only through a helper file,
// the one-hop getTestImportedSymbolPairs query used to return nothing and
// atlas_test_coverage reported coverage: none. the recursive CTE now walks
// transitive imports, so the target's exported symbols surface as `imported`.

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-test-mapping-transitive-'))
	mkdirSync(join(projectRoot, 'src'))
	mkdirSync(join(projectRoot, 'tests'))
	mkdirSync(join(projectRoot, 'tests/helpers'))

	// the target module the test cares about — but never directly imports.
	writeFileSync(
		join(projectRoot, 'src/store.ts'),
		`export class Store {
	put(key: string, value: string): void {}
	get(key: string): string | null { return null }
}

export function makeStore(): Store {
	return new Store()
}
`,
	)

	// helper that the test DOES import, and which re-exports the subject.
	writeFileSync(
		join(projectRoot, 'tests/helpers/tmp-store.ts'),
		`import { makeStore, Store } from '../../src/store.js'

export function createTempStore(): Store {
	return makeStore()
}
`,
	)

	// test file: imports only the helper, never the store directly.
	writeFileSync(
		join(projectRoot, 'tests/store.test.ts'),
		`import { createTempStore } from './helpers/tmp-store.js'

function check(): boolean {
	const s = createTempStore()
	s.put('k', 'v')
	return s.get('k') === null
}

check()
`,
	)

	// an unrelated module nobody imports — should never get test coverage.
	writeFileSync(
		join(projectRoot, 'src/orphan.ts'),
		`export function orphan(): number { return 42 }
`,
	)

	engine = new AtlasEngine(projectRoot)
	await engine.index({ noEmbed: true, noSummarize: true, force: true })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('transitive imported-tier coverage', () => {
	test('target module reached through a helper gets imported coverage', () => {
		const result = engine.testCoverage('makeStore')
		expect(result).not.toBeNull()
		// the test file never imports src/store.ts directly, only tmp-store.ts
		// which in turn imports src/store.ts. the recursive CTE must credit
		// makeStore with at least imported coverage.
		expect(result?.coveredBy === 'imported' || result?.coveredBy === 'called').toBe(true)
		expect(
			result?.tests.some((t) => t.testFilePath.endsWith('tests/store.test.ts')),
		).toBe(true)
	})

	test('modules not reachable from any test stay uncovered', () => {
		const result = engine.testCoverage('orphan')
		expect(result?.coveredBy).toBe('none')
	})
})
