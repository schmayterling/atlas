import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// regression for the gap found while verifying atlas-002 (bench-llm
// question): calls made from inside `test('name', () => {...})`,
// `describe('name', () => {...})`, and `it('name', () => {...})`
// callbacks were silently dropped from the call graph because the
// ts-resolver's findContainingFunction only recognized arrow functions
// whose immediate parent was a variable_declaration. test callbacks
// sit as anonymous arg-position arrows under a call_expression, so
// every call inside them fell through to null and the edge was lost.
// the fix extracts a synthetic `<callee>:<label>` function symbol for
// each test callable's callback body and teaches the resolver to
// attribute inner calls to that same qname.

let projectRoot: string
let engine: AtlasEngine

beforeAll(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-test-cb-'))
	mkdirSync(projectRoot, { recursive: true })

	writeFileSync(
		join(projectRoot, 'helper.ts'),
		`export function sharedHelper(x: number): number {
	return x + 1
}
`,
	)

	writeFileSync(
		join(projectRoot, 'example.test.ts'),
		`import { sharedHelper } from './helper.js'

describe('outer', () => {
	test('first call inside test callback', () => {
		const result = sharedHelper(1)
		void result
	})

	it('second call inside it callback', () => {
		sharedHelper(2)
	})

	test.skip('skipped member-access form', () => {
		sharedHelper(3)
	})
})
`,
	)

	engine = new AtlasEngine(projectRoot)
	await engine.index({ noEmbed: true, noSummarize: true, force: true })
})

afterAll(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('ts-resolver test-callback attribution', () => {
	test('synthetic test-callback symbols are extracted', () => {
		const store = engine.getStoreForCrossProject()
		const syms = store.queryRaw<{ qualified_name: string }>(
			`SELECT qualified_name FROM symbols
			 WHERE qualified_name LIKE 'example.test.ts::%:%'`,
		)
		const names = syms.map((r) => r.qualified_name).sort()
		// outer describe, both named test/it callbacks, and the
		// member-access skipped test (`test.skip`).
		expect(names).toContain('example.test.ts::describe:outer')
		expect(names).toContain('example.test.ts::test:first call inside test callback')
		expect(names).toContain('example.test.ts::it:second call inside it callback')
		expect(names).toContain('example.test.ts::test:skipped member-access form')
	})

	test('calls inside test callbacks attribute to the synthetic symbol', () => {
		const rows = engine
			.getStoreForCrossProject()
			.queryRaw<{ source_qname: string }>(
				`SELECT s.qualified_name AS source_qname
				 FROM edges e
				 JOIN symbols s ON s.stable_id = e.source_id
				 JOIN symbols t ON t.stable_id = e.target_id
				 WHERE e.kind = 'calls'
				   AND t.qualified_name = 'helper.ts::sharedHelper'
				 ORDER BY s.qualified_name`,
			)
		const sources = rows.map((r) => r.source_qname)
		// every call-site resolved; no <unknown> source rows.
		expect(sources).toContain('example.test.ts::test:first call inside test callback')
		expect(sources).toContain('example.test.ts::it:second call inside it callback')
		expect(sources).toContain('example.test.ts::test:skipped member-access form')
	})
})
