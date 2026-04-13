import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'
import { applyMailmap, loadMailmap } from './mailmap.js'

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
const HASH_RE = /^[0-9a-f]{40}$/i

// drop every git-derived row from the store. used by --full and by the
// divergence-recovery path so both fully reset rather than leaving
// co_change_pairs out of sync.
export function clearGitHistory(store: AtlasStore): void {
	store.bulkInsert(() => {
		store.runRaw('DELETE FROM co_change_pairs')
		store.runRaw('DELETE FROM file_changes')
		store.runRaw('DELETE FROM commits')
		store.setMeta('git_history_last_commit', '')
	})
}

// not all repos are git repos, and shallow clones may not have full history.
// callers should treat any failure as non-fatal.
//
// when relevantPaths is provided, file_changes are filtered: a row is kept
// if either the new path (filePath) or the rename source (renameFrom) is
// in the set. this preserves the rename event for files renamed out of
// scope while still dropping noise that never overlapped the project. pass
// undefined to ingest every file (e.g. for an empty discovered set).
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

	// the watermark is operator-trusted only as far as the local sqlite file
	// is trusted. if it isn't a 40-char hex SHA we discard it instead of
	// passing arbitrary strings to git as positional arguments.
	const rawStored = store.getMeta('git_history_last_commit')
	const storedHash = rawStored && HASH_RE.test(rawStored) ? rawStored : null
	if (rawStored && !storedHash) {
		log.warn(`stored git_history_last_commit is not a valid SHA, discarding: ${rawStored}`)
	}

	let since: string | null = storedHash
	if (storedHash) {
		if (storedHash === head) {
			return { commitsAdded: 0, fileChangesAdded: 0, skipped: true, reason: 'up to date' }
		}
		// distinguish "stored hash is not an ancestor of HEAD" (force-push or
		// rebase) from "merge-base failed for some other reason" (transient
		// git error, missing object). only the first case should wipe state.
		const ancestorRes = Bun.spawnSync(
			['git', 'merge-base', '--is-ancestor', storedHash, 'HEAD'],
			{ cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' },
		)
		if (ancestorRes.exitCode === 1) {
			log.info('git history diverged from watermark (force-push or rebase), full re-ingest')
			clearGitHistory(store)
			since = null
		} else if (ancestorRes.exitCode !== 0) {
			const stderr = ancestorRes.stderr.toString().trim()
			log.warn(`git merge-base failed (exit ${ancestorRes.exitCode}): ${stderr || 'no stderr'}`)
			return { commitsAdded: 0, fileChangesAdded: 0, skipped: true, reason: 'merge-base failed' }
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
	const filterActive = relevantPaths !== undefined && relevantPaths.size > 0
	// read .mailmap once so every commit inserted below gets canonicalised.
	// absent or unreadable file returns null and applyMailmap falls through.
	const mailmap = loadMailmap(projectRoot)

	store.bulkInsert(() => {
		for (const c of commits) {
			// keep a file change row when either the new path (filePath) or
			// the rename source (renameFrom) is in scope. this preserves the
			// rename-out event for files that exited the project, plus the
			// rename-in event for files that joined it.
			const relevantFiles = filterActive
				? c.files.filter(
						(fc) =>
							relevantPaths!.has(fc.filePath) ||
							(fc.renameFrom !== null && relevantPaths!.has(fc.renameFrom)),
					)
				: c.files
			if (filterActive && relevantFiles.length === 0) continue

			const canonical = applyMailmap(mailmap, c.authorName, c.authorEmail)
			store.runRaw(
				'INSERT OR IGNORE INTO commits (hash, author_name, author_email, authored_at, subject) VALUES (?, ?, ?, ?, ?)',
				c.hash,
				canonical.name,
				canonical.email,
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
		log.warn(`co_change_pairs refresh failed: ${e instanceof Error ? e.message : e}`)
	}

	return {
		commitsAdded: commitCount,
		fileChangesAdded: fileChangeCount,
		skipped: false,
	}
}

// recompute co_change_pairs from scratch. wraps DELETE+INSERT in a single
// transaction so a failed insert doesn't leave the table empty. uses a CTE
// for per-file commit counts to avoid the O(pairs * file_changes) cost of
// correlated subqueries.
function refreshCoChangePairs(store: AtlasStore): void {
	store.bulkInsert(() => {
		store.runRaw('DELETE FROM co_change_pairs')
		store.runRaw(`
			INSERT INTO co_change_pairs (file_a, file_b, count, jaccard)
			WITH commit_counts AS (
				SELECT file_path, COUNT(DISTINCT commit_hash) AS cnt
				FROM file_changes
				GROUP BY file_path
			)
			SELECT
				a.file_path AS file_a,
				b.file_path AS file_b,
				COUNT(*) AS count,
				CAST(COUNT(*) AS REAL) / (ca.cnt + cb.cnt - COUNT(*)) AS jaccard
			FROM file_changes a
			JOIN file_changes b ON a.commit_hash = b.commit_hash AND a.file_path < b.file_path
			JOIN commit_counts ca ON ca.file_path = a.file_path
			JOIN commit_counts cb ON cb.file_path = b.file_path
			GROUP BY a.file_path, b.file_path
			HAVING count >= 2
		`)
	})
}

// parse output of: git log --pretty=format:'@@ATLASCOMMIT@@<H>\t<an>\t<ae>\t<at>\t<s>' --name-status -z
// the -z flag separates records with NUL bytes. each commit is one record
// containing the marker line followed by tab-separated file change lines.
// the parser validates that the chunk's hash field is a 40-char hex string,
// which guards against COMMIT_MARKER collisions when a commit subject
// happens to contain the literal marker.
export function parseGitLog(raw: string): ParsedCommit[] {
	const commits: ParsedCommit[] = []
	const chunks = raw.split(COMMIT_MARKER).filter((c) => c.length > 0)

	for (const rawChunk of chunks) {
		// strip trailing NULs that git uses to separate commits in -z mode.
		// merge commits emit no --name-status by default, so the chunk for
		// such commits is just the header line followed by a NUL terminator.
		const chunk = rawChunk.replace(/\0+$/, '')
		const newlineIdx = chunk.indexOf('\n')
		const headerLine = newlineIdx === -1 ? chunk : chunk.slice(0, newlineIdx)
		const body = newlineIdx === -1 ? '' : chunk.slice(newlineIdx + 1)

		const headerParts = headerLine.split('\t')
		if (headerParts.length < 5) continue
		const [hash, authorName, authorEmail, authoredAtStr, ...subjectParts] = headerParts
		const subject = subjectParts.join('\t')
		const authoredAt = Number(authoredAtStr)
		// hash MUST be a 40-char hex SHA. anything else means we split on a
		// false marker boundary and the chunk is junk.
		if (!HASH_RE.test(hash) || Number.isNaN(authoredAt)) continue

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
		// status token format: 'A' | 'M' | 'D' | 'R<score>' | 'C<score>'
		// optionally followed by a tab + path on the same token (when not
		// using -z) or as separate tokens (with -z). handle both shapes.
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
		// renames and copies both have a two-path operand shape (old → new).
		// we record copies as 'A' on the new path with renameFrom set so
		// downstream churn/contributors queries see the destination as a
		// new file but can still trace back to the source.
		if (statusChar === 'R' || statusChar === 'C') {
			const oldPath = inlinePath ?? tokens[++i]
			const newPath = tokens[++i]
			if (oldPath && newPath) {
				out.push({
					status: statusChar === 'R' ? 'R' : 'A',
					filePath: newPath,
					renameFrom: oldPath,
				})
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
		// any other status (T type-change, U unmerged, X unknown): skip
		// the operand if it's not inlined and advance.
		if (inlinePath === null) i++
		i++
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
		if (result.exitCode !== 0) {
			const stderr = result.stderr.toString().trim()
			if (stderr) log.debug(`git ${args[0]} exit ${result.exitCode}: ${stderr}`)
			return null
		}
		return result.stdout.toString().trim()
	} catch (e) {
		log.debug(`git ${args[0]} spawn error: ${e instanceof Error ? e.message : e}`)
		return null
	}
}
