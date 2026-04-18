import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { log } from '../../shared/logger.js'

let vectorsEnabled = false
let initialized = false

// must be called once at process startup, before any new Database().
// on macOS, Apple's system SQLite doesn't support extensions;
// we need Homebrew's vanilla SQLite.
export function initSqliteExtensions() {
	if (initialized) return
	initialized = true

	if (process.platform === 'darwin') {
		const paths = [
			'/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', // apple silicon
			'/usr/local/opt/sqlite/lib/libsqlite3.dylib', // intel
		]
		for (const p of paths) {
			if (existsSync(p)) {
				try {
					Database.setCustomSQLite(p)
					vectorsEnabled = true
					log.debug(`using Homebrew SQLite from ${p}`)
					return
				} catch (e) {
					log.warn(`failed to set custom SQLite at ${p}: ${e}`)
				}
			}
		}
		log.warn('no Homebrew SQLite found, vector search disabled')
	} else {
		// linux: bun's bundled SQLite supports extensions
		vectorsEnabled = true
	}
}

export function isVectorSearchAvailable(): boolean {
	return vectorsEnabled
}

export function resetForTesting() {
	vectorsEnabled = false
	initialized = false
}

// load sqlite-vec into a database connection
export function loadVecExtension(db: Database) {
	if (!vectorsEnabled) return

	try {
		// dynamic import to avoid errors when sqlite-vec is not installed
		const sqliteVec = require('sqlite-vec')
		sqliteVec.load(db)
	} catch (e) {
		log.warn(`failed to load sqlite-vec extension: ${e}`)
		vectorsEnabled = false
	}
}
