import type { AtlasStore } from '../storage/store.js'

export interface CommitRecord {
	hash: string
	authorName: string
	authorEmail: string
	authoredAt: number
	subject: string
}

export interface ChurnEntry {
	filePath: string
	commits: number
	contributors: number
	lastTouchedAt: number
	topAuthor: string
}

export interface ContributorEntry {
	authorName: string
	authorEmail: string
	commits: number
}

export interface FileHistoryEntry extends CommitRecord {
	status: 'A' | 'M' | 'D' | 'R'
	renameFrom: string | null
}

export interface ChurnOpts {
	limit?: number
	pathPrefix?: string
	since?: number
	includeTests?: boolean
}

export function churn(store: AtlasStore, opts: ChurnOpts = {}): ChurnEntry[] {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
	const params: (string | number)[] = []
	let where = '1=1'
	if (opts.pathPrefix) {
		// escape LIKE metacharacters so a path containing % or _ does not
		// silently widen the match. mirrors the dead-code.ts pattern.
		const escapedPrefix = opts.pathPrefix.replace(/%/g, '\\%').replace(/_/g, '\\_')
		where += ` AND fc.file_path LIKE ? ESCAPE '\\'`
		params.push(`${escapedPrefix}%`)
	}
	if (opts.since) {
		where += ' AND c.authored_at >= ?'
		params.push(opts.since)
	}
	// LIST surface: hide test files unless opted in. left join keeps churn
	// rows for files that no longer exist on disk (deleted), but drops files
	// currently flagged as tests.
	if (!opts.includeTests) {
		where += ` AND NOT EXISTS (SELECT 1 FROM files cur WHERE cur.path = fc.file_path AND cur.is_test = 1)`
	}
	const sql = `
		SELECT fc.file_path as filePath,
		       COUNT(DISTINCT fc.commit_hash) as commits,
		       COUNT(DISTINCT c.author_email) as contributors,
		       MAX(c.authored_at) as lastTouchedAt,
		       (SELECT c2.author_name
		        FROM file_changes fc2
		        JOIN commits c2 ON c2.hash = fc2.commit_hash
		        WHERE fc2.file_path = fc.file_path
		        GROUP BY c2.author_email
		        ORDER BY COUNT(*) DESC LIMIT 1) as topAuthor
		FROM file_changes fc
		JOIN commits c ON c.hash = fc.commit_hash
		WHERE ${where}
		GROUP BY fc.file_path
		ORDER BY commits DESC, lastTouchedAt DESC
		LIMIT ?
	`
	params.push(limit)
	return store.queryRawWithParams<ChurnEntry>(sql, ...params)
}

export function fileHistory(store: AtlasStore, filePath: string): FileHistoryEntry[] {
	return store.queryRawWithParams<FileHistoryEntry>(
		`SELECT c.hash, c.author_name as authorName, c.author_email as authorEmail,
		        c.authored_at as authoredAt, c.subject,
		        fc.status, fc.rename_from as renameFrom
		 FROM file_changes fc
		 JOIN commits c ON c.hash = fc.commit_hash
		 WHERE fc.file_path = ?
		 ORDER BY c.authored_at DESC`,
		filePath,
	)
}

export function contributors(
	store: AtlasStore,
	filePath?: string,
): ContributorEntry[] {
	if (filePath) {
		return store.queryRawWithParams<ContributorEntry>(
			`SELECT c.author_name as authorName, c.author_email as authorEmail,
			        COUNT(*) as commits
			 FROM file_changes fc
			 JOIN commits c ON c.hash = fc.commit_hash
			 WHERE fc.file_path = ?
			 GROUP BY c.author_email
			 ORDER BY commits DESC`,
			filePath,
		)
	}
	return store.queryRaw<ContributorEntry>(
		`SELECT author_name as authorName, author_email as authorEmail, COUNT(*) as commits
		 FROM commits
		 GROUP BY author_email
		 ORDER BY commits DESC`,
	)
}

export interface CoChangePair {
	fileA: string
	fileB: string
	count: number
	jaccard: number
}

export function coChange(
	store: AtlasStore,
	opts?: { filePath?: string; minCount?: number; limit?: number; includeTests?: boolean },
): CoChangePair[] {
	const minCount = opts?.minCount ?? 2
	const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500)
	const testClause = opts?.includeTests
		? ''
		: `AND NOT EXISTS (SELECT 1 FROM files fa WHERE fa.path = file_a AND fa.is_test = 1)
		   AND NOT EXISTS (SELECT 1 FROM files fb WHERE fb.path = file_b AND fb.is_test = 1)`
	if (opts?.filePath) {
		return store.queryRawWithParams<CoChangePair>(
			`SELECT file_a as fileA, file_b as fileB, count, jaccard
			 FROM co_change_pairs
			 WHERE (file_a = ? OR file_b = ?) AND count >= ?
			 ${testClause}
			 ORDER BY jaccard DESC
			 LIMIT ?`,
			opts.filePath,
			opts.filePath,
			minCount,
			limit,
		)
	}
	return store.queryRawWithParams<CoChangePair>(
		`SELECT file_a as fileA, file_b as fileB, count, jaccard
		 FROM co_change_pairs
		 WHERE count >= ?
		 ${testClause}
		 ORDER BY jaccard DESC
		 LIMIT ?`,
		minCount,
		limit,
	)
}

export function lastChanged(store: AtlasStore, filePath: string): CommitRecord | null {
	const rows = store.queryRawWithParams<CommitRecord>(
		`SELECT c.hash, c.author_name as authorName, c.author_email as authorEmail,
		        c.authored_at as authoredAt, c.subject
		 FROM file_changes fc
		 JOIN commits c ON c.hash = fc.commit_hash
		 WHERE fc.file_path = ?
		 ORDER BY c.authored_at DESC LIMIT 1`,
		filePath,
	)
	return rows[0] ?? null
}
