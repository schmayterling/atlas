// shared test setup. import this from every test file (or transitively
// via tmp-store / fixture-engine) so the sqlite-vec extension is loaded
// before any AtlasStore is constructed and the parser registry is
// populated before any extractor is invoked.
//
// ALSO: redirects $HOME to a shared tmp dir before importing any module
// that might read the registry. registry.ts reads process.env.HOME
// lazily, so pinning HOME here keeps every test file's registry view
// scoped to a disposable fake home without races across files. tests
// that need an isolated registry mutate process.env.HOME inside their
// own beforeEach/beforeAll against any other tmp dir; they restore to
// this fake home in afterEach. see #38.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// intercept HOME before anything else. registry.ts isn't imported yet,
// but even if it was, its lazy getter re-reads process.env.HOME on
// every call so this mutation always wins.
if (!process.env.ATLAS_TEST_HOME) {
	const fakeHome = mkdtempSync(join(tmpdir(), 'atlas-test-home-'))
	process.env.HOME = fakeHome
	process.env.ATLAS_TEST_HOME = fakeHome
} else if (process.env.HOME !== process.env.ATLAS_TEST_HOME) {
	// a sibling test file already created the fake home via a prior
	// import of this module. inherit it so every file points at the
	// same tmp dir.
	process.env.HOME = process.env.ATLAS_TEST_HOME
}

import { initSqliteExtensions } from '../../src/core/storage/sqlite-ext.js'
import '../../src/core/parser/parser-manager.js'

let initialized = false

export function ensureTestEnv(): void {
	if (initialized) return
	initSqliteExtensions()
	initialized = true
}

ensureTestEnv()
