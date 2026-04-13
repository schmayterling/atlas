import type { AtlasStore } from '../storage/store.js'
import type {
	HotFragileEntry,
	SymbolKind,
	SymbolResult,
	TestConfidence,
	TestCoverage,
	TestCoverageEntry,
} from '../../shared/types.js'

// only function-like kinds can produce 'called' coverage. classes,
// interfaces, types, enums, and variables cannot appear as the target of a
// `calls` edge under atlas's TS resolver, so they are systematic false
// positives if treated as untested.
const CALLABLE_KINDS = ['function', 'method'] as const
type CallableKind = (typeof CALLABLE_KINDS)[number]

function isCallableKind(kind: SymbolKind | undefined): kind is CallableKind {
	return kind === 'function' || kind === 'method'
}

// resolve a symbol query (name or qualifiedName) to its test coverage row.
export function getTestCoverage(store: AtlasStore, query: string): TestCoverage | null {
	const symbol = store.resolveSymbol(query)
	if (!symbol) return null
	const target = store.symbolToResult(symbol)
	const rows = store.queryRawWithParams<{ filePath: string; confidence: TestConfidence }>(
		`SELECT f.path as filePath, tl.confidence
		 FROM test_links tl
		 JOIN files f ON f.id = tl.test_file_id
		 WHERE tl.source_symbol_stable_id = ?
		 ORDER BY tl.confidence DESC, f.path`,
		symbol.stableId,
	)
	const tests: TestCoverageEntry[] = rows.map((r) => ({ testFilePath: r.filePath, confidence: r.confidence }))
	const coveredBy: TestCoverage['coveredBy'] = tests.some((t) => t.confidence === 'called')
		? 'called'
		: tests.length > 0
			? 'imported'
			: 'none'
	return { target, tests, coveredBy }
}

// list exported, production symbols of callable kinds (function, method)
// with no 'called' coverage. an 'imported' row alone is not enough: it just
// means a test imported the module that contains the symbol, not that the
// test exercises it. only edge-resolved 'called' confidence counts.
//
// non-callable kinds (class, interface, type, enum, variable) are excluded
// because the TS resolver does not currently emit `calls` edges for them
// even when tests instantiate them or reference their types.
export function findUntestedSymbols(
	store: AtlasStore,
	opts?: { kind?: SymbolKind; limit?: number },
): SymbolResult[] {
	const limit = opts?.limit ?? 100
	if (opts?.kind && !isCallableKind(opts.kind)) {
		// asking for an inherently non-callable kind. return empty rather
		// than silently ANDing two contradictory clauses.
		return []
	}
	const kindList = opts?.kind
		? `'${opts.kind}'`
		: CALLABLE_KINDS.map((k) => `'${k}'`).join(',')
	return store.queryRawWithParams<SymbolResult>(
		`SELECT s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
		f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
		s.is_exported as isExported, s.doc_comment as docComment,
		0 as usageCount, 0 as dependentCount
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		WHERE s.is_exported = 1
		AND f.is_test = 0
		AND s.kind IN (${kindList})
		AND NOT EXISTS (
			SELECT 1 FROM test_links tl
			WHERE tl.source_symbol_stable_id = s.stable_id
			AND tl.confidence = 'called'
		)
		ORDER BY f.path, s.line_start
		LIMIT ?`,
		limit,
	)
}

// hot-fragile = production files with high churn and many callable exported
// symbols lacking 'called' coverage. ranks by commits * untestedCount.
//
// only callable kinds count toward symbolCount/untestedCount, mirroring
// findUntestedSymbols. files with no callable exports do not appear at all
// (the LEFT JOIN's null-extended row is suppressed by the s.id IS NOT NULL
// guard inside SUM, and HAVING symbolCount > 0 drops zero-callable files).
//
// `previewNames` is the file's own first-3 untested callables, computed in
// a window-function CTE (ROW_NUMBER partitioned by file_id). operators use
// this to pick which file to write tests for next; the previous surfaces
// rendered the LLM-generated subsystem name in that column, which repeated
// across unrelated files because the subsystem "name" is itself a
// comma-separated list of types. see #24.
export function findHotFragile(
	store: AtlasStore,
	opts?: { limit?: number; excludeFileIds?: Set<number> },
): HotFragileEntry[] {
	const limit = opts?.limit ?? 20
	const kindList = CALLABLE_KINDS.map((k) => `'${k}'`).join(',')
	// generated-file exclusion inlined into the WHERE clause so
	// fake_*.go / mocks/ / counterfeiter output never pollutes the
	// hot-fragile ranking. see #44.
	const excludeFilter =
		opts?.excludeFileIds && opts.excludeFileIds.size > 0
			? ` AND f.id NOT IN (${Array.from(opts.excludeFileIds).join(',')})`
			: ''
	type Row = Omit<HotFragileEntry, 'previewNames'> & { previewJson: string | null }
	const rows = store.queryRawWithParams<Row>(
		`WITH untested_ranked AS (
			SELECT s.file_id, s.name, s.line_start, s.id,
			       ROW_NUMBER() OVER (PARTITION BY s.file_id ORDER BY s.line_start, s.id) as rn
			FROM symbols s
			LEFT JOIN test_links tl2
			       ON tl2.source_symbol_stable_id = s.stable_id
			      AND tl2.confidence = 'called'
			WHERE s.is_exported = 1
			  AND s.kind IN (${kindList})
			  AND tl2.source_symbol_stable_id IS NULL
		),
		preview AS (
			SELECT file_id, json_group_array(name) as names
			FROM untested_ranked
			WHERE rn <= 3
			GROUP BY file_id
		)
		SELECT f.path as filePath,
		        c.commits as commits,
		        COUNT(s.id) as symbolCount,
		        SUM(CASE WHEN s.id IS NOT NULL AND tl.source_symbol_stable_id IS NULL THEN 1 ELSE 0 END) as untestedCount,
		        ss.name as subsystem,
		        p.names as previewJson
		 FROM files f
		 JOIN (
		   SELECT file_path, COUNT(DISTINCT commit_hash) as commits
		   FROM file_changes
		   GROUP BY file_path
		 ) c ON c.file_path = f.path
		 LEFT JOIN symbols s
		   ON s.file_id = f.id
		   AND s.is_exported = 1
		   AND s.kind IN (${kindList})
		 LEFT JOIN test_links tl
		   ON tl.source_symbol_stable_id = s.stable_id
		   AND tl.confidence = 'called'
		 LEFT JOIN subsystems ss ON ss.id = f.subsystem_id
		 LEFT JOIN preview p ON p.file_id = f.id
		 WHERE f.is_test = 0${excludeFilter}
		 GROUP BY f.id
		 HAVING symbolCount > 0 AND untestedCount > 0
		 ORDER BY commits * untestedCount DESC, commits DESC
		 LIMIT ?`,
		limit,
	)
	return rows.map((r) => ({
		filePath: r.filePath,
		commits: r.commits,
		symbolCount: r.symbolCount,
		untestedCount: r.untestedCount,
		subsystem: r.subsystem,
		previewNames: r.previewJson ? (JSON.parse(r.previewJson) as string[]) : [],
		// explicit score fields so consumers don't have to recompute.
		// churnScore == commits (same value, named for clarity);
		// fragilityScore is the canonical ranking dimension. see #43.
		churnScore: r.commits,
		fragilityScore: r.commits * r.untestedCount,
	}))
}
