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

// ranks exported functions/methods by fanin × commits × (1 - coverage).
// answers: "what symbols would be most expensive to break?"
//
// coverage tiering: 'called' test_links beat 'imported' test_links beat
// nothing. the score formula keeps uncovered symbols ahead of covered
// ones with the same fanin/churn, so the CLI surface reads as a risk
// ladder.
//
// excludes symbols from test files (is_test = 1) so hotspot output
// describes production code, not scaffolding.
export function findHotspots(
	store: AtlasStore,
	opts?: { limit?: number; coverage?: 'called' | 'imported' | 'none' },
): HotspotEntry[] {
	const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 500)

	// tiered join: tl_called first (strongest signal), tl_imported fallback
	const rows = store.queryRaw<{
		stableId: string
		name: string
		qualifiedName: string
		kind: string
		filePath: string
		lineStart: number
		fanin: number
		commits: number | null
		coverage: 'called' | 'imported' | 'none'
	}>(`
		SELECT
			s.stable_id as stableId,
			s.name,
			s.qualified_name as qualifiedName,
			s.kind,
			f.path as filePath,
			s.line_start as lineStart,
			COUNT(DISTINCT e.source_id) as fanin,
			(SELECT COUNT(DISTINCT fc.commit_hash)
			 FROM file_changes fc
			 WHERE fc.file_path = f.path) as commits,
			CASE
				WHEN EXISTS (
					SELECT 1 FROM test_links tl_c
					WHERE tl_c.source_symbol_stable_id = s.stable_id AND tl_c.confidence = 'called'
				) THEN 'called'
				WHEN EXISTS (
					SELECT 1 FROM test_links tl_i
					WHERE tl_i.source_symbol_stable_id = s.stable_id AND tl_i.confidence = 'imported'
				) THEN 'imported'
				ELSE 'none'
			END as coverage
		FROM symbols s
		JOIN files f ON f.id = s.file_id
		LEFT JOIN edges e ON e.target_id = s.stable_id AND e.kind = 'calls'
		WHERE s.is_exported = 1
		  AND f.is_test = 0
		  AND s.kind IN ('function', 'method')
		GROUP BY s.stable_id
		HAVING COUNT(DISTINCT e.source_id) > 0
		ORDER BY COUNT(DISTINCT e.source_id) DESC
	`)

	const scored: HotspotEntry[] = rows.map((r) => {
		const commits = r.commits ?? 0
		const coverageMultiplier =
			r.coverage === 'called' ? 0.2 : r.coverage === 'imported' ? 0.6 : 1
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
			score: r.fanin * Math.max(1, commits) * coverageMultiplier,
		}
	})

	const filtered = opts?.coverage
		? scored.filter((s) => s.coverage === opts.coverage)
		: scored

	return filtered.sort((a, b) => b.score - a.score).slice(0, limit)
}
