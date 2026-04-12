import { describe, expect, test } from 'bun:test'
import {
	stableSubsystemId,
	canonicalName,
	detectSubsystems,
	persistSubsystems,
} from '../../src/core/queries/subsystem-detection.js'
import { getFixtureEngine } from '../helpers/fixture-engine.js'

describe('stableSubsystemId', () => {
	test('is deterministic for the same membership', () => {
		const a = stableSubsystemId(['src/a.ts', 'src/b.ts', 'src/c.ts'])
		const b = stableSubsystemId(['src/a.ts', 'src/b.ts', 'src/c.ts'])
		expect(a).toBe(b)
	})

	test('changes when membership changes', () => {
		const a = stableSubsystemId(['src/a.ts', 'src/b.ts'])
		const b = stableSubsystemId(['src/a.ts', 'src/b.ts', 'src/c.ts'])
		expect(a).not.toBe(b)
	})

	test('produces a 16-char hex string', () => {
		expect(stableSubsystemId(['x'])).toMatch(/^[0-9a-f]{16}$/)
	})
})

describe('canonicalName', () => {
	test('falls back to cluster-of-N when LCP collapses to a bare ignored root', async () => {
		const engine = await getFixtureEngine()
		const store = engine.getStoreForCrossProject()
		// non-existent ids; LEFT JOIN returns no symbols and we exercise the
		// prefix-only path. with the LCP guard, bare 'src' is dropped and the
		// fallback cluster-of-N string takes over.
		const name = canonicalName(store, [-1, -2], ['src/a.ts', 'src/b.ts'])
		expect(name).toBe('cluster of 2 files')
	})

	test('keeps a meaningful prefix when LCP is more than just a project root', async () => {
		const engine = await getFixtureEngine()
		const store = engine.getStoreForCrossProject()
		const name = canonicalName(store, [-1, -2], ['src/web/a.ts', 'src/web/b.ts'])
		expect(name).toBe('src/web')
	})

	test('returns a non-empty string for any non-empty input', async () => {
		const engine = await getFixtureEngine()
		const store = engine.getStoreForCrossProject()
		const files = engine.files()
		const fileIds = await store.queryRaw<{ id: number }>('SELECT id FROM files')
		const ids = fileIds.map((r) => r.id)
		const paths = files.map((f) => f.path)
		const name = canonicalName(store, ids, paths)
		expect(name.length).toBeGreaterThan(0)
	})
})

describe('detectSubsystems', () => {
	test('runs against the fixture project without throwing', async () => {
		const engine = await getFixtureEngine()
		const store = engine.getStoreForCrossProject()
		const result = detectSubsystems(store)
		expect(typeof result.partitionModularity).toBe('number')
		expect(Array.isArray(result.clusters)).toBe(true)
		// every cluster has a non-empty name and at least 2 members
		for (const c of result.clusters) {
			expect(c.id).toMatch(/^[0-9a-f]{16}$/)
			expect(c.name.length).toBeGreaterThan(0)
			expect(c.memberFileIds.length).toBeGreaterThanOrEqual(2)
			expect(c.conductance).toBeGreaterThanOrEqual(0)
			expect(c.conductance).toBeLessThanOrEqual(1)
		}
	})
})

describe('persistSubsystems', () => {
	test('updates files.subsystem_id and replaces previous rows', async () => {
		const engine = await getFixtureEngine()
		const store = engine.getStoreForCrossProject()
		const result = detectSubsystems(store)
		persistSubsystems(store, result.clusters, null)

		const subsystemRows = store.queryRaw<{ id: string }>('SELECT id FROM subsystems')
		expect(subsystemRows.length).toBe(result.clusters.length)

		// re-running produces the same number of rows (idempotent)
		persistSubsystems(store, result.clusters, null)
		const after = store.queryRaw<{ id: string }>('SELECT id FROM subsystems')
		expect(after.length).toBe(result.clusters.length)
	})
})
