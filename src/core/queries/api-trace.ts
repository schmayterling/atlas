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

export function traceApi(
	store: AtlasStore,
	pathPattern: string,
): ApiTraceResult {
	const endpoints = store.findApiEndpoints(pathPattern)

	const clients: ApiEndpointResult[] = []
	const servers: ApiEndpointResult[] = []

	for (const ep of endpoints) {
		const sym = store.getSymbolByStableId(ep.symbolStableId)
		const symbolResult = sym ? store.symbolToResult(sym) : null

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
