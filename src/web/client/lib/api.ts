import type {
	BlastRadiusResult,
	DeadCodeResult,
	DependencyResult,
	DetectedFlow,
	DuplicatePair,
	FileInfo,
	FlowTraceResult,
	SearchResult,
	SemanticSearchResult,
	StatusResult,
	SymbolDetail,
	SymbolResult,
} from '../../../shared/types.js'

const BASE = '/api'

let currentProjectId: string | null = localStorage.getItem('atlas-project')

export function setCurrentProject(id: string | null) {
	currentProjectId = id
	if (id) localStorage.setItem('atlas-project', id)
	else localStorage.removeItem('atlas-project')
}

export function getCurrentProject(): string | null {
	return currentProjectId
}

async function get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
	const url = new URL(`${BASE}${path}`, window.location.origin)
	// inject current project if set
	if (currentProjectId) url.searchParams.set('project', currentProjectId)
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined) url.searchParams.set(k, v)
		}
	}
	const res = await fetch(url)
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }))
		throw new Error(body.error || res.statusText)
	}
	return res.json()
}

export const api = {
	status: () => get<StatusResult>('/status'),
	search: (q: string, opts?: { kind?: string; limit?: number; semantic?: boolean }) =>
		get<SearchResult | SemanticSearchResult>('/search', {
			q,
			kind: opts?.kind,
			limit: opts?.limit?.toString(),
			semantic: opts?.semantic ? 'true' : undefined,
		}),
	files: () => get<FileInfo[]>('/files'),
	fileSymbols: (path: string) => get<SymbolResult[]>('/files/symbols', { path }),
	deps: (symbol: string, opts?: { direction?: string; depth?: number }) =>
		get<DependencyResult>('/deps', {
			symbol,
			direction: opts?.direction,
			depth: opts?.depth?.toString(),
		}),
	blast: (target: string, opts?: { depth?: number }) =>
		get<BlastRadiusResult>('/blast', { target, depth: opts?.depth?.toString() }),
	trace: (from: string, to: string, opts?: { maxPaths?: number; maxDepth?: number }) =>
		get<FlowTraceResult>('/trace', {
			from,
			to,
			maxPaths: opts?.maxPaths?.toString(),
			maxDepth: opts?.maxDepth?.toString(),
		}),
	deadCode: (opts?: { kind?: string; path?: string }) =>
		get<DeadCodeResult>('/dead-code', { kind: opts?.kind, path: opts?.path }),
	symbol: (q: string) => get<SymbolResult>('/symbol', { q }),
	symbolDetail: (q: string) => get<SymbolDetail>('/symbol', { q, detail: 'true' }),
	wiki: (symbol?: string) =>
		get<{ type: string; files?: any[]; symbol?: SymbolResult; html?: string }>('/wiki', { symbol }),
	projects: () =>
		get<{ projects: { id: string; name: string; root: string }[]; links: any[] }>('/projects'),
	summarize: (q: string, model?: string) =>
		get<{ summary: string; model: string; cached: boolean }>('/summarize', { q, model }),
	flows: () => get<DetectedFlow[]>('/flows'),
	duplicates: () => get<DuplicatePair[]>('/duplicates'),
}
