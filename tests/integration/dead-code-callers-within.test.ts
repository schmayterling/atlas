import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #86: dead-code's --callers-within mode returns symbols
// whose callers all live under the given path prefix. distinct from
// the default mode, which returns unreferenced symbols.

let projectRoot: string
let engine: AtlasEngine

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-callers-within-'))
	mkdirSync(join(projectRoot, 'src/queries'), { recursive: true })
	mkdirSync(join(projectRoot, 'src/cli'), { recursive: true })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('dead-code --callers-within', () => {
	test('returns symbols with all callers inside the prefix', async () => {
		writeFileSync(
			join(projectRoot, 'src/queries/util.ts'),
			`export function internalHelper(): string { return 'x' }

export function queryCaller(): string {
	return internalHelper()
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/queries/more.ts'),
			`import { internalHelper } from './util.js'

export function anotherQuery(): string {
	return internalHelper()
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

		const result = engine.deadCode({ callersWithin: 'src/queries/' })
		const names = result.symbols.map((s) => s.name)
		expect(names).toContain('internalHelper')
	})

	test('excludes symbols with at least one caller outside the prefix', async () => {
		writeFileSync(
			join(projectRoot, 'src/queries/util.ts'),
			`export function leakyHelper(): string { return 'x' }
`,
		)
		writeFileSync(
			join(projectRoot, 'src/queries/more.ts'),
			`import { leakyHelper } from './util.js'

export function sameDirCaller(): string {
	return leakyHelper()
}
`,
		)
		writeFileSync(
			join(projectRoot, 'src/cli/consume.ts'),
			`import { leakyHelper } from '../queries/util.js'

export function cliCaller(): string {
	return leakyHelper()
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

		const result = engine.deadCode({ callersWithin: 'src/queries/' })
		const names = result.symbols.map((s) => s.name)
		expect(names).not.toContain('leakyHelper')
	})

	test('does not include symbols with zero callers (that is default dead-code territory)', async () => {
		writeFileSync(
			join(projectRoot, 'src/queries/util.ts'),
			`export function neverCalled(): string { return 'x' }
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

		const result = engine.deadCode({ callersWithin: 'src/queries/' })
		const names = result.symbols.map((s) => s.name)
		expect(names).not.toContain('neverCalled')
	})

	test('counts instantiates edges as callers', async () => {
		writeFileSync(
			join(projectRoot, 'src/queries/factory.ts'),
			`export class InternalThing {}

export function make(): InternalThing {
	return new InternalThing()
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

		const result = engine.deadCode({ callersWithin: 'src/queries/' })
		const names = result.symbols.map((s) => s.name)
		expect(names).toContain('InternalThing')
	})

	test('kind filter still applies in callers-within mode', async () => {
		writeFileSync(
			join(projectRoot, 'src/queries/util.ts'),
			`export function helperFn(): string { return 'x' }
export class HelperClass {}

export function sameDirCaller(): void {
	helperFn()
	new HelperClass()
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

		const result = engine.deadCode({ callersWithin: 'src/queries/', kind: 'class' })
		const names = result.symbols.map((s) => s.name)
		expect(names).toContain('HelperClass')
		expect(names).not.toContain('helperFn')
	})
})
