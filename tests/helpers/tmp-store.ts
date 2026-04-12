import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './setup.js'
import { AtlasStore } from '../../src/core/storage/store.js'

export interface TempStore {
	store: AtlasStore
	cleanup: () => void
}

export function createTempStore(): TempStore {
	const dir = mkdtempSync(join(tmpdir(), 'atlas-test-'))
	const store = new AtlasStore(join(dir, 'atlas.db'))
	return {
		store,
		cleanup: () => {
			try {
				store.close()
			} catch {
				// already closed
			}
			rmSync(dir, { recursive: true, force: true })
		},
	}
}
