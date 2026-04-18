#!/usr/bin/env bun
// scenario-based correctness regression harness. each scenario under
// bench/scenarios/ exports a default Scenario that sets up projects,
// seeds cross_project_edges, and runs a set of named queries. the
// runner snapshots query output against expected.json using a stable
// key ordering. see #83.
//
// usage:
//   bun run bench                     run every scenario, fail on diff
//   bun run bench -- --update         rewrite each scenario's expected.json
//   bun run bench -- federation-chain only run that scenario

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface ScenarioContext {
	// every scenario runs in a tmp dir; scenario.ts writes project
	// sources under tmpRoot/<project-id>/ and asks the runner to index
	// them. the helpers come from bench/harness.ts.
	tmpRoot: string
	scenarioDir: string
}

export interface ScenarioResult {
	queries: Record<string, unknown>
	timings?: Record<string, number>
}

export interface Scenario {
	name: string
	description?: string
	// upper bound on total wall time across every indexed project + query
	// run. catches bfs-blowup class bugs (see #72 r2). milliseconds.
	timeBudgetMs?: number
	run(ctx: ScenarioContext): Promise<ScenarioResult> | ScenarioResult
}

interface CliOptions {
	update: boolean
	filter: string[]
}

function parseCli(argv: string[]): CliOptions {
	const opts: CliOptions = { update: false, filter: [] }
	for (const arg of argv) {
		if (arg === '--update') opts.update = true
		else if (!arg.startsWith('--')) opts.filter.push(arg)
	}
	return opts
}

function listScenarioDirs(scenariosDir: string): string[] {
	return readdirSync(scenariosDir)
		.filter((entry) => {
			const s = statSync(join(scenariosDir, entry))
			return s.isDirectory()
		})
		.sort()
}

// stable JSON emit: keys are sorted recursively so snapshots diff cleanly
function canonicalJson(value: unknown): string {
	return `${stringify(value, 0)}\n`
}

function stringify(value: unknown, indent: number): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]'
		const inner = value.map((v) => `${pad(indent + 1)}${stringify(v, indent + 1)}`).join(',\n')
		return `[\n${inner}\n${pad(indent)}]`
	}
	const rec = value as Record<string, unknown>
	const keys = Object.keys(rec).sort()
	if (keys.length === 0) return '{}'
	const inner = keys
		.map((k) => `${pad(indent + 1)}${JSON.stringify(k)}: ${stringify(rec[k], indent + 1)}`)
		.join(',\n')
	return `{\n${inner}\n${pad(indent)}}`
}

function pad(indent: number): string {
	return '\t'.repeat(indent)
}

async function runScenario(
	scenarioDir: string,
	update: boolean,
): Promise<{ name: string; ok: boolean; message?: string }> {
	const scenarioPath = join(scenarioDir, 'scenario.ts')
	const mod = await import(scenarioPath)
	const scenario: Scenario = mod.default ?? mod.scenario
	if (!scenario) {
		return { name: scenarioDir, ok: false, message: `no default export in ${scenarioPath}` }
	}

	const tmpRoot = await import('node:fs').then((fs) =>
		fs.mkdtempSync(join(require('node:os').tmpdir(), 'atlas-bench-')),
	)

	const start = Date.now()
	let result: ScenarioResult
	try {
		result = await scenario.run({ tmpRoot, scenarioDir })
	} finally {
		// leave tmpRoot for inspection if the scenario throws. cleanup
		// happens via the harness helper in harness.ts on success.
	}
	const elapsed = Date.now() - start
	if (scenario.timeBudgetMs && elapsed > scenario.timeBudgetMs) {
		return {
			name: scenario.name,
			ok: false,
			message: `time budget exceeded: ${elapsed}ms > ${scenario.timeBudgetMs}ms`,
		}
	}

	const expectedPath = join(scenarioDir, 'expected.json')
	const actual = canonicalJson(result.queries)
	if (update) {
		writeFileSync(expectedPath, actual)
		return { name: scenario.name, ok: true, message: `snapshot updated (${elapsed}ms)` }
	}

	let expected: string
	try {
		expected = readFileSync(expectedPath, 'utf-8')
	} catch {
		writeFileSync(expectedPath, actual)
		return {
			name: scenario.name,
			ok: true,
			message: `initial snapshot written (${elapsed}ms)`,
		}
	}
	if (actual === expected) {
		return { name: scenario.name, ok: true, message: `ok (${elapsed}ms)` }
	}
	return {
		name: scenario.name,
		ok: false,
		message: `snapshot mismatch. rerun with \`bun run bench -- --update\` to accept.\n${diffPreview(expected, actual)}`,
	}
}

function diffPreview(expected: string, actual: string): string {
	const expLines = expected.split('\n')
	const actLines = actual.split('\n')
	const max = Math.max(expLines.length, actLines.length)
	const out: string[] = []
	for (let i = 0; i < max; i++) {
		if (expLines[i] !== actLines[i]) {
			if (expLines[i] !== undefined) out.push(`  - ${expLines[i]}`)
			if (actLines[i] !== undefined) out.push(`  + ${actLines[i]}`)
			if (out.length >= 20) {
				out.push('  ... (truncated)')
				break
			}
		}
	}
	return out.join('\n')
}

async function main() {
	const opts = parseCli(process.argv.slice(2))
	const scenariosDir = resolve(import.meta.dir, 'scenarios')
	const allScenarios = listScenarioDirs(scenariosDir)
	const targets = opts.filter.length > 0
		? allScenarios.filter((s) => opts.filter.includes(s))
		: allScenarios
	if (targets.length === 0) {
		console.error(`no scenarios matched ${opts.filter.join(', ')}. available: ${allScenarios.join(', ')}`)
		process.exit(1)
	}

	let failed = 0
	for (const name of targets) {
		const scenarioDir = join(scenariosDir, name)
		try {
			const res = await runScenario(scenarioDir, opts.update)
			const tag = res.ok ? 'ok' : 'FAIL'
			console.log(`${tag}  ${res.name}  ${res.message ?? ''}`)
			if (!res.ok) failed++
		} catch (e) {
			console.log(`FAIL  ${name}  threw: ${e instanceof Error ? e.stack : e}`)
			failed++
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} scenario(s) failed`)
		process.exit(1)
	}
}

if (import.meta.main) {
	await main()
}
