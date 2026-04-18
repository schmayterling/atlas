import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AtlasConfig, DEFAULT_TEST_PATTERNS, getDbPath, loadConfig } from '../shared/config.js'
import { log } from '../shared/logger.js'
import type {
	BlastRadiusResult,
	DeadCodeResult,
	DependencyResult,
	EdgeKind,
	FileInfo,
	FlowTraceResult,
	HotFragileEntry,
	IndexResult,
	SearchResult,
	SemanticSearchResult,
	StatusResult,
	SubsystemDetail,
	SubsystemSummary,
	DependencyNode,
	SymbolDetail,
	SymbolKind,
	SymbolOverview,
	SymbolResult,
	TestCoverage,
} from '../shared/types.js'
import { Indexer } from './indexer/indexer.js'
import { getCurrentCommit } from './indexer/change-detector.js'
import { getBlastRadius } from './queries/blast-radius.js'
import { findDeadCode } from './queries/dead-code.js'
import { findGeneratedFileIds } from './queries/generated-code.js'
import { getDependencies } from './queries/dependencies.js'
import { traceFlow } from './queries/flow-trace.js'
import { searchSymbols } from './queries/search.js'
import { findHotspots, type HotspotEntry } from './queries/hotspots.js'
import { findHotFragile, findUntestedSymbols, getTestCoverage } from './queries/test-coverage.js'
import { buildCrossProjectEdges as buildCrossProjectEdgesQuery, traceApi, type ApiTraceResult } from './queries/api-trace.js'
import { buildCrossProjectEdgesBySymbolName as buildCrossProjectEdgesBySymbolNameQuery } from './queries/symbol-name-linker.js'
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

// parse channel_hits.metadata safely. linkers write structured JSON
// (queue pub/sub direction, graphql definition kind, openapi
// schemaPath), the sql linker writes null. a corrupt row shouldn't
// poison the whole showChannel response — fall back to null and
// surface a warning so the data-integrity issue isn't invisible.
// see #70.
function parseChannelMetadata(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
		return null
	} catch (e) {
		log.warn(`channel metadata parse failed: ${e instanceof Error ? e.message : e}`)
		return null
	}
}

export class AtlasEngine {
	private store: AtlasStore | null = null
	private config: AtlasConfig
	private projectRoot: string
	private dbPath: string
	// cached set of generated/mock/fake/codegen file ids. computed
	// lazily via findGeneratedFileIds the first time any query that
	// needs it is called, then reused across sibling queries in the
	// same process. invalidated at the end of engine.index() because
	// a reindex may have added or removed generated files. see #44.
	private generatedFileIds: Set<number> | null = null

	constructor(projectRoot: string, opts?: { dbPath?: string }) {
		this.projectRoot = projectRoot
		this.config = loadConfig(projectRoot)
		this.dbPath = opts?.dbPath
			? (opts.dbPath.startsWith('/') ? opts.dbPath : join(projectRoot, opts.dbPath))
			: getDbPath(projectRoot, this.config)
	}

	private getStore(): AtlasStore {
		if (!this.store) {
			this.store = new AtlasStore(this.dbPath)
		}
		return this.store
	}

	// lazy accessor for the generated-file filter used by dead-code,
	// hot-fragile, and hotspots queries. computed once per process
	// via `findGeneratedFileIds` (which walks the files table and
	// checks path patterns + 4kb file headers). reset on reindex.
	private getGeneratedFileIds(): Set<number> {
		if (!this.generatedFileIds) {
			this.generatedFileIds = findGeneratedFileIds(this.getStore(), this.projectRoot)
		}
		return this.generatedFileIds
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
				],
				testPatterns: [...DEFAULT_TEST_PATTERNS],
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
		withGitHub?: boolean
	}): Promise<IndexResult> {
		const store = this.getStore()
		const indexer = new Indexer(this.projectRoot, this.config, store)
		const result = await indexer.index(opts)
		// invalidate the cached generated-file set so subsequent query
		// calls pick up any files added / removed by this reindex.
		this.generatedFileIds = null
		return result
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
			},
			languages,
		}
	}

	// --- search ---

	search(
		query: string,
		opts?: { kind?: SymbolKind; exact?: boolean; limit?: number; includeTests?: boolean },
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

	// stable-id-keyed variant for federation hops. both endpoints are
	// identified exactly so there is no first-match-wins resolution
	// step. returns null if either symbol is missing from this db.
	traceByStableIds(
		fromStableId: string,
		toStableId: string,
		opts?: { maxPaths?: number; maxDepth?: number },
	): FlowTraceResult | null {
		const store = this.getStore()
		if (!store.getSymbolByStableId(fromStableId)) return null
		if (!store.getSymbolByStableId(toStableId)) return null
		return traceFlow(store, fromStableId, toStableId, opts)
	}

	// --- resolve symbol ---

	resolveSymbol(query: string): import('../shared/types.js').SymbolResult | null {
		const store = this.getStore()
		const sym = store.resolveSymbol(query)
		if (!sym) return null
		return store.symbolToResult(sym)
	}

	// identity-only variant used by federation. symbolToResult strips
	// stable_id (it's internal), but federation needs it as the anchor
	// for cross_project_edges walks. keeps callers on the engine api
	// surface without leaking the full store.
	resolveSymbolIdentity(query: string): { stableId: string; name: string } | null {
		const store = this.getStore()
		const sym = store.resolveSymbol(query)
		if (!sym) return null
		return { stableId: sym.stableId, name: sym.name }
	}

	// --- dead code ---

	deadCode(opts?: { path?: string; kind?: SymbolKind; includeTests?: boolean }): DeadCodeResult {
		const store = this.getStore()
		return findDeadCode(store, { ...opts, excludeFileIds: this.getGeneratedFileIds() })
	}

	// --- test coverage ---

	testCoverage(query: string): TestCoverage | null {
		return getTestCoverage(this.getStore(), query)
	}

	// one-shot overview bundle: identity + upstream callers + downstream
	// callees + blast-radius summary + test coverage + subsystem, all
	// resolved off a single symbol query. exists so MCP agents answering
	// "tell me about X" can issue one tool call instead of chaining
	// resolve + deps(up) + deps(down) + blast + testCoverage + subsystem.
	// limits are applied here so the returned payload stays bounded
	// regardless of how big the underlying graph is. returns null when
	// the symbol can't be resolved.
	overview(
		query: string,
		opts?: { depth?: number; limit?: number },
	): SymbolOverview | null {
		const store = this.getStore()
		const sym = store.resolveSymbol(query)
		if (!sym) return null
		const symbolResult = store.symbolToResult(sym)
		const depth = opts?.depth ?? 2
		const limit = opts?.limit ?? 10

		const deps = getDependencies(store, sym.stableId, { direction: 'both', depth })
		const upstream = deps.upstream.slice(0, limit)
		const downstream = deps.downstream.slice(0, limit)

		const blast = getBlastRadius(store, sym.stableId, { depth: depth + 1 })
		const blastItems = blast ? [...blast.direct, ...blast.transitive] : []
		const blastSample: DependencyNode[] = blastItems.slice(0, limit).map((a) => ({
			symbol: a.symbol,
			edgeKind: a.relationship,
			confidence: 'resolved' as const,
			depth: a.depth,
			children: [],
		}))

		const coverage = getTestCoverage(store, query)
		const subsystem = this.symbolSubsystem(sym.stableId)

		return {
			symbol: symbolResult,
			upstream,
			downstream,
			blastRadius: { total: blastItems.length, sample: blastSample },
			testCoverage: coverage,
			subsystem,
		}
	}

	untestedSymbols(opts?: { kind?: SymbolKind; limit?: number }): SymbolResult[] {
		return findUntestedSymbols(this.getStore(), opts)
	}

	hotFragile(opts?: { limit?: number }): HotFragileEntry[] {
		return findHotFragile(this.getStore(), {
			...opts,
			excludeFileIds: this.getGeneratedFileIds(),
		})
	}

	// ranks exported functions/methods by fanin × churn × (1 - coverage).
	// see queries/hotspots.ts for the scoring formula.
	hotspots(opts?: { limit?: number; coverage?: 'called' | 'imported' | 'none' }): HotspotEntry[] {
		return findHotspots(this.getStore(), {
			...opts,
			excludeFileIds: this.getGeneratedFileIds(),
		})
	}

	// --- channels ---

	// list every (kind, value) group with >= 2 distinct symbols
	// touching the same channel value. the store-level helper does
	// the self-join; this just exposes the shape to CLI/MCP/web. see
	// #31.
	listChannels(kind: string): { value: string; symbolStableIds: string[] }[] {
		return this.getStore().findChannelHitGroups(kind)
	}

	// list every symbol that touched a specific channel value of a
	// given kind. the store returns full channel_hits rows so
	// consumers can render line numbers + file context without a
	// second lookup. `metadata` is parsed JSON when the linker wrote
	// it (queue/env/graphql/openapi), or null when it didn't (sql).
	// surfaced via the CLI, web route, and MCP tool so the write is
	// not dead. see #70.
	showChannel(kind: string, value: string): {
		symbols: import('../shared/types.js').SymbolResult[]
		hits: {
			symbolStableId: string
			line: number
			filePath: string
			metadata: Record<string, unknown> | null
		}[]
	} {
		const store = this.getStore()
		const rows = store.queryRawWithParams<{
			symbolStableId: string
			line: number
			filePath: string
			metadata: string | null
		}>(
			`SELECT ch.symbol_stable_id as symbolStableId, ch.line as line,
				f.path as filePath, ch.metadata as metadata
			 FROM channel_hits ch
			 JOIN files f ON f.id = ch.file_id
			 WHERE ch.kind = ? AND ch.value = ?
			 ORDER BY f.path, ch.line`,
			kind,
			value,
		)
		const uniqueIds = [...new Set(rows.map((r) => r.symbolStableId))]
		const symMap = store.getSymbolsByStableIds(uniqueIds)
		const symRecords = [...symMap.values()]
		const hits = rows.map((r) => ({
			symbolStableId: r.symbolStableId,
			line: r.line,
			filePath: r.filePath,
			metadata: parseChannelMetadata(r.metadata),
		}))
		return {
			symbols: store.symbolsToResults(symRecords),
			hits,
		}
	}

	// --- semantic search ---

	async semanticSearch(query: string, opts?: { limit?: number; includeTests?: boolean }): Promise<SemanticSearchResult> {
		const store = this.getStore()
		return semanticSearch(store, query, opts)
	}

	// --- file browsing ---

	files(opts?: { includeTests?: boolean }): FileInfo[] {
		const store = this.getStore()
		const allFiles = store.getAllFiles()
		const visible = opts?.includeTests ? allFiles : allFiles.filter((f) => !f.isTest)
		const counts = store.getSymbolCountByFile()
		return visible.map((f) => ({
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

	// federation fan-out helper: takes a stable_id directly so callers
	// that already resolved a symbol via anchorSymbol() don't have to
	// pay the resolveSymbol round-trip again. used by deps/blast/trace
	// --all-projects via federated-engine.fanOutDownstream.
	getCrossProjectEdgesByStableId(projectId: string, stableId: string): {
		outbound: { targetProject: string; targetStableId: string; kind: string }[]
		inbound: { sourceProject: string; sourceStableId: string; kind: string }[]
	} {
		const store = this.getStore()
		return {
			outbound: store.getCrossProjectEdgesFrom(projectId, stableId),
			inbound: store.getCrossProjectEdgesTo(projectId, stableId),
		}
	}

	// outbound-only variant for hot-path BFS walkers that don't need
	// inbound edges (e.g. findCrossProjectBoundaries). skips one SQL
	// round-trip per node.
	getCrossProjectEdgesOutbound(
		projectId: string,
		stableId: string,
	): { targetProject: string; targetStableId: string; kind: string }[] {
		return this.getStore().getCrossProjectEdgesFrom(projectId, stableId)
	}

	// inbound-only companion to getCrossProjectEdgesOutbound. fanOut
	// callers that only walk one direction use this to skip the round
	// trip they would otherwise discard. see #76.
	getCrossProjectEdgesInbound(
		projectId: string,
		stableId: string,
	): { sourceProject: string; sourceStableId: string; kind: string }[] {
		return this.getStore().getCrossProjectEdgesTo(projectId, stableId)
	}

	// stable-id-keyed variant of deps/blast/trace for federation hops.
	// the cross_project_edges row gives us an exact remote stable_id.
	// re-resolving that by name via resolveSymbol() would pick the
	// first same-named symbol which breaks when the remote project has
	// multiple symbols sharing the name. these wrappers look up the
	// symbol by stable_id and run the underlying query.
	depsByStableId(
		stableId: string,
		opts?: {
			direction?: 'upstream' | 'downstream' | 'both'
			depth?: number
			edgeKinds?: EdgeKind[]
		},
	): DependencyResult | null {
		const store = this.getStore()
		if (!store.getSymbolByStableId(stableId)) return null
		return getDependencies(store, stableId, opts)
	}

	blastByStableId(
		stableId: string,
		opts?: { depth?: number; includeTests?: boolean },
	): BlastRadiusResult | null {
		const store = this.getStore()
		if (!store.getSymbolByStableId(stableId)) return null
		return getBlastRadius(store, stableId, opts)
	}

	// federated dead-code filter: returns true when any non-heuristic
	// cross_project_edges row points at this symbol as a target. the
	// confidence filter is critical: name_match edges from
	// --match-by-name are heuristic and must not suppress otherwise-dead
	// symbols that just happen to share a name across projects.
	hasCrossProjectInbound(projectId: string, stableId: string): boolean {
		const store = this.getStore()
		return store.hasCrossProjectInbound(projectId, stableId)
	}

	// look up a symbol by stable_id and return its simple name. used by
	// federation callers that need a display name for a resolved remote
	// symbol without going through resolveSymbol (which takes a query
	// string and would re-resolve ambiguously).
	getSymbolNameByStableId(stableId: string): string | null {
		const store = this.getStore()
		const sym = store.getSymbolByStableId(stableId)
		return sym ? sym.name : null
	}

	// recover the stable_id for a SymbolResult that doesn't carry one.
	// dead-code and other queries return SymbolResult (external shape)
	// which omits the stable_id. federation filtering needs the stable
	// id to check cross_project_edges. the natural key is
	// (qualifiedName, kind, filePath) — same triple that feeds into
	// the content-addressed stable_id hash in shared/identity.ts — so
	// the lookup is unambiguous even when merged symbols share a name.
	resolveStableIdFromResult(sym: {
		qualifiedName: string
		kind: string
		filePath: string
	}): string | null {
		const store = this.getStore()
		return store.findStableIdByNaturalKey(sym.qualifiedName, sym.kind, sym.filePath)
	}

	// get the store for cross-project operations. intended for
	// federation internals only; cli/mcp/web should prefer
	// buildCrossProjectEdges, clearCrossProjectEdges, or
	// getCrossProjectEdgeCount below so the store handoff stays
	// encapsulated inside engine.ts.
	getStoreForCrossProject(): AtlasStore {
		return this.getStore()
	}

	// count rows in cross_project_edges for the index-cmd linked-project
	// hint. kept on the engine so the cli never reaches into the store
	// directly for a raw sql count. see #78.
	getCrossProjectEdgeCount(): number {
		return this.getStore().getCrossProjectEdgeCount()
	}

	// narrow accessor for the last indexed commit recorded in atlas_meta.
	// keeps MCP / web callers off engine.status() (which walks 6+ other
	// queries) when all they need is the freshness sha. see deep-review #82
	// perf + architecture feedback.
	getLastIndexedCommit(): string | null {
		return this.getStore().getMeta('last_indexed_commit')
	}

	// current HEAD of the project's git repo (or null when unavailable).
	// thin wrapper over change-detector.getCurrentCommit so MCP / web
	// stay on the engine boundary instead of importing indexer modules
	// directly. see deep-review #82 architecture feedback.
	getCurrentCommit(): string | null {
		return getCurrentCommit(this.projectRoot)
	}

	// build cross_project_edges between this engine and another
	// engine. wraps the route-match + (optional) name-match linkers so
	// the cli never has to pull raw stores out of the engine (see #75
	// architecture review). returns per-linker match counts.
	buildCrossProjectEdges(
		fromProjectId: string,
		otherEngine: AtlasEngine,
		otherProjectId: string,
		opts?: { matchByName?: boolean },
	): { routeMatches: number; nameMatches: number } {
		const fromStore = this.getStore()
		const toStore = otherEngine.getStore()
		const routeMatches = buildCrossProjectEdgesQuery(fromStore, fromProjectId, toStore, otherProjectId)
		const nameMatches = opts?.matchByName
			? buildCrossProjectEdgesBySymbolNameQuery(fromStore, fromProjectId, toStore, otherProjectId)
			: 0
		return { routeMatches, nameMatches }
	}

	// drop every cross_project_edges row in this engine's db. used by
	// `atlas projects clear-edges` so users can rebuild from scratch
	// after a build-edges schema or linker change. see #8a.
	clearCrossProjectEdges(): number {
		return this.getStore().deleteAllCrossProjectEdges()
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
	// note: getFlows() returns persisted flow rows. test files are filtered
	// at flow-detection time via findFlowRoots(includeTests=false) so this
	// list is already production-only by default.

	flows(): DetectedFlow[] {
		const store = this.getStore()
		return getFlows(store)
	}

	// --- duplicates ---

	duplicates(opts?: { includeTests?: boolean }): DuplicatePair[] {
		const store = this.getStore()
		return findDuplicates(store, opts)
	}

	// --- git history ---

	churn(opts?: ChurnOpts) {
		// thread projectRoot through so the optional branch filter in
		// queries/git.ts can call getBranchCommits() without the caller
		// passing both pieces.
		return gitChurn(this.getStore(), { ...opts, projectRoot: this.projectRoot })
	}

	fileHistory(filePath: string, opts?: { branch?: string }) {
		return gitFileHistory(this.getStore(), filePath, {
			branch: opts?.branch,
			projectRoot: this.projectRoot,
		})
	}

	contributors(filePath?: string) {
		return gitContributors(this.getStore(), filePath)
	}

	lastChanged(filePath: string) {
		return gitLastChanged(this.getStore(), filePath)
	}

	coChange(opts?: { filePath?: string; minCount?: number; limit?: number; includeTests?: boolean }) {
		return gitCoChange(this.getStore(), opts)
	}

	// --- subsystems ---
	// listSubsystems reads the persisted subsystems table; clusters are
	// computed from the file graph which already excludes test files at
	// build time (buildFileGraph), so the persisted output is production-only.

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
