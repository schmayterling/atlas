import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #85: structural property access emits a field_access edge
// from the enclosing function to the resolved property symbol. before
// this edge kind, interface field reads on inferred variables were
// invisible to atlas's graph, so blast-radius on an interface omitted
// structural consumers.

let projectRoot: string
let engine: AtlasEngine

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-field-access-'))
	mkdirSync(join(projectRoot, 'src'), { recursive: true })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('ts field_access', () => {
	test('reading an interface field emits a field_access edge to the property', async () => {
		writeFileSync(
			join(projectRoot, 'src/shapes.ts'),
			`export interface Point {
	x: number
	y: number
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/geom.ts'),
			`import type { Point } from './shapes.js'

export function sumCoords(points: Point[]): number {
	let total = 0
	for (const p of points) {
		total += p.x
		total += p.y
	}
	return total
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

		const store = engine.getStoreForCrossProject()
		const rows = store.queryRaw<{ propName: string; count: number }>(
			`SELECT tgt.name as propName, COUNT(*) as count
			 FROM edges e
			 JOIN symbols src ON src.stable_id = e.source_id
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE e.kind = 'field_access'
			 AND src.name = 'sumCoords'
			 GROUP BY tgt.name`,
		)
		const byName = new Map(rows.map((r) => [r.propName, r.count]))
		expect(byName.get('x') ?? 0).toBeGreaterThan(0)
		expect(byName.get('y') ?? 0).toBeGreaterThan(0)
	})

	test('destructured iteration over result.edges[i].field still produces field_access', async () => {
		writeFileSync(
			join(projectRoot, 'src/types.ts'),
			`export interface Edge {
	sourceName: string
	targetName: string
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/consume.ts'),
			`import type { Edge } from './types.js'

export function consume(result: { edges: Edge[] }): string {
	const parts: string[] = []
	for (const e of result.edges) {
		parts.push(e.sourceName)
		parts.push(e.targetName)
	}
	return parts.join(',')
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

		const blast = engine.blast('Edge')
		expect(blast).not.toBeNull()
		// consume reads two fields of Edge. blast-radius on the
		// interface should now surface consume() as a dependent, which
		// it could not before #85 (no type annotation on `e`).
		const hitNames = (blast?.direct ?? [])
			.concat(blast?.transitive ?? [])
			.map((item) => item.symbol.name)
		expect(hitNames).toContain('consume')
	})

	test('method calls (foo.bar()) do not double-count against field_access', async () => {
		writeFileSync(
			join(projectRoot, 'src/service.ts'),
			`export class Service {
	run(): string { return 'ok' }
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/caller.ts'),
			`import { Service } from './service.js'

export function callRun(s: Service): string {
	return s.run()
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

		const store = engine.getStoreForCrossProject()
		// the `s.run()` should emit exactly one calls edge and zero
		// field_access edges targeting Service.run.
		const rows = store.queryRaw<{ kind: string; count: number }>(
			`SELECT e.kind as kind, COUNT(*) as count
			 FROM edges e
			 JOIN symbols src ON src.stable_id = e.source_id
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE src.name = 'callRun'
			 AND tgt.name = 'run'
			 GROUP BY e.kind`,
		)
		const calls = rows.find((r) => r.kind === 'calls')?.count ?? 0
		const fieldAccess = rows.find((r) => r.kind === 'field_access')?.count ?? 0
		expect(calls).toBeGreaterThan(0)
		expect(fieldAccess).toBe(0)
	})
})
