import type { AtlasStore } from '../storage/store.js'
import type {
	HotFragileEntry,
	SymbolKind,
	SymbolResult,
	TestConfidence,
	TestCoverage,
	TestCoverageEntry,
} from '../../shared/types.js'

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

// list exported, production symbols with no entry in test_links.
export function findUntestedSymbols(
	store: AtlasStore,
	opts?: { kind?: SymbolKind; limit?: number },
): SymbolResult[] {
	const limit = opts?.limit ?? 100
	const kindClause = opts?.kind ? 'AND s.kind = ?' : ''
	const params: (string | number)[] = []
	if (opts?.kind) params.push(opts.kind)
	params.push(limit)
	return store.queryRawWithParams<SymbolResult>(
		`SELECT s.name, s.qualified_name as qualifiedName, s.kind, s.signature,
		f.path as filePath, s.line_start as lineStart, s.line_end as lineEnd,
		s.is_exported as isExported, s.doc_comment as docComment,
		0 as usageCount, 0 as dependentCount
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		WHERE s.is_exported = 1
		AND f.is_test = 0
		AND s.kind IN ('function', 'class', 'method', 'interface')
		AND NOT EXISTS (
			SELECT 1 FROM test_links tl WHERE tl.source_symbol_stable_id = s.stable_id
		)
		${kindClause}
		ORDER BY f.path, s.line_start
		LIMIT ?`,
		...params,
	)
}

// hot-fragile = production files with high churn and many untested exported
// symbols. ranks by commits * untestedCount.
export function findHotFragile(
	store: AtlasStore,
	opts?: { limit?: number },
): HotFragileEntry[] {
	const limit = opts?.limit ?? 20
	return store.queryRawWithParams<HotFragileEntry>(
		`SELECT f.path as filePath,
		        c.commits as commits,
		        COUNT(s.id) as symbolCount,
		        SUM(CASE WHEN tl.source_symbol_stable_id IS NULL THEN 1 ELSE 0 END) as untestedCount,
		        ss.name as subsystem
		 FROM files f
		 JOIN (
		   SELECT file_path, COUNT(DISTINCT commit_hash) as commits
		   FROM file_changes
		   GROUP BY file_path
		 ) c ON c.file_path = f.path
		 LEFT JOIN symbols s ON s.file_id = f.id AND s.is_exported = 1
		 LEFT JOIN test_links tl ON tl.source_symbol_stable_id = s.stable_id
		 LEFT JOIN subsystems ss ON ss.id = f.subsystem_id
		 WHERE f.is_test = 0
		 GROUP BY f.id
		 HAVING untestedCount > 0
		 ORDER BY commits * untestedCount DESC, commits DESC
		 LIMIT ?`,
		limit,
	)
}
