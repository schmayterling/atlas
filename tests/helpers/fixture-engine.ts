import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import './setup.js'
import { AtlasEngine } from '../../src/core/engine.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TINY_PROJECT_ROOT = resolve(HERE, '../fixtures/tiny-project')

let cached: AtlasEngine | null = null

// returns an engine indexed against tests/fixtures/tiny-project, shared
// across tests in a single bun:test process. cleans the project's local
// .atlas dir on first call so the index is reproducible.
export async function getFixtureEngine(): Promise<AtlasEngine> {
	if (cached) return cached
	const atlasDir = resolve(TINY_PROJECT_ROOT, '.atlas')
	if (existsSync(atlasDir)) rmSync(atlasDir, { recursive: true, force: true })
	const engine = new AtlasEngine(TINY_PROJECT_ROOT)
	await engine.index({ noEmbed: true, noSummarize: true, force: true })
	cached = engine
	return engine
}
