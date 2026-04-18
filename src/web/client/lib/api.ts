import type {
	BlastRadiusResult,
	DeadCodeResult,
	DependencyResult,
	DetectedFlow,
	DuplicatePair,
	FileInfo,
	FlowTraceResult,
	HotFragileEntry,
	SearchResult,
	SemanticSearchResult,
	StatusResult,
	SubsystemDetail,
	SubsystemSummary,
	SymbolArticleResult,
	SymbolDetail,
	SymbolResult,
} from '../../../shared/types.js'

export type { HotFragileEntry } from '../../../shared/types.js'

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
	churn: (opts?: { limit?: number; path?: string; sinceDays?: number }) =>
		get<ChurnEntry[]>('/git/churn', {
			limit: opts?.limit?.toString(),
			path: opts?.path,
			sinceDays: opts?.sinceDays?.toString(),
		}),
	fileHistory: (file: string) => get<FileHistoryEntry[]>('/git/history', { file }),
	contributors: (file?: string) => get<ContributorEntry[]>('/git/contributors', { file }),
	coChange: (opts?: { file?: string; limit?: number; minCount?: number }) =>
		get<CoChangePair[]>('/git/co-change', {
			file: opts?.file,
			limit: opts?.limit?.toString(),
			minCount: opts?.minCount?.toString(),
		}),
	subsystems: () => get<SubsystemSummary[]>('/subsystems'),
	subsystem: (id: string) => get<SubsystemDetail>('/subsystem', { id }),
	entryPoints: (limit = 8) => get<SymbolResult[]>('/entry-points', { limit: String(limit) }),
	hotFragile: (limit = 30) => get<HotFragileEntry[]>('/hot-fragile', { limit: String(limit) }),
	symbolArticle: (q: string) => get<SymbolArticleResult>('/article/symbol', { q }),
}

export interface ChurnEntry {
	filePath: string
	commits: number
	contributors: number
	lastTouchedAt: number
	topAuthor: string
}
export interface FileHistoryEntry {
	hash: string
	authorName: string
	authorEmail: string
	authoredAt: number
	subject: string
	status: 'A' | 'M' | 'D' | 'R'
	renameFrom: string | null
}
export interface ContributorEntry {
	authorName: string
	authorEmail: string
	commits: number
}
export interface CoChangePair {
	fileA: string
	fileB: string
	count: number
	jaccard: number
}
