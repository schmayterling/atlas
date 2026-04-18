import { describe, expect, test } from 'bun:test'
import '../helpers/setup.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// covers #80: `atlas trace --hops` used to silently clamp 0, negatives,
// and non-integers to 1 via Math.max/Math.min. the fix rejects invalid
// values at the cli boundary. exercising the cli directly because the
// validation lives in the command handler, not in the engine.

function runTrace(hops: string): { exitCode: number; stderr: string } {
	const tmpRoot = mkdtempSync(join(tmpdir(), 'atlas-trace-cli-'))
	writeFileSync(join(tmpRoot, 'a.ts'), 'export function a() { return 1 }\n')
	try {
		const res = spawnSync('bun', [
			'run', 'src/bin.ts', 'trace',
			'a', 'b',
			'--from-project', 'proj-a',
			'--to-project', 'proj-b',
			'--hops', hops,
		], { cwd: process.cwd(), encoding: 'utf-8' })
		return { exitCode: res.status ?? -1, stderr: res.stderr?.toString() ?? '' }
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true })
	}
}

describe('trace --hops validation', () => {
	test('rejects 0 with a clear error instead of clamping to 1', () => {
		const { exitCode, stderr } = runTrace('0')
		expect(exitCode).not.toBe(0)
		expect(stderr).toMatch(/--hops must be an integer in 1\.\.5/)
	})

	test('rejects negatives', () => {
		const { exitCode, stderr } = runTrace('-1')
		expect(exitCode).not.toBe(0)
		expect(stderr).toMatch(/--hops must be an integer/)
	})

	test('rejects non-integers', () => {
		const { exitCode, stderr } = runTrace('2.5')
		expect(exitCode).not.toBe(0)
		expect(stderr).toMatch(/--hops must be an integer/)
	})

	test('rejects values above the cap of 5', () => {
		const { exitCode, stderr } = runTrace('6')
		expect(exitCode).not.toBe(0)
		expect(stderr).toMatch(/--hops must be an integer/)
	})
})
