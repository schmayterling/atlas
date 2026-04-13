import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../helpers/setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

// covers #41: recursive reachability from a root set. the previous
// NOT IN check treated any inbound edge as liveness, so two
// mutually-recursive unreachable functions survived because each
// had the other as an inbound call. this fixture pins exactly that
// shape.

let projectRoot: string
let engine: AtlasEngine

beforeEach(async () => {
	projectRoot = mkdtempSync(join(tmpdir(), 'atlas-dead-reach-'))
	mkdirSync(join(projectRoot, 'src'), { recursive: true })

	writeFileSync(
		join(projectRoot, 'src/app.ts'),
		`// public API surface: main is reachable through exported
export function main(): number {
	return helper()
}

// private helper reachable from main → not dead
function helper(): number {
	return 1
}

// mutually-recursive unreachable pair — each has an inbound edge
// from the other, but neither is reachable from any exported root.
// must appear in dead-code under the reachability model.
function deadA(): number {
	return deadB()
}
function deadB(): number {
	return deadA()
}
void deadA
void deadB

// lone unreachable private helper — simplest dead case.
function lonerDead(): number {
	return 42
}
void lonerDead
`,
	)

	engine = new AtlasEngine(projectRoot)
	await engine.index({ noEmbed: true, noSummarize: true, force: true })
})

afterEach(() => {
	engine.close()
	rmSync(projectRoot, { recursive: true, force: true })
})

describe('dead-code recursive reachability', () => {
	test('mutually-recursive unreachable pair is flagged dead', () => {
		const result = engine.deadCode()
		const names = result.symbols.map((s) => s.name)
		expect(names).toContain('deadA')
		expect(names).toContain('deadB')
	})

	test('lone unreachable helper is flagged dead', () => {
		const result = engine.deadCode()
		const names = result.symbols.map((s) => s.name)
		expect(names).toContain('lonerDead')
	})

	test('reachable private helper is NOT flagged dead', () => {
		const result = engine.deadCode()
		const names = result.symbols.map((s) => s.name)
		expect(names).not.toContain('helper')
	})

	test('exported public API is NOT flagged dead', () => {
		const result = engine.deadCode()
		const names = result.symbols.map((s) => s.name)
		expect(names).not.toContain('main')
	})
})
