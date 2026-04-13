import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { log } from '../../shared/logger.js'
import type { ChannelHit } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'

// sql-table channel linker (#10). walks every non-test source file
// atlas already knows about via getAllFiles(), regex-scans the file
// contents for table names in SQL keywords (FROM / JOIN / INTO /
// UPDATE / DELETE FROM), finds the smallest enclosing symbol for
// each hit via store.getSymbolContainingByte, and writes one
// channel_hits row per (symbol, table, line).
//
// scope: language-agnostic regex match. strict enough that
// `users.where(...)` ORM chains don't match because there is no
// `FROM` keyword. accepts quoted identifiers (`FROM "users"`,
// `FROM \`users\``). t-sql bracketed identifiers are NOT in scope
// for the MVP.
//
// iterates files from the store's files table (not a custom disk
// walk), so atlas's own exclude patterns and files.is_test filter
// are respected without duplicating the discovery logic. the
// channel rows are written inside a single transaction via
// insertChannelHits.

const SQL_KEYWORD_PATTERNS: RegExp[] = [
	// FROM table, FROM "table", FROM `table`, FROM 'table'
	/\bFROM\s+(?:["'`])?(\w+)(?:["'`])?/gi,
	/\bJOIN\s+(?:["'`])?(\w+)(?:["'`])?/gi,
	/\bINTO\s+(?:["'`])?(\w+)(?:["'`])?/gi,
	/\bUPDATE\s+(?:["'`])?(\w+)(?:["'`])?/gi,
	/\bDELETE\s+FROM\s+(?:["'`])?(\w+)(?:["'`])?/gi,
]

// reserved words that sometimes appear after FROM / JOIN etc. but
// are NEVER real table names. dropping them cuts false positives
// from sql grammar fragments like `CREATE INDEX ... ON ... USING`.
const SQL_KEYWORD_BLOCKLIST = new Set([
	'select',
	'where',
	'order',
	'group',
	'having',
	'limit',
	'offset',
	'as',
	'on',
	'using',
	'left',
	'right',
	'inner',
	'outer',
	'full',
	'cross',
	'natural',
])

// some code legitimately contains `FROM`/`JOIN`/etc. in prose or
// docs. skip the match entirely if it is not inside a recognisable
// string literal context. the heuristic is: only emit a hit when
// an odd number of quote characters appear on the line before the
// match index. cheap, strict, and matches how real orm / query
// code looks.
function isInsideStringLiteral(source: string, matchIndex: number): boolean {
	const lineStart = source.lastIndexOf('\n', matchIndex) + 1
	const lineHead = source.slice(lineStart, matchIndex)
	let inSingle = false
	let inDouble = false
	let inBacktick = false
	for (let i = 0; i < lineHead.length; i++) {
		const c = lineHead[i]
		if (c === '\\') {
			i++
			continue
		}
		if (c === "'" && !inDouble && !inBacktick) inSingle = !inSingle
		else if (c === '"' && !inSingle && !inBacktick) inDouble = !inDouble
		else if (c === '`' && !inSingle && !inDouble) inBacktick = !inBacktick
	}
	return inSingle || inDouble || inBacktick
}

export function linkSqlTables(store: AtlasStore, projectRoot: string): { hits: number } {
	// delete-before-insert keeps the channel idempotent on re-runs.
	// INSERT OR IGNORE plus the UNIQUE constraint handles the
	// partial-replay case, but deleting first is the cleanest way
	// to pick up removed queries that no longer exist in source.
	store.deleteChannelHitsByKind('sql_table')

	const files = store.getAllFiles().filter((f) => !f.isTest)
	const hits: ChannelHit[] = []
	const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.go', '.py'])

	for (const f of files) {
		// cheap extension filter avoids reading binary assets or yaml
		// configs. the files table carries the language string but
		// the extension match is tighter and skips generated edge
		// cases (e.g. .md files incidentally registered).
		const dot = f.path.lastIndexOf('.')
		if (dot < 0) continue
		const ext = f.path.slice(dot)
		if (!allowedExtensions.has(ext)) continue

		let source: string
		try {
			source = readFileSync(resolvePath(projectRoot, f.path), 'utf-8')
		} catch (e) {
			log.warn(`sql-linker: read ${f.path}: ${e}`)
			continue
		}

		for (const pattern of SQL_KEYWORD_PATTERNS) {
			// matchAll returns an iterator of RegExpMatchArray with
			// .index populated, which is what we need for the
			// byte-offset lookup.
			for (const m of source.matchAll(pattern)) {
				const table = m[1]
				const matchIndex = m.index
				if (!table || matchIndex === undefined) continue
				const lower = table.toLowerCase()
				if (SQL_KEYWORD_BLOCKLIST.has(lower)) continue
				if (!isInsideStringLiteral(source, matchIndex)) continue

				const line = countLines(source, matchIndex) + 1
				const enclosing = store.getSymbolContainingByte(f.id, matchIndex)
				if (!enclosing) continue

				hits.push({
					symbolStableId: enclosing.stableId,
					fileId: f.id,
					kind: 'sql_table',
					value: table,
					line,
					metadata: null,
				})
			}
		}
	}

	if (hits.length > 0) store.insertChannelHits(hits)
	return { hits: hits.length }
}

function countLines(source: string, offset: number): number {
	let count = 0
	for (let i = 0; i < offset; i++) {
		if (source.charCodeAt(i) === 10) count++
	}
	return count
}
