import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'

export interface GitIngestResult {
	commitsAdded: number
	fileChangesAdded: number
	skipped: boolean
	reason?: string
}

interface ParsedCommit {
	hash: string
	authorName: string
	authorEmail: string
	authoredAt: number
	subject: string
	files: ParsedFileChange[]
}

interface ParsedFileChange {
	status: 'A' | 'M' | 'D' | 'R'
	filePath: string
	renameFrom: string | null
}

const COMMIT_MARKER = '@@ATLASCOMMIT@@'

// not all repos are git repos, and shallow clones may not have full history.
// callers should treat any failure as non-fatal.
//
// when relevantPaths is provided, file_changes rows whose file_path is not
// in the set are skipped. this filters out noise from files that were once
// committed and later gitignored (e.g. agent debug artifacts) and from
// files outside the atlas include glob. when omitted, every git-tracked
// file is ingested.
export function ingestGitHistory(
	projectRoot: string,
	store: AtlasStore,
	relevantPaths?: Set<string>,
): GitIngestResult {
	if (!isGitRepo(projectRoot)) {
		return { commitsAdded: 0, fileChangesAdded: 0, skipped: true, reason: 'not a git repo' }
	}

	const head = runGit(projectRoot, ['rev-parse', 'HEAD'])
	if (!head) {
		return { commitsAdded: 0, fileChangesAdded: 0, skipped: true, reason: 'no HEAD' }
	}

	// detect force-push or rebase: if the stored watermark hash isn't an
	// ancestor of HEAD, history was rewritten and our cached rows are stale.
	// `cat-file -e` is insufficient because dangling objects remain in the
	// database after `git reset --hard`.
	const storedHash = store.getMeta('git_history_last_commit')
	let since: string | null = storedHash
	if (storedHash) {
		if (storedHash === head) {
			return { commitsAdded: 0, fileChangesAdded: 0, skipped: true, reason: 'up to date' }
		}
		const isAncestor = Bun.spawnSync(
			['git', 'merge-base', '--is-ancestor', storedHash, 'HEAD'],
			{ cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
		).exitCode === 0
		if (!isAncestor) {
			log.info('git history diverged from watermark (force-push or rebase), full re-ingest')
			store.runRaw('DELETE FROM file_changes')
			store.runRaw('DELETE FROM commits')
			since = null
		}
	}

	const range = since ? [`${since}..HEAD`] : []
	const log_args = [
		'log',
		`--pretty=format:${COMMIT_MARKER}%H%x09%an%x09%ae%x09%at%x09%s`,
		'--name-status',
		'-z',
		...range,
	]
	const raw = runGit(projectRoot, log_args)
	if (raw === null) {
		return { commitsAdded: 0, fileChangesAdded: 0, skipped: true, reason: 'git log failed' }
	}
	if (raw === '') {
		store.setMeta('git_history_last_commit', head)
		return { commitsAdded: 0, fileChangesAdded: 0, skipped: true, reason: 'no new commits' }
	}

	const commits = parseGitLog(raw)
	if (commits.length === 0) {
		store.setMeta('git_history_last_commit', head)
		return { commitsAdded: 0, fileChangesAdded: 0, skipped: true, reason: 'parse produced 0' }
	}

	let commitCount = 0
	let fileChangeCount = 0

	store.bulkInsert(() => {
		for (const c of commits) {
			// pre-filter file changes against the relevant set so we don't
			// insert commits whose only changed files are noise
			const relevantFiles = relevantPaths
				? c.files.filter((fc) => relevantPaths.has(fc.filePath))
				: c.files
			if (relevantFiles.length === 0 && relevantPaths) continue

			store.runRaw(
				'INSERT OR IGNORE INTO commits (hash, author_name, author_email, authored_at, subject) VALUES (?, ?, ?, ?, ?)',
				c.hash,
				c.authorName,
				c.authorEmail,
				c.authoredAt,
				c.subject,
			)
			commitCount++
			for (const fc of relevantFiles) {
				store.runRaw(
					'INSERT INTO file_changes (commit_hash, file_path, status, rename_from) VALUES (?, ?, ?, ?)',
					c.hash,
					fc.filePath,
					fc.status,
					fc.renameFrom,
				)
				fileChangeCount++
			}
		}
	})

	store.setMeta('git_history_last_commit', head)

	// refresh co_change_pairs from the new file_changes state. cheap on
	// repos with < 10k commits; the only mechanism that scales beyond
	// on-demand pairwise self-joins.
	try {
		refreshCoChangePairs(store)
	} catch (e) {
		log.warn(`co_change_pairs refresh failed: ${e}`)
	}

	return {
		commitsAdded: commitCount,
		fileChangesAdded: fileChangeCount,
		skipped: false,
	}
}

// recompute co_change_pairs from scratch. uses a single SQL aggregation
// against file_changes; ordering enforces file_a < file_b so each pair
// appears once.
function refreshCoChangePairs(store: AtlasStore): void {
	store.runRaw('DELETE FROM co_change_pairs')
	store.runRaw(`
		INSERT INTO co_change_pairs (file_a, file_b, count, jaccard)
		SELECT
			a.file_path AS file_a,
			b.file_path AS file_b,
			COUNT(*) AS count,
			CAST(COUNT(*) AS REAL) / (
				(SELECT COUNT(DISTINCT commit_hash) FROM file_changes WHERE file_path = a.file_path)
				+ (SELECT COUNT(DISTINCT commit_hash) FROM file_changes WHERE file_path = b.file_path)
				- COUNT(*)
			) AS jaccard
		FROM file_changes a
		JOIN file_changes b ON a.commit_hash = b.commit_hash AND a.file_path < b.file_path
		GROUP BY a.file_path, b.file_path
		HAVING count >= 2
	`)
}

// parse output of: git log --pretty=format:'@@ATLASCOMMIT@@<H>\t<an>\t<ae>\t<at>\t<s>' --name-status -z
// the -z flag separates records with NUL bytes. each commit is one record
// containing the marker line followed by tab-separated file change lines.
export function parseGitLog(raw: string): ParsedCommit[] {
	const commits: ParsedCommit[] = []
	// with -z, git separates COMMITS with NUL but uses NUL within --name-status
	// records too. the safer split is on the marker prefix; commits start with
	// the marker and the rest of the buffer until the next marker is the body.
	const chunks = raw.split(COMMIT_MARKER).filter((c) => c.length > 0)

	for (const rawChunk of chunks) {
		// strip trailing NULs that git uses to separate commits in -z mode.
		// merge commits emit no --name-status by default, so the chunk for
		// such commits is just the header line followed by a NUL terminator.
		const chunk = rawChunk.replace(/\0+$/, '')
		// chunk format: <hash>\t<an>\t<ae>\t<at>\t<subject>\n<file changes...>
		// file changes use NUL as separator (-z) and \t between status and path.
		// rename: 'R<score>\told\tnew' (3 NUL-separated fields).
		const newlineIdx = chunk.indexOf('\n')
		const headerLine = newlineIdx === -1 ? chunk : chunk.slice(0, newlineIdx)
		const body = newlineIdx === -1 ? '' : chunk.slice(newlineIdx + 1)

		const headerParts = headerLine.split('\t')
		if (headerParts.length < 5) continue
		const [hash, authorName, authorEmail, authoredAtStr, ...subjectParts] = headerParts
		const subject = subjectParts.join('\t')
		const authoredAt = Number(authoredAtStr)
		if (!hash || Number.isNaN(authoredAt)) continue

		const files = parseFileChanges(body)
		commits.push({
			hash,
			authorName,
			authorEmail,
			authoredAt: authoredAt * 1000, // git outputs seconds; store ms
			subject,
			files,
		})
	}

	return commits
}

function parseFileChanges(body: string): ParsedFileChange[] {
	const out: ParsedFileChange[] = []
	if (!body) return out
	// strip leading NUL if present (between header line and first file)
	const trimmed = body.replace(/^\0+/, '').replace(/\0+$/, '')
	if (!trimmed) return out

	const tokens = trimmed.split('\0').filter((t) => t.length > 0)
	let i = 0
	while (i < tokens.length) {
		const tok = tokens[i]
		// status token format: 'A' | 'M' | 'D' | 'R<score>' optionally followed
		// by a tab + path on the same token (when not using -z) or as separate
		// tokens (with -z). handle both shapes defensively.
		const tabIdx = tok.indexOf('\t')
		let statusRaw: string
		let inlinePath: string | null = null
		if (tabIdx !== -1) {
			statusRaw = tok.slice(0, tabIdx)
			inlinePath = tok.slice(tabIdx + 1)
		} else {
			statusRaw = tok
		}

		const statusChar = statusRaw[0]
		if (statusChar === 'R') {
			// rename: status, old, new (three tokens, or status + inline old, then new)
			const oldPath = inlinePath ?? tokens[++i]
			const newPath = tokens[++i]
			if (oldPath && newPath) {
				out.push({ status: 'R', filePath: newPath, renameFrom: oldPath })
			}
			i++
			continue
		}
		if (statusChar === 'A' || statusChar === 'M' || statusChar === 'D') {
			const path = inlinePath ?? tokens[++i]
			if (path) {
				out.push({ status: statusChar, filePath: path, renameFrom: null })
			}
			i++
			continue
		}
		// unknown status (e.g. 'C' for copy), skip its operands
		i++
		if (inlinePath === null) i++
	}
	return out
}

function isGitRepo(projectRoot: string): boolean {
	const out = runGit(projectRoot, ['rev-parse', '--is-inside-work-tree'])
	return out === 'true'
}

function runGit(projectRoot: string, args: string[]): string | null {
	try {
		const result = Bun.spawnSync(['git', ...args], {
			cwd: projectRoot,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		if (result.exitCode !== 0) return null
		return result.stdout.toString().replace(/\n$/, '')
	} catch {
		return null
	}
}
