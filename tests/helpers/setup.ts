// shared test setup. import this from every test file (or transitively
// via tmp-store / fixture-engine) so the sqlite-vec extension is loaded
// before any AtlasStore is constructed and the parser registry is
// populated before any extractor is invoked.
import { initSqliteExtensions } from '../../src/core/storage/sqlite-ext.js'
import '../../src/core/parser/parser-manager.js'

let initialized = false

export function ensureTestEnv(): void {
	if (initialized) return
	initSqliteExtensions()
	initialized = true
}

ensureTestEnv()
