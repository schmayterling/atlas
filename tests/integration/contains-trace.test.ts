import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// flow-trace retries with structural edges when the cheap execution
// pass finds no path, so a path like factory -instantiates-> Class
// -contains-> .method still resolves end-to-end. these tests pin both
// the success case and the documented blind-factory limitation.

let projectRoot: string
let engine: AtlasEngine

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-contains-trace-'))
	mkdirSync(join(projectRoot, 'src'), { recursive: true })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('flow-trace via contains', () => {
	test('direct `new Foo()` factory resolves a path to the class method', async () => {
		writeFileSync(
			join(projectRoot, 'src/widget.ts'),
			`export class Widget {
	greet(): string { return 'hi' }
}
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

		const result = engine.trace('makeWidget', 'greet')
		expect(result).not.toBeNull()
		expect(result?.paths.length).toBeGreaterThan(0)

		// the load-bearing assertion: at least one path uses the
		// fallback instantiates -> contains hop sequence.
		const hasInstantiatesContains = result?.paths.some((p) => {
			const kinds = p.edges.map((e) => e.kind)
			const i = kinds.indexOf('instantiates')
			return i >= 0 && kinds[i + 1] === 'contains'
		})
		expect(hasInstantiatesContains).toBe(true)
	})

	test('helper-returning factory with typed return annotation DOES resolve (via type_ref → contains)', async () => {
		// mirrors zod's classic `string(): ZodString { return _string(ZodString, ...) }` shape.
		// no instantiates edge lands on Widget from makeWidget (the `new` is
		// inside a generic helper; ts-resolver.ts:530 bails on type-parameter
		// news). but the function's `: Widget` return annotation emits a
		// type_ref edge, and with `contains` in the default edge set the
		// path type_ref → contains resolves end-to-end. this is the real
		// shape that was originally supposed to motivate the v4 #31 "returns
		// edge kind" plan; contains-in-defaults closes it implicitly.
		writeFileSync(
			join(projectRoot, 'src/widget.ts'),
			`export class Widget {
	greet(): string { return 'hi' }
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/helpers.ts'),
			`export function makeOf<T>(Ctor: new () => T): T {
	return new Ctor()
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/factory.ts'),
			`import { Widget } from './widget.js'
import { makeOf } from './helpers.js'

export function makeWidget(): Widget {
	return makeOf(Widget)
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

		const result = engine.trace('makeWidget', 'greet')
		expect(result).not.toBeNull()
		expect(result?.paths.length).toBeGreaterThan(0)

		const hasTypeRefContains = result?.paths.some((p) => {
			const kinds = p.edges.map((e) => e.kind)
			const i = kinds.indexOf('type_ref')
			return i >= 0 && kinds[i + 1] === 'contains'
		})
		expect(hasTypeRefContains).toBe(true)
	})

	test('factory with NO syntactic reference to its returned class does NOT resolve (documented limitation)', async () => {
		// this is the genuine gap a future "returns edge" / return-type
		// propagation plan would address. if the factory signature doesn't
		// mention Widget via return annotation OR a `new Widget()` in its
		// body, atlas has no edge landing on Widget, and no class hop
		// exists for `contains` to traverse.
		writeFileSync(
			join(projectRoot, 'src/widget.ts'),
			`export class Widget {
	greet(): string { return 'hi' }
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/helpers.ts'),
			`export function makeOf<T>(Ctor: new () => T): T {
	return new Ctor()
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/factory.ts'),
			`import { makeOf } from './helpers.js'

// NO return annotation, NO reference to Widget — the only mechanism
// that could reach greet is real return-type propagation through makeOf.
export function makeWidgetBlind() {
	return makeOf(null as any)
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

		const result = engine.trace('makeWidgetBlind', 'greet')
		expect(result).not.toBeNull()
		expect(result?.paths.length).toBe(0)
	})

	test('--edge-kinds override disables contains traversal', async () => {
		writeFileSync(
			join(projectRoot, 'src/widget.ts'),
			`export class Widget {
	greet(): string { return 'hi' }
}
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

		// without contains, the path that worked above no longer resolves.
		// confirms users can opt out when high-fanout `contains` edges
		// hurt path quality or perf.
		const result = engine.trace('makeWidget', 'greet', {
			edgeKinds: ['calls', 'instantiates'],
		})
		expect(result).not.toBeNull()
		expect(result?.paths.length).toBe(0)
	})
})
