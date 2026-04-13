import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'

// in-repo cross-language linker. scans api_endpoints for client/server
// pairs whose path patterns match (under simple normalisation) and
// writes one row per pair into cross_project_edges with both source
// and target project set to the sentinel 'local'. this lets `atlas
// trace /api/users` surface both the ts fetch site and the go handler
// even when both live in the same repo.
//
// federation over multiple registered projects (#8) will add rows with
// real project ids; both kinds of rows can coexist because the scope
// column distinguishes them via project id. the linker is idempotent:
// it clears its own 'local' rows before repopulating.

const LOCAL_SCOPE = 'local'

interface CrossLanguageLinkResult {
	edgesCreated: number
}

export function linkInRepoApiEndpoints(store: AtlasStore): CrossLanguageLinkResult {
	// wipe prior in-repo links before repopulating so renames and
	// deleted endpoints don't leave stale rows behind. federation
	// rows (project_id != 'local') are untouched.
	store.runRaw(
		`DELETE FROM cross_project_edges WHERE source_project = ? AND target_project = ?`,
		LOCAL_SCOPE,
		LOCAL_SCOPE,
	)

	const endpoints = store.findApiEndpoints()
	if (endpoints.length === 0) return { edgesCreated: 0 }

	// bucket by (role, normalised path) so the match step is O(n)
	// instead of O(n^2) over the cartesian product.
	type Bucket = typeof endpoints
	const clientsByPath = new Map<string, Bucket>()
	const serversByPath = new Map<string, Bucket>()

	for (const ep of endpoints) {
		const key = normalisePath(ep.pathPattern)
		const bucket = ep.role === 'client' ? clientsByPath : serversByPath
		const arr = bucket.get(key) ?? []
		arr.push(ep)
		bucket.set(key, arr)
	}

	let created = 0
	for (const [key, clients] of clientsByPath) {
		const servers = serversByPath.get(key)
		if (!servers || servers.length === 0) continue
		for (const client of clients) {
			for (const server of servers) {
				// respect http method when both sides declare one.
				if (
					client.httpMethod &&
					server.httpMethod &&
					client.httpMethod !== server.httpMethod
				) {
					continue
				}
				store.insertCrossProjectEdge({
					sourceProject: LOCAL_SCOPE,
					sourceStableId: client.symbolStableId,
					targetProject: LOCAL_SCOPE,
					targetStableId: server.symbolStableId,
					kind: 'calls',
				})
				created++
			}
		}
	}

	if (created > 0) log.info(`cross-language linker: ${created} api edges`)
	return { edgesCreated: created }
}

// normalise a route path so client and server conventions can match:
//   /api/users/:id   ↔   /api/users/{id}   ↔   /api/users/${id}
// also strip trailing slashes and lower-case.
function normalisePath(raw: string): string {
	let p = raw.trim().toLowerCase()
	// strip trailing slash except for the root
	if (p.length > 1) p = p.replace(/\/+$/, '')
	// :param → {param}
	p = p.replace(/:([a-z0-9_]+)/gi, '{param}')
	// ${param} → {param}
	p = p.replace(/\$\{[^}]+\}/g, '{param}')
	// {param} → {param} (no-op but normalises the rest)
	p = p.replace(/\{[^}]+\}/g, '{param}')
	return p
}
