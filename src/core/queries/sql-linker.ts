import { readFileSync, realpathSync } from 'node:fs'
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

// table-name patterns. accepts:
//   - plain identifiers: FROM users
//   - ascii quoted identifiers: FROM "users", 'users', `users`
//   - T-SQL brackets, optionally schema-qualified: FROM [users],
//     FROM [dbo].[audit_log]
//   - bare schema qualification: FROM public.users
//
// the capture group takes the full qualified name including brackets
// and schema; normaliseTableName() strips both. the regex is
// deliberately tolerant — rare false positives are caught later by
// the string-literal containment check and the blocklist.
//
// the FROM pattern already matches `DELETE FROM users`, so a separate
// DELETE FROM pattern would emit duplicate hits at the same (symbol,
// value, line) coordinate — the channel_hits UNIQUE constraint would
// swallow them, but building the redundant match is pure waste.
const TABLE_TOKEN = '(?:\\[[\\w.]+\\]|[\\w.]+)(?:\\.(?:\\[[\\w.]+\\]|[\\w.]+))?'
const SQL_KEYWORD_PATTERNS: RegExp[] = [
	new RegExp(`\\bFROM\\s+(?:["'\`])?(${TABLE_TOKEN})(?:["'\`])?`, 'gi'),
	new RegExp(`\\bJOIN\\s+(?:["'\`])?(${TABLE_TOKEN})(?:["'\`])?`, 'gi'),
	new RegExp(`\\bINTO\\s+(?:["'\`])?(${TABLE_TOKEN})(?:["'\`])?`, 'gi'),
	new RegExp(`\\bUPDATE\\s+(?:["'\`])?(${TABLE_TOKEN})(?:["'\`])?`, 'gi'),
]

// detect CTE names declared in a `WITH name AS (...)` clause so the
// post-processor can filter them out of the hit set. T-SQL CTEs can
// chain via commas: `WITH a AS (...), b AS (...)`. we accept both
// forms via a single non-global regex applied to the line head up
// to the current match. see #39.
const WITH_CTE_PATTERN = /\bWITH\s+(?:RECURSIVE\s+)?([\w,\s]+?)\s+AS\s*\(/gi

// prefer the right-hand token when a schema-qualified name slips
// through (e.g. `public.users` or `dbo.orders`). strips bracket
// wrappers if present since the regex above already handled the
// outer brackets but nested identifiers may still carry them.
function normaliseTableName(raw: string): string {
	const unbracketed = raw.replace(/^\[|\]$/g, '')
	const dot = unbracketed.lastIndexOf('.')
	return dot >= 0 ? unbracketed.slice(dot + 1).replace(/^\[|\]$/g, '') : unbracketed
}

// collect CTE names declared earlier in the source (before the
// match offset). called per-hit because CTEs live within a single
// statement and we want the filter to apply file-wide: every `WITH
// recent AS (...)` in the file masks `recent` as a "table" match
// downstream from it.
function collectCteNames(source: string): Set<string> {
	const names = new Set<string>()
	for (const m of source.matchAll(WITH_CTE_PATTERN)) {
		const header = m[1]
		if (!header) continue
		for (const part of header.split(',')) {
			const trimmed = part.trim()
			if (trimmed) names.add(trimmed.toLowerCase())
		}
	}
	return names
}

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
	store.deleteChannelHitsByKind('sql_table')

	const files = store.getAllFiles().filter((f) => !f.isTest)
	const hits: ChannelHit[] = []
	const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.go', '.py'])
	const rootReal = realpathOrNull(projectRoot) ?? projectRoot

	for (const f of files) {
		const dot = f.path.lastIndexOf('.')
		if (dot < 0) continue
		const ext = f.path.slice(dot)
		if (!allowedExtensions.has(ext)) continue

		const resolved = resolvePath(projectRoot, f.path)
		// symlink containment guard: if a repo contains a symlink whose
		// real path escapes projectRoot, skip it. otherwise the linker
		// would read and scan arbitrary files on disk via a path
		// sourced from the files table.
		const resolvedReal = realpathOrNull(resolved)
		if (resolvedReal && !isUnderRoot(resolvedReal, rootReal)) continue

		let source: string
		try {
			source = readFileSync(resolved, 'utf-8')
		} catch (e) {
			log.warn(`sql-linker: read ${f.path}: ${e}`)
			continue
		}

		// precompute newline offsets once per file. offsetToLine below
		// does a binary search, making line lookup O(log N) per match
		// instead of O(N) for the previous character-by-character scan.
		const lineOffsets = buildLineOffsets(source)

		// CTE filter (#39): collect every `WITH name AS (...)`
		// identifier in the file. these alias a query fragment, not
		// a real table, so they must be dropped from the hit set.
		const cteNames = collectCteNames(source)

		for (const pattern of SQL_KEYWORD_PATTERNS) {
			for (const m of source.matchAll(pattern)) {
				const raw = m[1]
				const matchIndex = m.index
				if (!raw || matchIndex === undefined) continue

				// normalise schema-qualified names: `public.users` -> `users`
				const table = normaliseTableName(raw)
				if (!table) continue
				if (SQL_KEYWORD_BLOCKLIST.has(table.toLowerCase())) continue
				if (cteNames.has(table.toLowerCase())) continue
				if (!isInsideStringLiteral(source, matchIndex)) continue

				const line = offsetToLine(lineOffsets, matchIndex) + 1
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

function buildLineOffsets(source: string): number[] {
	const offsets = [0]
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10) offsets.push(i + 1)
	}
	return offsets
}

function offsetToLine(offsets: number[], matchIndex: number): number {
	let lo = 0
	let hi = offsets.length - 1
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if (offsets[mid] <= matchIndex) lo = mid
		else hi = mid - 1
	}
	return lo
}

function realpathOrNull(p: string): string | null {
	try {
		return realpathSync(p)
	} catch {
		return null
	}
}

function isUnderRoot(abs: string, root: string): boolean {
	const normRoot = root.endsWith('/') ? root : `${root}/`
	return abs === root || abs.startsWith(normRoot)
}
