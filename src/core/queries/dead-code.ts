import type { DeadCodeResult, SymbolKind, SymbolResult } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'

export function findDeadCode(
	store: AtlasStore,
	opts?: {
		path?: string
		kind?: SymbolKind
		includeTests?: boolean
		excludeFileIds?: Set<number>
		// #86: when set, switch to "internal-only" mode and return
		// symbols that are called but all callers live under this
		// prefix. explicit mode switch rather than union with normal
		// dead-code output so results stay coherent.
		callersWithin?: string
	},
): DeadCodeResult {
	if (opts?.callersWithin) {
		return findInternalOnlySymbols(store, opts as {
			path?: string
			kind?: SymbolKind
			includeTests?: boolean
			excludeFileIds?: Set<number>
			callersWithin: string
		})
	}
	// recursive reachability from a root set. the previous
	// "stable_id NOT IN (SELECT target_id FROM edges)" check
	// treated any inbound edge as liveness, which left mutually
	// recursive unreachable islands alive (two functions calling
	// each other both have an inbound edge and neither is a
	// reachable root). the CTE walks edges forward from roots and
	// then inverts to find unreachable non-exported symbols.
	//
	// roots:
	//   - symbols whose own is_exported=1, OR whose parent class
	//     is is_exported=1 (class methods inherit exportedness;
	//     see #34 and commit 363a2db)
	//   - non-test files only (test symbols form their own
	//     reachability world)
	//   - symbols referenced from test_links with confidence
	//     'called' (tests actually exercise them)
	//   - server-side api_endpoints (reachable via the HTTP
	//     surface)
	//
	// traversal kinds include passed_as and dispatches_to so
	// middleware / handler / go interface dispatch are credited.
	// see #41, #49, #50.
	let sql = `WITH RECURSIVE roots(stable_id) AS (
		SELECT s.stable_id
		FROM symbols s
		LEFT JOIN symbols p ON p.stable_id = s.parent_id
		JOIN files f ON f.id = s.file_id
		WHERE f.is_test = 0
		  AND (s.is_exported = 1 OR p.is_exported = 1)
		UNION
		SELECT source_symbol_stable_id FROM test_links
		WHERE confidence = 'called'
		UNION
		SELECT symbol_stable_id FROM api_endpoints
		WHERE symbol_stable_id IS NOT NULL
	),
	reachable(stable_id) AS (
		SELECT stable_id FROM roots
		UNION
		SELECT e.target_id
		FROM edges e
		JOIN reachable r ON r.stable_id = e.source_id
		WHERE e.kind IN ('calls', 'type_ref', 'extends', 'passed_as', 'dispatches_to', 'instantiates', 'field_access')
	)
	SELECT s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
		f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
		s.is_exported as isExported, s.doc_comment as docComment
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		WHERE s.is_exported = 0
			AND s.kind IN ('function', 'class', 'method', 'interface', 'type', 'enum')
			AND s.name != 'constructor'
			AND s.stable_id NOT IN (SELECT stable_id FROM reachable)`

	if (!opts?.includeTests) {
		sql += ' AND f.is_test = 0'
	}

	const params: (string | number)[] = []

	// generated / mock / fake files are filtered out via the engine-
	// level cache (findGeneratedFileIds). without this filter counter-
	// feiter fake_*.go files dominate dead-code output on real go
	// codebases. see #44.
	if (opts?.excludeFileIds && opts.excludeFileIds.size > 0) {
		const placeholders = Array.from(opts.excludeFileIds, () => '?').join(',')
		sql += ` AND f.id NOT IN (${placeholders})`
		for (const id of opts.excludeFileIds) params.push(id)
	}

	if (opts?.path) {
		const escapedPath = opts.path.replace(/%/g, '\\%').replace(/_/g, '\\_')
		sql += ` AND f.path LIKE ? ESCAPE '\\'`
		params.push(`%${escapedPath}%`)
	}

	if (opts?.kind) {
		sql += ' AND s.kind = ?'
		params.push(opts.kind)
	}

	sql += ' ORDER BY f.path, s.line_start'

	const rows = store.queryRawWithParams<{
		name: string
		qualifiedName: string
		kind: string
		signature: string | null
		filePath: string
		lineStart: number
		lineEnd: number
		isExported: number
		docComment: string | null
	}>(sql, ...params)

	const symbols: SymbolResult[] = rows.map((r) => ({
		name: r.name,
		qualifiedName: r.qualifiedName,
		kind: r.kind as SymbolKind,
		signature: r.signature,
		filePath: r.filePath,
		lineStart: r.lineStart,
		lineEnd: r.lineEnd,
		isExported: false,
		docComment: r.docComment,
		usageCount: 0,
		dependentCount: 0,
	}))

	const byKind: Record<string, number> = {}
	const byFile: Record<string, number> = {}
	for (const sym of symbols) {
		byKind[sym.kind] = (byKind[sym.kind] ?? 0) + 1
		byFile[sym.filePath] = (byFile[sym.filePath] ?? 0) + 1
	}

	return {
		symbols,
		stats: { total: symbols.length, byKind, byFile },
	}
}

// #86 "internal-only" mode. returns symbols whose definition lives
// under `callersWithin` prefix, have at least one inbound relevant
// edge, and have zero inbound relevant edges whose source file lives
// outside the prefix. the path filter on the symbol itself is kept
// separately so callers can scope both the definition and the caller
// boundary (typical usage: `--path X --callers-within X`), or scope
// them independently when migrating code between modules.
//
// the relevant-edge set mirrors the main dead-code CTE so an
// instantiates-only caller or a passed_as-only caller both count as
// "has callers". test files are excluded from the caller-side check
// by default because tests are free to reach across module
// boundaries; toggling includeTests relaxes that.
function findInternalOnlySymbols(
	store: AtlasStore,
	opts: {
		path?: string
		kind?: SymbolKind
		includeTests?: boolean
		excludeFileIds?: Set<number>
		callersWithin: string
	},
): DeadCodeResult {
	const relevantKinds = "('calls', 'type_ref', 'extends', 'passed_as', 'dispatches_to', 'instantiates', 'field_access')"
	const escapedPrefix = opts.callersWithin.replace(/%/g, '\\%').replace(/_/g, '\\_')
	const prefixLike = `${escapedPrefix}%`

	let sql = `SELECT s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
		f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
		s.is_exported as isExported, s.doc_comment as docComment
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		WHERE s.kind IN ('function', 'class', 'method', 'interface', 'type', 'enum')
		AND s.name != 'constructor'
		AND EXISTS (
			SELECT 1 FROM edges e
			JOIN symbols src ON src.stable_id = e.source_id
			JOIN files sf ON sf.id = src.file_id
			WHERE e.target_id = s.stable_id
			AND e.kind IN ${relevantKinds}
		)
		AND NOT EXISTS (
			SELECT 1 FROM edges e
			JOIN symbols src ON src.stable_id = e.source_id
			JOIN files sf ON sf.id = src.file_id
			WHERE e.target_id = s.stable_id
			AND e.kind IN ${relevantKinds}
			AND sf.path NOT LIKE ? ESCAPE '\\'
			${opts.includeTests ? '' : 'AND sf.is_test = 0'}
		)`

	const params: (string | number)[] = [prefixLike]

	if (!opts.includeTests) {
		sql += ' AND f.is_test = 0'
	}
	if (opts.excludeFileIds && opts.excludeFileIds.size > 0) {
		const placeholders = Array.from(opts.excludeFileIds, () => '?').join(',')
		sql += ` AND f.id NOT IN (${placeholders})`
		for (const id of opts.excludeFileIds) params.push(id)
	}
	if (opts.path) {
		const escapedPath = opts.path.replace(/%/g, '\\%').replace(/_/g, '\\_')
		sql += ` AND f.path LIKE ? ESCAPE '\\'`
		params.push(`%${escapedPath}%`)
	}
	if (opts.kind) {
		sql += ' AND s.kind = ?'
		params.push(opts.kind)
	}
	sql += ' ORDER BY f.path, s.line_start'

	const rows = store.queryRawWithParams<{
		name: string
		qualifiedName: string
		kind: string
		signature: string | null
		filePath: string
		lineStart: number
		lineEnd: number
		isExported: number
		docComment: string | null
	}>(sql, ...params)

	const symbols: SymbolResult[] = rows.map((r) => ({
		name: r.name,
		qualifiedName: r.qualifiedName,
		kind: r.kind as SymbolKind,
		signature: r.signature,
		filePath: r.filePath,
		lineStart: r.lineStart,
		lineEnd: r.lineEnd,
		isExported: r.isExported === 1,
		docComment: r.docComment,
		usageCount: 0,
		dependentCount: 0,
	}))

	const byKind: Record<string, number> = {}
	const byFile: Record<string, number> = {}
	for (const sym of symbols) {
		byKind[sym.kind] = (byKind[sym.kind] ?? 0) + 1
		byFile[sym.filePath] = (byFile[sym.filePath] ?? 0) + 1
	}

	return {
		symbols,
		stats: { total: symbols.length, byKind, byFile },
	}
}
