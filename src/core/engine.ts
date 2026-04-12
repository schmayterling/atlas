import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AtlasConfig, getDbPath, loadConfig } from '../shared/config.js'
import { log } from '../shared/logger.js'
import type {
	BlastRadiusResult,
	DeadCodeResult,
	DependencyResult,
	EdgeKind,
	FileInfo,
	FlowTraceResult,
	IndexResult,
	SearchResult,
	SemanticSearchResult,
	StatusResult,
	SubsystemDetail,
	SubsystemSummary,
	SymbolDetail,
	SymbolKind,
} from '../shared/types.js'
import { Indexer } from './indexer/indexer.js'
import { getBlastRadius } from './queries/blast-radius.js'
import { findDeadCode } from './queries/dead-code.js'
import { getDependencies } from './queries/dependencies.js'
import { traceFlow } from './queries/flow-trace.js'
import { searchSymbols } from './queries/search.js'
import { traceApi, type ApiTraceResult } from './queries/api-trace.js'
import { summarizeSymbol, type SummaryResult } from './llm/summarizer.js'
import { getFlows, type DetectedFlow } from './queries/flow-detection.js'
import { findDuplicates, type DuplicatePair } from './queries/duplicate-detection.js'
import {
	churn as gitChurn,
	coChange as gitCoChange,
	contributors as gitContributors,
	fileHistory as gitFileHistory,
	lastChanged as gitLastChanged,
	type ChurnOpts,
} from './queries/git.js'
import {
	getSubsystem,
	getSymbolSubsystem,
	listSubsystems,
} from './queries/subsystems.js'
import { semanticSearch } from './queries/semantic-search.js'
import { AtlasStore } from './storage/store.js'

export class AtlasEngine {
	private store: AtlasStore | null = null
	private config: AtlasConfig
	private projectRoot: string
	private dbPath: string

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot
		this.config = loadConfig(projectRoot)
		this.dbPath = getDbPath(projectRoot, this.config)
	}

	private getStore(): AtlasStore {
		if (!this.store) {
			this.store = new AtlasStore(this.dbPath)
		}
		return this.store
	}

	close() {
		this.store?.close()
		this.store = null
	}

	// --- init ---

	init(): { configPath: string; dbPath: string; created: boolean } {
		const atlasDir = join(this.projectRoot, '.atlas')
		const configPath = join(atlasDir, 'config.json')
		const created = !existsSync(atlasDir)

		if (created) {
			mkdirSync(atlasDir, { recursive: true })
		}

		if (!existsSync(configPath)) {
			const defaultConfig = {
				include: [
					'**/*.ts',
					'**/*.tsx',
					'**/*.js',
					'**/*.jsx',
					'**/*.py',
					'**/*.go',
					'**/*.rs',
				],
				exclude: [
					'**/node_modules/**',
					'**/dist/**',
					'**/build/**',
					'**/.git/**',
					'**/*.test.*',
					'**/*.spec.*',
				],
				languages: {
					typescript: { extensions: ['.ts', '.tsx'] },
					javascript: { extensions: ['.js', '.jsx', '.mjs', '.cjs'] },
					python: { extensions: ['.py'] },
					go: { extensions: ['.go'] },
					rust: { extensions: ['.rs'] },
				},
			}
			writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2))
		}

		// ensure db exists
		const store = this.getStore()
		store.close()
		this.store = null

		return { configPath, dbPath: this.dbPath, created }
	}

	// --- index ---

	async index(opts?: {
		force?: boolean
		dryRun?: boolean
		noEmbed?: boolean
		noSummarize?: boolean
		withCoChange?: boolean
	}): Promise<IndexResult> {
		const store = this.getStore()
		const indexer = new Indexer(this.projectRoot, this.config, store)
		return indexer.index(opts)
	}

	// --- status ---

	status(): StatusResult {
		const store = this.getStore()

		const lastIndexedAt = store.getMeta('last_indexed_at')
		const lastCommit = store.getMeta('last_indexed_commit')
		const lastBranch = store.getMeta('last_branch')

		const fileCount = store.getFileCount()
		const symbolCount = store.getSymbolCount()
		const edgeCount = store.getEdgeCount()
		const refCount = store.getReferenceCount()
		const languages = store.getLanguageStats()

		// determine health
		let health: StatusResult['health'] = 'good'
		if (fileCount === 0) {
			health = 'missing'
		} else if (!lastIndexedAt) {
			health = 'outdated'
		} else {
			const age = Date.now() - Number(lastIndexedAt)
			if (age > 24 * 60 * 60 * 1000) health = 'outdated'
			else if (age > 60 * 60 * 1000) health = 'stale'
		}

		return {
			projectRoot: this.projectRoot,
			dbPath: this.dbPath,
			dbSizeBytes: store.getDbSize(),
			lastIndexedAt: lastIndexedAt ? Number(lastIndexedAt) : null,
			lastCommit,
			lastBranch,
			health,
			staleFileCount: 0, // TODO: compute from change detection
			stats: {
				files: fileCount,
				symbols: symbolCount,
				edges: edgeCount,
				references: refCount,
			},
			languages,
		}
	}

	// --- search ---

	search(
		query: string,
		opts?: { kind?: SymbolKind; exact?: boolean; limit?: number },
	): SearchResult {
		const store = this.getStore()
		return searchSymbols(store, query, opts)
	}

	// --- dependencies ---

	deps(
		symbolQuery: string,
		opts?: {
			direction?: 'upstream' | 'downstream' | 'both'
			depth?: number
			edgeKinds?: EdgeKind[]
		},
	): DependencyResult | null {
		const store = this.getStore()
		const symbol = store.resolveSymbol(symbolQuery)
		if (!symbol) return null
		return getDependencies(store, symbol.stableId, opts)
	}

	// --- blast radius ---

	blast(
		targetQuery: string,
		opts?: { depth?: number; includeTests?: boolean },
	): BlastRadiusResult | null {
		const store = this.getStore()
		const symbol = store.resolveSymbol(targetQuery)
		if (!symbol) return null
		return getBlastRadius(store, symbol.stableId, opts)
	}

	// --- flow tracing ---

	trace(
		fromQuery: string,
		toQuery: string,
		opts?: { maxPaths?: number; maxDepth?: number },
	): FlowTraceResult | null {
		const store = this.getStore()
		const source = store.resolveSymbol(fromQuery)
		const target = store.resolveSymbol(toQuery)
		if (!source || !target) return null
		return traceFlow(store, source.stableId, target.stableId, opts)
	}

	// --- resolve symbol ---

	resolveSymbol(query: string): import('../shared/types.js').SymbolResult | null {
		const store = this.getStore()
		const sym = store.resolveSymbol(query)
		if (!sym) return null
		return store.symbolToResult(sym)
	}

	// --- dead code ---

	deadCode(opts?: { path?: string; kind?: SymbolKind }): DeadCodeResult {
		const store = this.getStore()
		return findDeadCode(store, opts)
	}

	// --- semantic search ---

	async semanticSearch(query: string, opts?: { limit?: number }): Promise<SemanticSearchResult> {
		const store = this.getStore()
		return semanticSearch(store, query, opts)
	}

	// --- file browsing ---

	files(): FileInfo[] {
		const store = this.getStore()
		const allFiles = store.getAllFiles()
		const counts = store.getSymbolCountByFile()
		return allFiles.map((f) => ({
			path: f.path,
			language: f.language,
			symbolCount: counts.get(f.id) ?? 0,
			sizeBytes: f.sizeBytes,
			indexedAt: f.indexedAt,
		}))
	}

	fileSymbols(path: string): import('../shared/types.js').SymbolResult[] {
		const store = this.getStore()
		return store.getSymbolsByFilePath(path)
	}

	// --- API trace ---

	traceApi(pathPattern: string): ApiTraceResult {
		const store = this.getStore()
		return traceApi(store, pathPattern)
	}

	// get cross-project edges for a symbol
	getCrossProjectEdges(projectId: string, symbolQuery: string): {
		outbound: { targetProject: string; targetStableId: string; kind: string }[]
		inbound: { sourceProject: string; sourceStableId: string; kind: string }[]
	} {
		const store = this.getStore()
		const sym = store.resolveSymbol(symbolQuery)
		if (!sym) return { outbound: [], inbound: [] }
		return {
			outbound: store.getCrossProjectEdgesFrom(projectId, sym.stableId),
			inbound: store.getCrossProjectEdgesTo(projectId, sym.stableId),
		}
	}

	// get the store for cross-project operations (used by engine-pool)
	getStoreForCrossProject(): AtlasStore {
		return this.getStore()
	}

	// --- LLM summaries ---

	getFileSummary(filePath: string): string | null {
		try {
			const store = this.getStore()
			const cached = store.queryRawWithParams<{ summary: string }>(
				'SELECT summary FROM symbol_summaries WHERE symbol_stable_id = ?',
				`file:${filePath}`,
			)
			return cached.length > 0 ? cached[0].summary : null
		} catch {
			return null
		}
	}

	// --- flows ---

	flows(): DetectedFlow[] {
		const store = this.getStore()
		return getFlows(store)
	}

	// --- duplicates ---

	duplicates(): DuplicatePair[] {
		const store = this.getStore()
		return findDuplicates(store)
	}

	// --- git history ---

	churn(opts?: ChurnOpts) {
		return gitChurn(this.getStore(), opts)
	}

	fileHistory(filePath: string) {
		return gitFileHistory(this.getStore(), filePath)
	}

	contributors(filePath?: string) {
		return gitContributors(this.getStore(), filePath)
	}

	lastChanged(filePath: string) {
		return gitLastChanged(this.getStore(), filePath)
	}

	coChange(opts?: { filePath?: string; minCount?: number; limit?: number }) {
		return gitCoChange(this.getStore(), opts)
	}

	// --- subsystems ---

	subsystems(): SubsystemSummary[] {
		return listSubsystems(this.getStore())
	}

	subsystem(id: string): SubsystemDetail | null {
		return getSubsystem(this.getStore(), id)
	}

	symbolSubsystem(stableId: string): SubsystemSummary | null {
		return getSymbolSubsystem(this.getStore(), stableId)
	}

	// --- LLM summaries ---

	async summarize(symbolQuery: string, opts?: { model?: string }): Promise<SummaryResult> {
		const detail = await this.symbolDetail(symbolQuery)
		if (!detail) throw new Error(`symbol not found: ${symbolQuery}`)
		const store = this.getStore()
		return summarizeSymbol(store, detail, opts)
	}

	// --- symbol detail ---

	async symbolDetail(query: string): Promise<SymbolDetail | null> {
		const store = this.getStore()
		const sym = store.resolveSymbol(query)
		if (!sym) return null
		const symbol = store.symbolToResult(sym)
		const depsResult = getDependencies(store, sym.stableId, { direction: 'both', depth: 1 })
		let sourceCode: string | undefined
		try {
			const fullPath = join(this.projectRoot, symbol.filePath)
			const text = await Bun.file(fullPath).text()
			const lines = text.split('\n')
			sourceCode = lines.slice(symbol.lineStart - 1, symbol.lineEnd).join('\n')
		} catch (e) {
			log.debug(`symbolDetail: could not read source for ${symbol.filePath}: ${e}`)
		}
		// look up cached LLM summary
		let summary: string | undefined
		try {
			const cached = store.queryRawWithParams<{ summary: string }>(
				'SELECT summary FROM symbol_summaries WHERE symbol_stable_id = ?', sym.stableId,
			)
			if (cached.length > 0) summary = cached[0].summary
		} catch { /* table may not exist */ }

		return {
			symbol,
			summary,
			upstream: depsResult?.upstream ?? [],
			downstream: depsResult?.downstream ?? [],
			sourceCode,
		}
	}
}
