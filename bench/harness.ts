// shared helpers for bench scenarios. keeps project-setup boilerplate
// out of each scenario.ts so the scenario file stays focused on its
// assertions. see #83.

import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AtlasEngine } from '../src/core/engine.js'
import { addProject, linkProjects } from '../src/core/registry.js'
import { closeAll, getOrCreateEngine } from '../src/core/engine-pool.js'

export interface ProjectSpec {
	// id comes from addProject; scenarios should not hard-code it. store
	// the returned id on the SetupResult instead.
	name: string
	sourceDir: string
}

export interface SetupResult {
	projects: Array<{ name: string; id: string; root: string; engine: AtlasEngine }>
	teardown: () => void
}

// copies each project's source tree into tmpRoot/<name>, registers the
// project, indexes it with noEmbed+noSummarize, and optionally links
// every pair of projects so cross_project_edges writes have matching
// registry rows. returns a teardown fn that closes every engine and
// removes the tmp registry.
export async function setupScenario(
	tmpRoot: string,
	projects: ProjectSpec[],
	opts: { linkPairs?: Array<[string, string]> } = {},
): Promise<SetupResult> {
	const registryHome = join(tmpRoot, 'home')
	mkdirSync(registryHome, { recursive: true })
	const originalHome = process.env.HOME
	process.env.HOME = registryHome

	const out: SetupResult['projects'] = []
	// guarded setup: if addProject / engine.index / linkProjects throws
	// partway through, restore HOME and close any engines we already
	// opened before rethrowing. otherwise later scenarios run against a
	// polluted engine pool + wrong HOME and fail for unrelated reasons.
	// see deep-review pass 1/2 codex findings on harness state leaks.
	try {
		for (const p of projects) {
			const root = join(tmpRoot, p.name)
			mkdirSync(root, { recursive: true })
			cpSync(p.sourceDir, root, { recursive: true })
			const entry = addProject(root)
			const engine = getOrCreateEngine(entry.id, root)
			await engine.index({ noEmbed: true, noSummarize: true, force: true })
			out.push({ name: p.name, id: entry.id, root, engine })
		}

		for (const [left, right] of opts.linkPairs ?? []) {
			const lp = out.find((p) => p.name === left)
			const rp = out.find((p) => p.name === right)
			if (!lp || !rp) throw new Error(`linkPairs references unknown project ${left}/${right}`)
			linkProjects(lp.id, rp.id)
		}
	} catch (e) {
		closeAll()
		process.env.HOME = originalHome
		throw e
	}

	const teardown = () => {
		closeAll()
		process.env.HOME = originalHome
		rmSync(tmpRoot, { recursive: true, force: true })
	}
	return { projects: out, teardown }
}

// resolve a symbol by name in one project, returning its stable_id.
// throws when the name is ambiguous or missing. scenarios should name
// unique exports so assertions stay deterministic.
export function resolveStableId(engine: AtlasEngine, name: string): string {
	const result = engine.resolveSymbolIdentity(name)
	if (!result) throw new Error(`resolveStableId: symbol not found: ${name}`)
	return result.stableId
}
