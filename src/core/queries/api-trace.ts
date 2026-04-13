import type { AtlasStore } from '../storage/store.js'
import type { SymbolResult } from '../../shared/types.js'

export interface ApiEndpointResult {
	pathPattern: string
	httpMethod: string | null
	symbol: SymbolResult | null
	role: 'client' | 'server'
	framework: string | null
	filePath: string
	line: number
}

export interface ApiTraceResult {
	query: string
	clients: ApiEndpointResult[]
	servers: ApiEndpointResult[]
}

// TRAVERSAL surface. test files are NOT filtered. an api trace may surface
// integration tests that hit a given route, which is exactly what a user
// asking "who calls this endpoint" wants to see.
export function traceApi(
	store: AtlasStore,
	pathPattern: string,
): ApiTraceResult {
	const endpoints = store.findApiEndpoints(pathPattern)

	// batch-fetch all symbols for matched endpoints
	const allEpIds = endpoints.map((ep) => ep.symbolStableId)
	const epSymMap = store.getSymbolsByStableIds(allEpIds)
	const epResults = store.symbolsToResults([...epSymMap.values()])
	const epResultMap = new Map<string, import('../../shared/types.js').SymbolResult>()
	const epSymValues = [...epSymMap.values()]
	for (let i = 0; i < epSymValues.length; i++) {
		epResultMap.set(epSymValues[i].stableId, epResults[i])
	}

	const clients: ApiEndpointResult[] = []
	const servers: ApiEndpointResult[] = []

	for (const ep of endpoints) {
		const symbolResult = epResultMap.get(ep.symbolStableId) ?? null

		const result: ApiEndpointResult = {
			pathPattern: ep.pathPattern,
			httpMethod: ep.httpMethod,
			symbol: symbolResult,
			role: ep.role as 'client' | 'server',
			framework: ep.framework,
			filePath: ep.filePath,
			line: ep.line,
		}

		if (ep.role === 'client') clients.push(result)
		else servers.push(result)
	}

	return { query: pathPattern, clients, servers }
}

// build cross-project edges by matching client and server API endpoints
// across projects. writes the same edge row to BOTH project dbs so a
// federation fan-out started from either side sees the link. before
// this fix the edge only landed in `localStore` and a query rooted in
// the remote project would silently miss it.
export function buildCrossProjectEdges(
	localStore: AtlasStore,
	localProjectId: string,
	remoteStore: AtlasStore,
	remoteProjectId: string,
): number {
	const localEndpoints = localStore.findApiEndpoints()
	const remoteEndpoints = remoteStore.findApiEndpoints()
	let count = 0

	for (const local of localEndpoints) {
		for (const remote of remoteEndpoints) {
			// match client -> server or server -> client across projects
			if (local.role === remote.role) continue
			if (!pathsMatch(local.pathPattern, remote.pathPattern)) continue

			const client = local.role === 'client' ? local : remote
			const server = local.role === 'server' ? local : remote
			const clientProject = local.role === 'client' ? localProjectId : remoteProjectId
			const serverProject = local.role === 'server' ? localProjectId : remoteProjectId

			const edge = {
				sourceProject: clientProject,
				sourceStableId: client.symbolStableId,
				targetProject: serverProject,
				targetStableId: server.symbolStableId,
				kind: 'calls',
			}
			localStore.insertCrossProjectEdge(edge)
			remoteStore.insertCrossProjectEdge(edge)
			count++
		}
	}

	return count
}

function pathsMatch(a: string, b: string): boolean {
	// normalize and compare: strip trailing slashes, compare case-insensitive
	const na = a.replace(/\/+$/, '').toLowerCase()
	const nb = b.replace(/\/+$/, '').toLowerCase()
	return na === nb
}
