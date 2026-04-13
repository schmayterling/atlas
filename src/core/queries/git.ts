import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'

// per-invocation cache for branch commit sets. the key is
// `${projectRoot}::${branch}`; resolves to a Set<hash>. caches live
// for the lifetime of one CLI invocation via the module singleton —
// branches move in real repos, so persisting across runs is wrong.
const branchCommitCache = new Map<string, Set<string>>()

export function clearBranchCommitCache(): void {
	branchCommitCache.clear()
}

// returns the set of commit hashes reachable from <branch> along the
// first-parent chain. follows the git log surface used by most
// review-ready branch workflows. returns null when the branch doesn't
// exist or git fails, so callers can either skip the filter or
// surface a clean error.
//
// security: the branch name flows in from user input (--branch on the
// cli). before passing it to git log we validate it with
// `git check-ref-format --branch` — this rejects dash-prefixed values
// like `--exec=…` that git would otherwise parse as a flag. we still
// use `--end-of-options` when invoking git log for defense in depth.
export function getBranchCommits(
	projectRoot: string,
	branch: string,
): Set<string> | null {
	const key = `${projectRoot}::${branch}`
	const cached = branchCommitCache.get(key)
	if (cached) return cached

	// check-ref-format enforces the git ref name rules (no leading
	// dash, no spaces, no ..) so a malicious branch name can't become
	// a git flag. it succeeds silently on valid names.
	try {
		const check = Bun.spawnSync(
			['git', 'check-ref-format', '--branch', branch],
			{ cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
		)
		if (check.exitCode !== 0) {
			log.warn(`invalid branch name: ${branch}`)
			return null
		}
	} catch (e) {
		log.warn(`branch validation failed: ${e}`)
		return null
	}

	try {
		const result = Bun.spawnSync(
			['git', 'log', '--first-parent', '--format=%H', '--end-of-options', branch],
			{ cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
		)
		if (result.exitCode !== 0) {
			log.warn(
				`git log --first-parent ${branch} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
			)
			return null
		}
		const set = new Set<string>(
			result.stdout
				.toString()
				.split('\n')
				.map((s) => s.trim())
				.filter((s) => s.length === 40),
		)
		branchCommitCache.set(key, set)
		return set
	} catch (e) {
		log.warn(`branch commit lookup failed: ${e}`)
		return null
	}
}

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
	// narrow counting to commits reachable along the first-parent chain
	// of the given branch. paired with projectRoot because the branch
	// lookup needs to shell out to git for the commit set.
	branch?: string
	projectRoot?: string
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
	if (opts.branch && opts.projectRoot) {
		const commits = getBranchCommits(opts.projectRoot, opts.branch)
		if (commits === null) {
			throw new Error(`branch "${opts.branch}" not found in this repo`)
		}
		if (commits.size === 0) {
			return []
		}
		const placeholders = Array.from(commits, () => '?').join(',')
		where += ` AND c.hash IN (${placeholders})`
		for (const h of commits) params.push(h)
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

export function fileHistory(
	store: AtlasStore,
	filePath: string,
	opts?: { branch?: string; projectRoot?: string },
): FileHistoryEntry[] {
	if (opts?.branch && opts.projectRoot) {
		const commits = getBranchCommits(opts.projectRoot, opts.branch)
		if (commits === null) {
			throw new Error(`branch "${opts.branch}" not found in this repo`)
		}
		if (commits.size === 0) return []
		const placeholders = Array.from(commits, () => '?').join(',')
		const params: string[] = [filePath, ...commits]
		return store.queryRawWithParams<FileHistoryEntry>(
			`SELECT c.hash, c.author_name as authorName, c.author_email as authorEmail,
			        c.authored_at as authoredAt, c.subject,
			        fc.status, fc.rename_from as renameFrom
			 FROM file_changes fc
			 JOIN commits c ON c.hash = fc.commit_hash
			 WHERE fc.file_path = ? AND c.hash IN (${placeholders})
			 ORDER BY c.authored_at DESC`,
			...params,
		)
	}
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
