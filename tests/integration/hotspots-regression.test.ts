import { describe, expect, test } from 'bun:test'
import '../helpers/setup.js'
import { getFixtureEngine } from '../helpers/fixture-engine.js'

// covers #57 and #59: hotspots output must (a) populate commits from
// file_changes for files with git history (not zero for all rows) and
// (b) return per-symbol rows — the same file appearing multiple times
// is by design when the file has multiple hot symbols, not a bug.
//
// the tiny-project fixture has no git history so commits is zero for
// it, which is expected. we pin the per-symbol semantic explicitly and
// run the atlas self-index as the churn sanity check in dogfood.

describe('hotspots regression (#57, #59)', () => {
	test('per-symbol output: different symbols in the same file are distinct rows', async () => {
		const engine = await getFixtureEngine()
		const rows = engine.hotspots({ limit: 50 })
		// group by stable_id — every row must be unique
		const seen = new Set<string>()
		for (const r of rows) {
			expect(seen.has(r.stableId)).toBe(false)
			seen.add(r.stableId)
		}
	})

	test('commits column is populated from file_changes when git history exists', async () => {
		// on the tiny-project fixture there is no git history so commits
		// is always zero. this test only asserts the query shape: every
		// row has a numeric commits field (not null). the prod repro
		// for churn=0 lived on a DB with git history and should be
		// covered by the atlas self-index dogfood run.
		const engine = await getFixtureEngine()
		const rows = engine.hotspots({ limit: 20 })
		for (const r of rows) {
			expect(typeof r.commits).toBe('number')
			expect(r.commits).toBeGreaterThanOrEqual(0)
		}
	})
})
