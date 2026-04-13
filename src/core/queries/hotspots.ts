import type { AtlasStore } from '../storage/store.js'

export interface HotspotEntry {
	stableId: string
	name: string
	qualifiedName: string
	kind: string
	filePath: string
	lineStart: number
	fanin: number
	commits: number
	coverage: 'called' | 'imported' | 'none'
	score: number
}

// heuristic risk score for exported functions/methods. answers "what
// symbols would be most expensive to break?". symbols with more
// inbound calls, more churn, and weaker test coverage rank higher.
//
// score = fanin * commits * WEIGHT[coverage]
// WEIGHT.none = 1.0, WEIGHT.imported = 0.6, WEIGHT.called = 0.2
//
// symbols in files with zero git history count as zero-commit (not
// one) so an untested but never-touched symbol doesn't edge out a
// covered high-churn one.
//
// named "heuristic risk score" rather than "fanin × churn × (1 - coverage)"
// because the weight model isn't literally (1 - coverage): the three
// coverage buckets are discrete and the weights are opinionated.
//
// excludes symbols from test files (is_test = 1) so hotspot output
// describes production code, not scaffolding.
export const HOTSPOT_COVERAGE_WEIGHT = { none: 1.0, imported: 0.6, called: 0.2 } as const

interface HotspotRow {
	stableId: string
	name: string
	qualifiedName: string
	kind: string
	filePath: string
	lineStart: number
	fanin: number
	commits: number | null
	coverage: 'called' | 'imported' | 'none'
}

export function findHotspots(
	store: AtlasStore,
	opts?: {
		limit?: number
		coverage?: 'called' | 'imported' | 'none'
		excludeFileIds?: Set<number>
	},
): HotspotEntry[] {
	const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 500)

	// generated-file exclusion is inlined into the WHERE clause so
	// fake_*.go / mocks / counterfeiter output never dominates the
	// hotspot ranking. see #44.
	const excludeFilter =
		opts?.excludeFileIds && opts.excludeFileIds.size > 0
			? ` AND f.id NOT IN (${Array.from(opts.excludeFileIds).join(',')})`
			: ''

	// one scan of test_links + one scan of file_changes, both pre-
	// aggregated into temp CTEs so the main join is index-friendly.
	// previously the main query had two EXISTS subqueries per symbol
	// row plus a correlated COUNT(DISTINCT) for churn, which was O(n^2)
	// over exported callables on anything larger than the atlas fixture.
	const rows = store.queryRaw<HotspotRow>(`
		WITH coverage_per_symbol AS (
			SELECT
				source_symbol_stable_id as stable_id,
				MAX(CASE WHEN confidence = 'called' THEN 1 ELSE 0 END) as has_called,
				MAX(CASE WHEN confidence = 'imported' THEN 1 ELSE 0 END) as has_imported
			FROM test_links
			GROUP BY source_symbol_stable_id
		),
		commits_per_file AS (
			SELECT file_path, COUNT(DISTINCT commit_hash) as commits
			FROM file_changes
			GROUP BY file_path
		)
		SELECT
			s.stable_id as stableId,
			s.name,
			s.qualified_name as qualifiedName,
			s.kind,
			f.path as filePath,
			s.line_start as lineStart,
			COUNT(DISTINCT e.source_id) as fanin,
			COALESCE(cf.commits, 0) as commits,
			CASE
				WHEN cov.has_called = 1 THEN 'called'
				WHEN cov.has_imported = 1 THEN 'imported'
				ELSE 'none'
			END as coverage
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		LEFT JOIN edges e ON e.target_id = s.stable_id AND e.kind = 'calls'
		LEFT JOIN coverage_per_symbol cov ON cov.stable_id = s.stable_id
		LEFT JOIN commits_per_file cf ON cf.file_path = f.path
		WHERE s.is_exported = 1
		  AND f.is_test = 0${excludeFilter}
		  AND s.kind IN ('function', 'method')
		GROUP BY s.stable_id
		HAVING COUNT(DISTINCT e.source_id) > 0
	`)

	const scored: HotspotEntry[] = rows.map((r) => {
		const commits = r.commits ?? 0
		const weight = HOTSPOT_COVERAGE_WEIGHT[r.coverage]
		return {
			stableId: r.stableId,
			name: r.name,
			qualifiedName: r.qualifiedName,
			kind: r.kind,
			filePath: r.filePath,
			lineStart: r.lineStart,
			fanin: r.fanin,
			commits,
			coverage: r.coverage,
			// commits is NOT floored to 1: a never-touched symbol scores
			// zero on the churn axis, so covered high-churn symbols can
			// outrank untouched uncovered ones correctly.
			score: r.fanin * commits * weight,
		}
	})

	const filtered = opts?.coverage
		? scored.filter((s) => s.coverage === opts.coverage)
		: scored

	return filtered.sort((a, b) => b.score - a.score).slice(0, limit)
}
