import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #87: `new ClassName()` now emits an instantiates edge from
// the containing function to the resolved class symbol. previously
// every construction site was invisible to the graph, which made
// blast radius on classes undercount and constructors look dead.

let projectRoot: string
let engine: AtlasEngine

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-instantiates-'))
	mkdirSync(join(projectRoot, 'src'), { recursive: true })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('ts instantiates', () => {
	test('new Foo() emits an instantiates edge to the class symbol', async () => {
		writeFileSync(
			join(projectRoot, 'src/foo.ts'),
			`export class Foo {
	greet(): string { return 'hi' }
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/main.ts'),
			`import { Foo } from './foo.js'

export function makeFoo(): Foo {
	return new Foo()
}

export function makeAnotherFoo(): Foo {
	return new Foo()
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
		const rows = store.queryRaw<{ name: string; count: number }>(
			`SELECT src.name as name, COUNT(*) as count
			 FROM edges e
			 JOIN symbols src ON src.stable_id = e.source_id
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE e.kind = 'instantiates'
			 AND tgt.name = 'Foo'
			 GROUP BY src.name`,
		)
		const makeFoo = rows.find((r) => r.name === 'makeFoo')
		const makeAnother = rows.find((r) => r.name === 'makeAnotherFoo')
		expect(makeFoo?.count ?? 0).toBe(1)
		expect(makeAnother?.count ?? 0).toBe(1)
	})

	test('blast-radius on a class surfaces construction sites', async () => {
		writeFileSync(
			join(projectRoot, 'src/widget.ts'),
			`export class Widget {}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/factory.ts'),
			`import { Widget } from './widget.js'

export function makeWidget(): Widget {
	return new Widget()
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

		const blast = engine.blast('Widget')
		expect(blast).not.toBeNull()
		const hitNames = (blast?.direct ?? [])
			.concat(blast?.transitive ?? [])
			.map((item) => item.symbol.name)
		expect(hitNames).toContain('makeWidget')
	})

	test('aliased `new Foo as Bar` still resolves to the original class', async () => {
		writeFileSync(
			join(projectRoot, 'src/foo.ts'),
			`export class Foo {}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/main.ts'),
			`import { Foo as Renamed } from './foo.js'

export function build(): Renamed {
	return new Renamed()
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
		const rows = store.queryRaw<{ targetQname: string }>(
			`SELECT tgt.qualified_name as targetQname
			 FROM edges e
			 JOIN symbols src ON src.stable_id = e.source_id
			 JOIN symbols tgt ON tgt.stable_id = e.target_id
			 WHERE e.kind = 'instantiates'
			 AND src.name = 'build'`,
		)
		expect(rows[0]?.targetQname).toContain('foo.ts::Foo')
	})

	test('instantiated class with no other consumers stops appearing in dead-code', async () => {
		writeFileSync(
			join(projectRoot, 'src/only-instantiated.ts'),
			`class LocalOnly {}

export function useIt(): void {
	const x = new LocalOnly()
	void x
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

		const dead = engine.deadCode()
		const names = dead.symbols.map((s) => s.name)
		expect(names).not.toContain('LocalOnly')
	})
})
