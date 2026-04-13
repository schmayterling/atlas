import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import './setup.js'
import type { AtlasEngine } from '../../src/core/engine.js'
import { getOrCreateEngine } from '../../src/core/engine-pool.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TINY_PROJECT_ROOT = resolve(HERE, '../fixtures/tiny-project')

let initialized = false

// returns an engine indexed against tests/fixtures/tiny-project. routed
// through the engine pool (rather than constructing AtlasEngine directly)
// so that web/MCP route tests, which call getOrCreateEngine themselves,
// see the same indexed instance. cleans the project's .atlas dir on first
// call to keep the index reproducible across runs.
export async function getFixtureEngine(): Promise<AtlasEngine> {
	const engine = getOrCreateEngine(undefined, TINY_PROJECT_ROOT)
	if (!initialized) {
		const atlasDir = resolve(TINY_PROJECT_ROOT, '.atlas')
		if (existsSync(atlasDir)) {
			engine.close()
			rmSync(atlasDir, { recursive: true, force: true })
		}
		// withGitHub: false so test fixtures never spawn `gh auth status`
		// or hit github.com. #48 flipped the default to on, but tests
		// that live inside the atlas repo tree inherit its github remote
		// through git rev-parse and would otherwise make thousands of
		// api calls per test run.
		await engine.index({
			noEmbed: true,
			noSummarize: true,
			force: true,
			withGitHub: false,
		})
		initialized = true
	}
	return engine
}
