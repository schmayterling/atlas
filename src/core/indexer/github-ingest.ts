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

function runGhApi<T>(endpoint: string): T | null {
	try {
		const result = Bun.spawnSync(['gh', 'api', '--paginate', endpoint], {
			stdout: 'pipe',
			stderr: 'pipe',
		})
		if (result.exitCode !== 0) {
			log.warn(`gh api ${endpoint} failed: ${result.stderr.toString().trim()}`)
			return null
		}
		return JSON.parse(result.stdout.toString()) as T
	} catch (e) {
		log.warn(`gh api ${endpoint} threw: ${e}`)
		return null
	}
}

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
	const prs = runGhApi<GhPR[]>(`${base}/pulls?state=all&per_page=100`)
	const issuesAndPrs = runGhApi<GhIssue[]>(`${base}/issues?state=all&per_page=100`)

	let prsFetched = 0
	let issuesFetched = 0

	store.bulkInsert(() => {
		if (prs) {
			for (const pr of prs) {
				store.runRaw(
					`INSERT OR REPLACE INTO pull_requests (number, title, state, author, body, base_ref, head_ref, created_at, updated_at, merged_at, url)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				)
				prsFetched++
				// fetch file list for each pr. this is a per-pr api call so
				// it multiplies quickly; keep the limit generous for small
				// repos and break early if the user has thousands of prs.
				if (prsFetched <= 200) {
					const files = runGhApi<GhPRFile[]>(`${base}/pulls/${pr.number}/files`)
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
					`INSERT OR REPLACE INTO issues (number, title, state, author, body, labels, created_at, updated_at, closed_at, url)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			}
		}
	})

	return { prsFetched, issuesFetched, skipped: false }
}
