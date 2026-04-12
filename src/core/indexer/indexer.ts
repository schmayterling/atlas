import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { AtlasConfig } from '../../shared/config.js'
import { contentHash, stableSymbolId } from '../../shared/identity.js'
import { log } from '../../shared/logger.js'
import type { IndexResult } from '../../shared/types.js'
import { getLanguageForExtension, parseSource } from '../parser/parser-manager.js'
import { getExtractor } from '../parser/extractor-registry.js'
import { linkInRepoApiEndpoints } from '../queries/cross-language-linker.js'
import { detectDuplicatesFromEmbeddings } from '../queries/duplicate-detection.js'
import { findGeneratedFileIds } from '../queries/generated-code.js'
import { linkProtoSymbols } from '../queries/proto-linker.js'
import type { AtlasStore } from '../storage/store.js'
import {
	type ChangeSet,
	computeConfigHash,
	detectChanges,
	getCurrentBranch,
	getCurrentCommit,
} from './change-detector.js'
import { type DiscoveredFile, discoverFiles } from './file-discovery.js'
import { detectRepoModules, matchFileToModule, type RepoModule } from './module-detector.js'
import { resolveProject } from './ts-resolver.js'

// options recognised by the index pipeline. new flags land here so the
// driver stays a short ordered sequence of step calls.
export interface IndexOptions {
	force?: boolean
	dryRun?: boolean
	noEmbed?: boolean
	noSummarize?: boolean
	withCoChange?: boolean
	withGitHub?: boolean
}

// mutable state threaded through the pipeline steps. each step reads and
// possibly mutates this; the driver owns the single instance and feeds it
// to every step in order. keeping it in one place makes the data flow
// obvious and avoids accidental hidden mutation through closure state.
interface IndexState {
	start: number
	warnings: string[]
	discovered: DiscoveredFile[]
	changes: ChangeSet
	absolutePaths: string[]
	processedStableIds: string[]
	generatedFileIds: Set<number>
	repoModules: RepoModule[]
}

export class Indexer {
	constructor(
		private projectRoot: string,
		private config: AtlasConfig,
		private store: AtlasStore,
	) {}

	// the driver: short ordered sequence of step calls. each step mutates
	// the shared state and the driver decides whether to early-return based
	// on opts. the step numbering in the comments matches the historical
	// ordering so git blame / prior refs still line up.
	async index(opts?: IndexOptions): Promise<IndexResult> {
		const state: IndexState = {
			start: performance.now(),
			warnings: [],
			discovered: [],
			changes: emptyChangeSet(),
			absolutePaths: [],
			processedStableIds: [],
			generatedFileIds: new Set(),
			repoModules: [],
		}

		this.stepDiscoverFiles(state)
		this.stepDetectRepoModules(state)
		this.stepDetectChanges(state, opts)
		this.stepSyncIsTestFlags(state)

		// step 3: dry-run guard must come before any state mutation so the
		// caller sees what would happen without touching persisted data.
		if (opts?.dryRun) return this.dryRunResult(state)

		await this.stepIngestGitHistory(state, opts)
		this.stepLogChangeSummary(state)
		this.stepHandleRenames(state)
		this.stepDeleteRemovedRecords(state)
		this.stepParseAndExtract(state)
		this.stepResolveCrossFile(state)
		this.stepLinkCrossLanguageApis(state)
		await this.stepMapTests(state)
		await this.stepEmbedSymbols(state, opts)
		await this.stepSummarizeSymbols(state, opts)
		this.stepComputeGeneratedCodeFilter(state)
		await this.stepDetectFlows(state, opts)
		this.stepDetectDuplicates(state)
		await this.stepDetectSubsystems(state, opts)
		await this.stepIngestGitHub(state, opts)
		this.stepFinalizeMetadata()

		const duration = performance.now() - state.start
		log.info(`indexing complete in ${(duration / 1000).toFixed(1)}s`)

		return {
			filesTotal: state.discovered.length,
			filesAdded: state.changes.added.length,
			filesModified: state.changes.modified.length,
			filesDeleted: state.changes.deleted.length,
			filesCached:
				state.discovered.length - state.changes.added.length - state.changes.modified.length,
			symbols: this.store.getSymbolCount(),
			edges: this.store.getEdgeCount(),
			references: this.store.getReferenceCount(),
			duration,
			warnings: state.warnings,
		}
	}

	// step 1: discover files on disk matching the config include/exclude.
	private stepDiscoverFiles(state: IndexState): void {
		const t = performance.now()
		state.discovered = discoverFiles(this.projectRoot, this.config)
		log.debug(`file discovery: ${(performance.now() - t).toFixed(0)}ms`)
		log.info(`found ${state.discovered.length} files`)
	}

	// step 1.5: detect monorepo sub-modules (go.mod / package.json /
	// pyproject.toml / setup.py). rows are upserted into repo_modules
	// and files get their repo_module_id assigned in step 5 during
	// extractOneFile. renamed "repo_modules" (schema) to avoid colliding
	// with the registry scope's use of "project" — see the v12 migration
	// comment for the rationale.
	private stepDetectRepoModules(state: IndexState): void {
		const t = performance.now()
		const modules = detectRepoModules(this.projectRoot, state.discovered)
		state.repoModules = modules
		this.store.bulkInsert(() => {
			for (const mod of modules) this.store.upsertRepoModule(mod)
			this.store.deleteRepoModulesNotIn(modules.map((m) => m.id))
		})
		log.debug(`module detection: ${(performance.now() - t).toFixed(0)}ms`)
		if (modules.length > 0) {
			const byKind = new Map<string, number>()
			for (const m of modules) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1)
			const summary = [...byKind.entries()].map(([k, v]) => `${v} ${k}`).join(', ')
			log.info(`repo modules: ${modules.length} (${summary})`)
		}
	}

	// step 2: diff the discovered set against the stored index.
	// --full (opts.force) synthesises a full-delete change set so the
	// downstream steps treat every file as re-added.
	private stepDetectChanges(state: IndexState, opts: IndexOptions | undefined): void {
		const t = performance.now()
		state.changes = detectChanges(this.projectRoot, state.discovered, this.store)
		log.debug(`change detection: ${(performance.now() - t).toFixed(0)}ms`)

		if (opts?.force) {
			const existingPaths = this.store.getAllFiles().map((f) => f.path)
			state.changes = {
				added: state.discovered.map((f) => f.path),
				modified: [],
				deleted: existingPaths,
				renames: [],
				configChanged: false,
				branchChanged: false,
				isFullReindex: true,
			}
		}
	}

	// step 2.5: sync files.is_test against current testPatterns. handles
	// both first-run-after-migration-v11 (existing rows default to 0) and
	// testPatterns config changes (file reclassification without a content
	// change). only writes rows whose flag actually changes.
	private stepSyncIsTestFlags(state: IndexState): void {
		this.store.syncFileIsTest(state.discovered.map((f) => ({ path: f.path, isTest: f.isTest })))
	}

	// step 3.5: git history ingestion (runs even when totalChanged === 0
	// so a clean tree still refreshes commit data after new commits land).
	// the discovered file set scopes ingestion: only file_changes whose
	// path matches a currently-discovered file (or rename source) are
	// kept, which filters out noise from once-tracked-now-gitignored
	// artifacts. an empty discovered set means "ingest everything"; we
	// pass undefined rather than an empty Set so the filter doesn't
	// silently skip every commit.
	//
	// --full git history reset happens here too: drop every git-derived
	// row + watermark in one transaction so the next ingestion rebuilds
	// from scratch under the current path filter. only runs after the
	// dry-run guard (enforced by the driver).
	private async stepIngestGitHistory(
		state: IndexState,
		opts: IndexOptions | undefined,
	): Promise<void> {
		if (opts?.force) {
			const { clearGitHistory } = await import('./git-history.js')
			clearGitHistory(this.store)
		}

		try {
			const { ingestGitHistory } = await import('./git-history.js')
			const relevantPaths =
				state.discovered.length > 0 ? new Set(state.discovered.map((f) => f.path)) : undefined
			const gitResult = ingestGitHistory(this.projectRoot, this.store, relevantPaths)
			if (gitResult.commitsAdded > 0) {
				log.info(
					`git: +${gitResult.commitsAdded} commits, ${gitResult.fileChangesAdded} file changes`,
				)
			} else if (gitResult.skipped && gitResult.reason && gitResult.reason !== 'up to date') {
				log.debug(`git history: ${gitResult.reason}`)
			}
		} catch (e) {
			log.warn(`git history ingestion failed: ${e}`)
		}
	}

	// informational-only: log the change summary and note when nothing
	// changed so the post-processing steps still run to backfill new
	// pipelines against an existing index.
	private stepLogChangeSummary(state: IndexState): void {
		const total =
			state.changes.added.length + state.changes.modified.length + state.changes.deleted.length
		log.info(
			`changes: ${state.changes.added.length} added, ${state.changes.modified.length} modified, ${state.changes.deleted.length} deleted`,
		)
		if (total === 0) {
			log.info('no file changes; running post-processing pipelines only')
		}
	}

	// rename handler: for every {oldPath, newPath} pair git told us about,
	// rewrite symbol identity in place so edges, api_endpoints, test_links,
	// embeddings, summaries, flows and duplicates all keep pointing at the
	// same logical symbols under the new path. runs BEFORE step 4 so the
	// downstream delete+insert never sees the old path; the new path is
	// still in state.changes.modified so step 5 re-parses the content to
	// pick up any concurrent edits. file_id stays stable so file_changes /
	// co_change_pairs / pr_files (future) inherit the pre-rename history.
	private stepHandleRenames(state: IndexState): void {
		if (state.changes.renames.length === 0) return
		let rewritten = 0
		for (const r of state.changes.renames) {
			try {
				rewritten += this.store.rewriteStableIdsForRename(r.oldPath, r.newPath)
				log.debug(`rename: ${r.oldPath} -> ${r.newPath}`)
			} catch (e) {
				state.warnings.push(`rename rewrite failed (${r.oldPath} -> ${r.newPath}): ${e}`)
				log.warn(`rename rewrite failed (${r.oldPath} -> ${r.newPath}): ${e}`)
			}
		}
		log.info(
			`renames: ${state.changes.renames.length} files, ${rewritten} stable_ids rewritten`,
		)
	}

	// step 4: delete records for deleted + modified files so re-indexing
	// (step 5) inserts fresh rows.
	private stepDeleteRemovedRecords(state: IndexState): void {
		const toDelete = [...state.changes.deleted, ...state.changes.modified]
		if (toDelete.length > 0) {
			log.debug(`deleting records for ${toDelete.length} files`)
			this.store.deleteFilesByPaths(toDelete)
		}
	}

	// step 5: parse and extract symbols, edges, and api endpoints for
	// every added + modified file. the per-file loop runs inside a
	// single bulkInsert transaction for throughput.
	private stepParseAndExtract(state: IndexState): void {
		const toProcess = [...state.changes.added, ...state.changes.modified]
		const discoveredByPath = new Map(state.discovered.map((f) => [f.path, f]))
		const t = performance.now()

		log.info(`indexing ${toProcess.length} files...`)

		this.store.bulkInsert(() => {
			for (const filePath of toProcess) {
				const fileInfo = discoveredByPath.get(filePath)
				if (!fileInfo) continue
				try {
					this.extractOneFile(state, filePath, fileInfo)
				} catch (e) {
					state.warnings.push(`failed to index ${filePath}: ${e}`)
					log.warn(`failed to index ${filePath}: ${e}`)
				}
			}
		})
		log.debug(`parsing + extraction: ${(performance.now() - t).toFixed(0)}ms`)
	}

	// per-file extraction: parse source, look up extractor by language,
	// emit symbols + intra-file edges + api endpoints, queue TS/JS files
	// for step 6 cross-file resolution.
	private extractOneFile(
		state: IndexState,
		filePath: string,
		fileInfo: DiscoveredFile,
	): void {
		const source = readFileSync(fileInfo.absolutePath, 'utf-8')
		const hash = contentHash(source)

		const ext = extname(filePath)
		const parserLang = getLanguageForExtension(ext)
		if (!parserLang) {
			state.warnings.push(`unsupported extension: ${ext} (${filePath})`)
			return
		}

		const extractor = getExtractor(parserLang)
		if (!extractor) {
			state.warnings.push(`no extractor for language: ${parserLang} (${filePath})`)
			return
		}

		const tree = parseSource(source, parserLang)
		const result = extractor.extract(tree, filePath, source)
		const fileId = this.store.insertFile(
			filePath,
			hash,
			fileInfo.language,
			fileInfo.sizeBytes,
			fileInfo.isTest,
		)

		// bind the file to its repo module (if any) so cross-module
		// queries, per-module stats, and federation all have a single
		// source of truth. nulls stay null (root-level files without a
		// manifest) via SET NULL on the FK.
		const mod = matchFileToModule(filePath, state.repoModules)
		if (mod) this.store.setFileRepoModule(fileId, mod.id)

		// build a lookup map for O(1) kind resolution instead of O(n) per symbol
		const kindByQName = new Map(result.symbols.map((s) => [s.qualifiedName, s.kind]))

		for (const sym of result.symbols) {
			const sid = stableSymbolId(filePath, sym.kind, sym.qualifiedName)
			state.processedStableIds.push(sid)
			const parentId = sym.parentQualifiedName
				? stableSymbolId(
						filePath,
						kindByQName.get(sym.parentQualifiedName) ?? 'variable',
						sym.parentQualifiedName,
					)
				: null

			this.store.insertSymbol({
				stableId: sid,
				fileId,
				name: sym.name,
				qualifiedName: sym.qualifiedName,
				kind: sym.kind,
				visibility: sym.visibility,
				isExported: sym.isExported,
				lineStart: sym.lineStart,
				lineEnd: sym.lineEnd,
				colStart: sym.colStart,
				colEnd: sym.colEnd,
				byteStart: sym.byteStart,
				byteEnd: sym.byteEnd,
				parentId,
				signature: sym.signature,
				docComment: sym.docComment,
				metadata: null,
			})
		}

		for (const edge of result.edges) {
			const sourceKind = kindByQName.get(edge.sourceQualifiedName) ?? 'variable'
			const targetKind = kindByQName.get(edge.targetName) ?? 'variable'
			const sourceId = stableSymbolId(filePath, sourceKind, edge.sourceQualifiedName)
			const targetId = stableSymbolId(filePath, targetKind, edge.targetName)

			this.store.insertEdge({
				sourceId,
				targetId,
				kind: edge.kind,
				fileId,
				line: edge.line,
				col: edge.col,
				confidence: edge.confidence,
				metadata: null,
			})
		}

		if (result.apiEndpoints && result.apiEndpoints.length > 0) {
			this.store.deleteApiEndpointsForFile(filePath)
			for (const ep of result.apiEndpoints) {
				const epSymbolId = stableSymbolId(filePath, 'function', ep.symbolQualifiedName)
				this.store.insertApiEndpoint({
					filePath,
					pathPattern: ep.pathPattern,
					httpMethod: ep.httpMethod,
					symbolStableId: epSymbolId,
					role: ep.role,
					framework: ep.framework,
					line: ep.line,
				})
			}
		}

		// only TypeScript/JavaScript files go through TS compiler resolution
		const tsLangs = ['typescript', 'tsx', 'javascript', 'jsx']
		if (tsLangs.includes(parserLang)) {
			state.absolutePaths.push(fileInfo.absolutePath)
		}
	}

	// step 6: cross-file resolution via TS compiler API. skipped only
	// when there is nothing to process AND no deletions to clean up;
	// the resolver itself is expensive but it also owns cleanup of
	// stale cross-file edges that point to removed symbols.
	private stepResolveCrossFile(state: IndexState): void {
		const t = performance.now()
		if (state.absolutePaths.length === 0 && state.changes.deleted.length === 0) {
			log.debug('skipping cross-file resolution (no files processed, no deletions)')
			return
		}

		log.info('resolving cross-file references...')
		try {
			// delete cross-file edges only for symbols in processed files (not all)
			if (state.processedStableIds.length > 0) {
				this.store.deleteCrossFileEdgesForSources(state.processedStableIds)
			}

			// when files were deleted in step 4 their symbols cascaded away
			// but cross-file edges pointing INTO those symbols (sourceId or
			// targetId referencing a now-missing stable_id) are orphaned.
			// rebuild from the current TS compiler view of the project to
			// drop the stale rows. only runs when we have something to resolve.
			const resolved =
				state.absolutePaths.length > 0
					? resolveProject(this.projectRoot, state.absolutePaths, this.store)
					: { edges: [], imports: [] }

			this.store.bulkInsert(() => {
				for (const edge of resolved.edges) {
					this.store.insertEdge({
						sourceId: edge.sourceStableId,
						targetId: edge.targetStableId,
						kind: edge.kind,
						fileId: null,
						line: edge.line,
						col: edge.col,
						confidence: edge.confidence,
						metadata: null,
					})
				}

				for (const imp of resolved.imports) {
					this.store.insertImport({
						sourceFileId: imp.sourceFileId,
						targetFileId: imp.targetFileId,
						importPath: imp.importPath,
						isTypeOnly: imp.isTypeOnly,
						line: imp.line,
					})
				}
			})

			log.info(
				`resolved ${resolved.edges.length} cross-file edges, ${resolved.imports.length} imports`,
			)
		} catch (e) {
			state.warnings.push(`cross-file resolution failed: ${e}`)
			log.warn(`cross-file resolution failed: ${e}`)
		}
		log.debug(`cross-file resolution: ${(performance.now() - t).toFixed(0)}ms`)
	}

	// step 6.3: in-repo cross-language api linking. matches client
	// fetch/axios endpoints against server handlers by path + method
	// and writes cross_project_edges rows with the 'local' sentinel.
	// runs AFTER cross-file resolution so the symbol stable_ids
	// referenced by api_endpoints point at resolved handlers where
	// possible. fails soft — cross-language tracing degrades
	// gracefully if something is wrong with the api_endpoints table.
	private stepLinkCrossLanguageApis(state: IndexState): void {
		try {
			const result = linkInRepoApiEndpoints(this.store)
			if (result.edgesCreated > 0) {
				log.debug(`cross-language linker: wrote ${result.edgesCreated} edges`)
			}
		} catch (e) {
			state.warnings.push(`cross-language linking failed: ${e}`)
			log.warn(`cross-language linking failed: ${e}`)
		}

		// proto channel of the general cross-language linker (#10).
		// matches symbol names against message/service/rpc definitions
		// in any .proto file under the project. first channel to ship;
		// graphql / sql / queues / env vars follow per-channel.
		try {
			linkProtoSymbols(this.store, this.projectRoot)
		} catch (e) {
			state.warnings.push(`proto linking failed: ${e}`)
			log.warn(`proto linking failed: ${e}`)
		}
	}

	// step 6.5: test ↔ source mapping. depends on imports + edges from
	// step 6, runs before subsystem detection so per-cluster coverage
	// stats can read test_links. wrapped in try/catch so a failure here
	// does not abort the rest of the index pipeline.
	private async stepMapTests(state: IndexState): Promise<void> {
		try {
			const { runTestMapping } = await import('./test-mapping.js')
			const stats = runTestMapping(this.store)
			log.debug(
				`test-mapping stats: ${stats.testFiles} test files, ${stats.imported} imported, ${stats.called} called`,
			)
		} catch (e) {
			state.warnings.push(`test-mapping failed: ${e}`)
			log.warn(`test-mapping failed: ${e}`)
		}
	}

	// step 7: embedding pipeline (optional, --no-embed skips).
	private async stepEmbedSymbols(_state: IndexState, opts: IndexOptions | undefined): Promise<void> {
		if (opts?.noEmbed) return
		try {
			const { runEmbeddingPipeline } = await import('../embeddings/embed-pipeline.js')
			const embedResult = await runEmbeddingPipeline(this.store, this.projectRoot)
			if (embedResult.embedded > 0) {
				log.info(`embedded ${embedResult.embedded} symbols (${embedResult.skipped} cached)`)
			}
		} catch (e) {
			log.warn(`embedding pipeline failed: ${e}`)
		}
	}

	// step 8: LLM summaries (optional, --no-summarize skips).
	private async stepSummarizeSymbols(
		_state: IndexState,
		opts: IndexOptions | undefined,
	): Promise<void> {
		if (opts?.noSummarize) return
		try {
			const { runSummaryPipeline } = await import('../llm/summary-pipeline.js')
			const summaryResult = await runSummaryPipeline(this.store, this.projectRoot)
			if (summaryResult.generated > 0 || summaryResult.fileSummaries > 0) {
				log.info(
					`summarized ${summaryResult.generated} symbols, ${summaryResult.fileSummaries} files (${summaryResult.cached} cached)`,
				)
			}
		} catch (e) {
			log.debug(`summary pipeline skipped: ${e}`)
		}
	}

	// precompute the set of generated / mock files once so flow-detection
	// and duplicate-detection both skip them. path match short-circuits
	// before any i/o, so only non-matching files pay the header-read cost.
	private stepComputeGeneratedCodeFilter(state: IndexState): void {
		const ids = findGeneratedFileIds(this.store, this.projectRoot)
		state.generatedFileIds = ids
		if (ids.size > 0) {
			log.info(`generated-code filter: ${ids.size} files flagged (mock/fake/codegen)`)
		}
	}

	// step 9: flow detection (receives generated-code filter).
	private async stepDetectFlows(
		state: IndexState,
		opts: IndexOptions | undefined,
	): Promise<void> {
		const t = performance.now()
		try {
			const { runFlowPipeline } = await import('../llm/flow-pipeline.js')
			const flowResult = await runFlowPipeline(this.store, {
				skipLLM: opts?.noSummarize,
				excludeFileIds: state.generatedFileIds,
			})
			log.info(
				`flow detection: ${flowResult.detected} flows (${flowResult.named} named) in ${(performance.now() - t).toFixed(0)}ms`,
			)
		} catch (e) {
			log.debug(`flow detection skipped: ${e}`)
		}
	}

	// step 10: duplicate detection (receives generated-code filter).
	private stepDetectDuplicates(state: IndexState): void {
		const t = performance.now()
		try {
			const dupCount = detectDuplicatesFromEmbeddings(this.store, 0.92, 100, {
				excludeFileIds: state.generatedFileIds,
			})
			log.info(`duplicate detection: ${dupCount} pairs in ${(performance.now() - t).toFixed(0)}ms`)
		} catch (e) {
			log.warn(`duplicate detection failed: ${e}`)
		}
	}

	// step 11: subsystem detection (louvain clustering over file graph).
	private async stepDetectSubsystems(
		_state: IndexState,
		opts: IndexOptions | undefined,
	): Promise<void> {
		const t = performance.now()
		try {
			const { runSubsystemPipeline } = await import('../llm/subsystem-pipeline.js')
			const subResult = await runSubsystemPipeline(
				this.store,
				getCurrentCommit(this.projectRoot),
				{ skipLLM: opts?.noSummarize, withCoChange: opts?.withCoChange },
			)
			if (!subResult.skipped) {
				log.info(
					`subsystem detection: ${subResult.clusters} clusters (${subResult.described} described, modularity ${subResult.partitionModularity.toFixed(2)}) in ${(performance.now() - t).toFixed(0)}ms`,
				)
			}
		} catch (e) {
			log.warn(`subsystem detection failed: ${e}`)
		}
	}

	// optional: github pr + issue ingest, gated behind --with-github.
	// off by default because it shells out to the gh cli and pings the
	// github api — neither is wanted during normal local indexing.
	private async stepIngestGitHub(
		state: IndexState,
		opts: IndexOptions | undefined,
	): Promise<void> {
		if (!opts?.withGitHub) return
		try {
			const { ingestGitHub } = await import('./github-ingest.js')
			const result = ingestGitHub(this.projectRoot, this.store)
			if (result.skipped) {
				log.info(`github ingest: skipped (${result.reason})`)
			} else {
				log.info(`github ingest: ${result.prsFetched} prs, ${result.issuesFetched} issues`)
			}
		} catch (e) {
			state.warnings.push(`github ingest failed: ${e}`)
			log.warn(`github ingest failed: ${e}`)
		}
	}

	// step 12: update atlas_meta with the commit/branch/config hash the
	// current index was built against. drives change detection on the
	// next run.
	private stepFinalizeMetadata(): void {
		const commit = getCurrentCommit(this.projectRoot)
		const branch = getCurrentBranch(this.projectRoot)
		const configHash = computeConfigHash(this.projectRoot)

		if (commit) this.store.setMeta('last_indexed_commit', commit)
		if (branch) this.store.setMeta('last_branch', branch)
		this.store.setMeta('config_hash', configHash)
		this.store.setMeta('last_indexed_at', String(Date.now()))
	}

	private dryRunResult(state: IndexState): IndexResult {
		return {
			filesTotal: state.discovered.length,
			filesAdded: state.changes.added.length,
			filesModified: state.changes.modified.length,
			filesDeleted: state.changes.deleted.length,
			filesCached:
				state.discovered.length - state.changes.added.length - state.changes.modified.length,
			symbols: 0,
			edges: 0,
			references: 0,
			duration: performance.now() - state.start,
			warnings: state.warnings,
		}
	}
}

function emptyChangeSet(): ChangeSet {
	return {
		added: [],
		modified: [],
		deleted: [],
		renames: [],
		configChanged: false,
		branchChanged: false,
		isFullReindex: false,
	}
}

