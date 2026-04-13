import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'

// github pr + issue ingest. opt-in via the `--with-github` flag on
// `atlas index`. runs only when `gh` is installed and the project
// is a github-hosted repo. incremental via updated_at watermark in
// atlas_meta so re-runs fetch only deltas.

interface GitHubRemote {
	owner: string
	repo: string
}

export interface GitHubIngestResult {
	prsFetched: number
	issuesFetched: number
	skipped: boolean
	reason?: string
}

interface GhPR {
	number: number
	title: string
	state: string
	user: { login: string } | null
	body: string | null
	base: { ref: string } | null
	head: { ref: string } | null
	created_at: string
	updated_at: string
	merged_at: string | null
	html_url: string
}

interface GhIssue {
	number: number
	title: string
	state: string
	user: { login: string } | null
	body: string | null
	labels: Array<{ name: string } | string>
	created_at: string
	updated_at: string
	closed_at: string | null
	html_url: string
	pull_request?: unknown // github returns prs inside /issues; skip those
}

interface GhPRFile {
	filename: string
	additions: number
	deletions: number
}

function detectRemote(projectRoot: string): GitHubRemote | null {
	try {
		const result = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], {
			cwd: projectRoot,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		if (result.exitCode !== 0) return null
		const url = result.stdout.toString().trim()
		// https://github.com/owner/repo(.git)?
		const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/)
		if (httpsMatch) {
			return { owner: httpsMatch[1], repo: httpsMatch[2] }
		}
		return null
	} catch {
		return null
	}
}

function isGhAvailable(): boolean {
	try {
		const result = Bun.spawnSync(['gh', '--version'], { stdout: 'pipe', stderr: 'pipe' })
		return result.exitCode === 0
	} catch {
		return false
	}
}

// `gh api --paginate` prints each page as a separate JSON document
// concatenated in stdout. feeding that to JSON.parse throws on the
// second `[`, which silently loses all rows past page 1. `--slurp`
// wraps all pages into a single outer array; we then flatten it so
// callers still receive a flat T[] response. same fix covers issues,
// prs, and /pulls/<n>/files.
function runGhApi<T>(endpoint: string): T | null {
	try {
		const result = Bun.spawnSync(['gh', 'api', '--paginate', '--slurp', endpoint], {
			stdout: 'pipe',
			stderr: 'pipe',
		})
		if (result.exitCode !== 0) {
			log.warn(`gh api ${endpoint} failed: ${result.stderr.toString().trim()}`)
			return null
		}
		const raw = JSON.parse(result.stdout.toString())
		// --slurp always returns an outer array of pages. if every page
		// is itself an array (the common list-endpoint case), flatten.
		// non-array pages stay wrapped so object endpoints still work.
		if (Array.isArray(raw) && raw.every((page) => Array.isArray(page))) {
			return raw.flat() as T
		}
		return raw as T
	} catch (e) {
		log.warn(`gh api ${endpoint} threw: ${e}`)
		return null
	}
}

// per-run cap on how many PRs we fetch file lists for. prevents a
// multi-thousand-PR repo from stalling under a per-PR api call per
// `pr_files` fetch. all PRs past the cap skip `pr_files` but still
// land in `pull_requests` with `files_complete=0` so consumers can
// tell "no files" from "skipped".
const PR_FILES_FETCH_CAP = 200

// watermark meta keys. read at the start of an ingest to filter the
// api call client-side (github's issues endpoint supports `since=`;
// the pulls endpoint does not, so we filter in js).
const META_PR_WATERMARK = 'github_prs_updated_after'
const META_ISSUES_WATERMARK = 'github_issues_updated_after'

export function ingestGitHub(projectRoot: string, store: AtlasStore): GitHubIngestResult {
	if (!isGhAvailable()) {
		return {
			prsFetched: 0,
			issuesFetched: 0,
			skipped: true,
			reason: 'gh cli not installed',
		}
	}

	const remote = detectRemote(projectRoot)
	if (!remote) {
		return {
			prsFetched: 0,
			issuesFetched: 0,
			skipped: true,
			reason: 'not a github repo',
		}
	}

	const base = `repos/${remote.owner}/${remote.repo}`

	// incremental watermarks. `since=` works for /issues natively; for
	// /pulls the api has no since filter, so we sort by updated-desc and
	// break out once we reach a pr older than the watermark.
	const prWatermark = parseWatermark(store.getMeta(META_PR_WATERMARK))
	const issueWatermark = store.getMeta(META_ISSUES_WATERMARK)

	// network fetches FIRST, before any transaction is opened. this
	// stops the sqlite write lock from being held across per-PR http
	// round trips.
	const rawPrs = runGhApi<GhPR[]>(
		`${base}/pulls?state=all&per_page=100&sort=updated&direction=desc`,
	)
	const prs =
		rawPrs && prWatermark
			? rawPrs.filter((pr) => new Date(pr.updated_at).getTime() > prWatermark)
			: rawPrs

	const issuesEndpoint = issueWatermark
		? `${base}/issues?state=all&per_page=100&since=${encodeURIComponent(issueWatermark)}`
		: `${base}/issues?state=all&per_page=100`
	const issuesAndPrs = runGhApi<GhIssue[]>(issuesEndpoint)

	// per-PR files: fetch up to PR_FILES_FETCH_CAP prs in a flat loop
	// so the write transaction stays off the network's critical path.
	// anything past the cap leaves files_complete=0.
	const prFileMap = new Map<number, GhPRFile[]>()
	if (prs) {
		let fetched = 0
		for (const pr of prs) {
			if (fetched >= PR_FILES_FETCH_CAP) break
			const files = runGhApi<GhPRFile[]>(`${base}/pulls/${pr.number}/files`)
			if (files) prFileMap.set(pr.number, files)
			fetched++
		}
	}

	let prsFetched = 0
	let issuesFetched = 0
	let maxPrUpdatedAt = prWatermark ?? 0
	let maxIssueUpdatedAt = 0

	store.bulkInsert(() => {
		if (prs) {
			for (const pr of prs) {
				// INSERT ... ON CONFLICT DO UPDATE instead of OR REPLACE:
				// OR REPLACE deletes the conflicting row first, which
				// cascades pr_files ON DELETE CASCADE and wipes the file
				// list. DO UPDATE leaves related rows intact.
				store.runRaw(
					`INSERT INTO pull_requests (number, title, state, author, body, base_ref, head_ref, created_at, updated_at, merged_at, url, files_complete)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(number) DO UPDATE SET
					   title = excluded.title,
					   state = excluded.state,
					   author = excluded.author,
					   body = excluded.body,
					   base_ref = excluded.base_ref,
					   head_ref = excluded.head_ref,
					   updated_at = excluded.updated_at,
					   merged_at = excluded.merged_at,
					   url = excluded.url,
					   files_complete = excluded.files_complete`,
					pr.number,
					pr.title,
					pr.merged_at ? 'merged' : pr.state,
					pr.user?.login ?? 'unknown',
					pr.body,
					pr.base?.ref ?? null,
					pr.head?.ref ?? null,
					new Date(pr.created_at).getTime(),
					new Date(pr.updated_at).getTime(),
					pr.merged_at ? new Date(pr.merged_at).getTime() : null,
					pr.html_url,
					prFileMap.has(pr.number) ? 1 : 0,
				)
				prsFetched++
				const t = new Date(pr.updated_at).getTime()
				if (t > maxPrUpdatedAt) maxPrUpdatedAt = t

				// refresh pr_files only when we actually fetched them
				// this run. not fetching != empty list.
				const files = prFileMap.get(pr.number)
				if (files) {
					store.runRaw('DELETE FROM pr_files WHERE pr_number = ?', pr.number)
					for (const f of files) {
						store.runRaw(
							`INSERT INTO pr_files (pr_number, file_path, additions, deletions) VALUES (?, ?, ?, ?)`,
							pr.number,
							f.filename,
							f.additions,
							f.deletions,
						)
					}
				}
			}
		}

		if (issuesAndPrs) {
			for (const item of issuesAndPrs) {
				// the /issues endpoint returns prs too; skip anything that
				// looks like a pr so we don't double-store them.
				if (item.pull_request) continue
				const labelNames = item.labels
					.map((l) => (typeof l === 'string' ? l : l.name))
					.filter((n): n is string => typeof n === 'string')
				store.runRaw(
					`INSERT INTO issues (number, title, state, author, body, labels, created_at, updated_at, closed_at, url)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(number) DO UPDATE SET
					   title = excluded.title,
					   state = excluded.state,
					   author = excluded.author,
					   body = excluded.body,
					   labels = excluded.labels,
					   updated_at = excluded.updated_at,
					   closed_at = excluded.closed_at,
					   url = excluded.url`,
					item.number,
					item.title,
					item.state,
					item.user?.login ?? 'unknown',
					item.body,
					JSON.stringify(labelNames),
					new Date(item.created_at).getTime(),
					new Date(item.updated_at).getTime(),
					item.closed_at ? new Date(item.closed_at).getTime() : null,
					item.html_url,
				)
				issuesFetched++
				const t = new Date(item.updated_at).getTime()
				if (t > maxIssueUpdatedAt) maxIssueUpdatedAt = t
			}
		}

		if (maxPrUpdatedAt > 0) store.setMeta(META_PR_WATERMARK, String(maxPrUpdatedAt))
		if (maxIssueUpdatedAt > 0) {
			store.setMeta(META_ISSUES_WATERMARK, new Date(maxIssueUpdatedAt).toISOString())
		}
	})

	return { prsFetched, issuesFetched, skipped: false }
}

function parseWatermark(raw: string | null): number | null {
	if (!raw) return null
	const n = Number.parseInt(raw, 10)
	return Number.isFinite(n) && n > 0 ? n : null
}
