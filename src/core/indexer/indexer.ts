import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { AtlasConfig } from '../../shared/config.js'
import { contentHash, stableSymbolId } from '../../shared/identity.js'
import { log } from '../../shared/logger.js'
import type { IndexResult } from '../../shared/types.js'
import { getLanguageForExtension, parseSource } from '../parser/parser-manager.js'
import { getExtractor } from '../parser/extractor-registry.js'
import type { AtlasStore } from '../storage/store.js'
import {
	computeConfigHash,
	detectChanges,
	getCurrentBranch,
	getCurrentCommit,
} from './change-detector.js'
import { discoverFiles } from './file-discovery.js'
import { resolveProject } from './ts-resolver.js'

export class Indexer {
	constructor(
		private projectRoot: string,
		private config: AtlasConfig,
		private store: AtlasStore,
	) {}

	async index(opts?: {
		force?: boolean
		dryRun?: boolean
		noEmbed?: boolean
		noSummarize?: boolean
		withCoChange?: boolean
	}): Promise<IndexResult> {
		const start = performance.now()
		const warnings: string[] = []

		// step 1: discover files
		let t = performance.now()
		const discovered = discoverFiles(this.projectRoot, this.config)
		log.debug(`file discovery: ${(performance.now() - t).toFixed(0)}ms`)
		log.info(`found ${discovered.length} files`)

		// step 2: detect changes
		t = performance.now()
		let changes = detectChanges(this.projectRoot, discovered, this.store)
		log.debug(`change detection: ${(performance.now() - t).toFixed(0)}ms`)

		if (opts?.force) {
			// delete ALL existing files (cascade cleans symbols/edges), then re-add everything
			const existingPaths = this.store.getAllFiles().map((f) => f.path)

			changes = {
				added: discovered.map((f) => f.path),
				modified: [],
				deleted: existingPaths,
				configChanged: false,
				branchChanged: false,
				isFullReindex: true,
			}
		}

		const totalChanged = changes.added.length + changes.modified.length + changes.deleted.length
		log.info(
			`changes: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted`,
		)

		// step 3: dry run -- must come before any state mutation, including
		// the --full git table reset and the git history ingestion. a dry
		// run reports what would happen without touching persisted data.
		if (opts?.dryRun) {
			return {
				filesTotal: discovered.length,
				filesAdded: changes.added.length,
				filesModified: changes.modified.length,
				filesDeleted: changes.deleted.length,
				filesCached: discovered.length - changes.added.length - changes.modified.length,
				symbols: 0,
				edges: 0,
				references: 0,
				duration: performance.now() - start,
				warnings,
			}
		}

		// --full git history reset: drop every git-derived row + watermark
		// in one transaction so the next ingestion rebuilds from scratch
		// under the current path filter. only runs after the dry-run guard.
		if (opts?.force) {
			const { clearGitHistory } = await import('./git-history.js')
			clearGitHistory(this.store)
		}

		// step 3.5: git history ingestion (runs even when totalChanged === 0
		// so a clean tree still refreshes commit data after new commits land).
		// the discovered file set scopes ingestion: only file_changes whose
		// path matches a currently-discovered file (or rename source) are
		// kept, which filters out noise from once-tracked-now-gitignored
		// artifacts. an empty discovered set means "ingest everything"; we
		// pass undefined rather than an empty Set so the filter doesn't
		// silently skip every commit.
		try {
			const { ingestGitHistory } = await import('./git-history.js')
			const relevantPaths =
				discovered.length > 0 ? new Set(discovered.map((f) => f.path)) : undefined
			const gitResult = ingestGitHistory(this.projectRoot, this.store, relevantPaths)
			if (gitResult.commitsAdded > 0) {
				log.info(`git: +${gitResult.commitsAdded} commits, ${gitResult.fileChangesAdded} file changes`)
			} else if (gitResult.skipped && gitResult.reason && gitResult.reason !== 'up to date') {
				log.debug(`git history: ${gitResult.reason}`)
			}
		} catch (e) {
			log.warn(`git history ingestion failed: ${e}`)
		}

		// no longer early-return on totalChanged === 0. the parsing/extract
		// path is naturally a no-op when nothing changed (steps 4-6 see empty
		// inputs), but the post-processing pipelines (embed, summarize, flow,
		// dup, subsystem) need to run so newly-added pipelines can backfill
		// against an existing index without forcing --full.
		if (totalChanged === 0) {
			log.info('no file changes; running post-processing pipelines only')
		}

		// step 4: delete records for deleted + modified files
		const toDelete = [...changes.deleted, ...changes.modified]
		if (toDelete.length > 0) {
			log.debug(`deleting records for ${toDelete.length} files`)
			this.store.deleteFilesByPaths(toDelete)
		}

		// step 5: parse and index added + modified files
		const toProcess = [...changes.added, ...changes.modified]
		const discoveredByPath = new Map(discovered.map((f) => [f.path, f]))
		const absolutePaths: string[] = []

		let symbolCount = 0
		let edgeCount = 0
		const processedStableIds: string[] = []
		t = performance.now()

		log.info(`indexing ${toProcess.length} files...`)

		this.store.bulkInsert(() => {
			for (const filePath of toProcess) {
				const fileInfo = discoveredByPath.get(filePath)
				if (!fileInfo) continue

				try {
					const source = readFileSync(fileInfo.absolutePath, 'utf-8')
					const hash = contentHash(source)

					const ext = extname(filePath)
					const parserLang = getLanguageForExtension(ext)
					if (!parserLang) {
						warnings.push(`unsupported extension: ${ext} (${filePath})`)
						continue
					}

					const extractor = getExtractor(parserLang)
					if (!extractor) {
						warnings.push(`no extractor for language: ${parserLang} (${filePath})`)
						continue
					}

					const tree = parseSource(source, parserLang)
					const result = extractor.extract(tree, filePath, source)
					const fileId = this.store.insertFile(filePath, hash, fileInfo.language, fileInfo.sizeBytes)

					// build a lookup map for O(1) kind resolution instead of O(n) per symbol
					const kindByQName = new Map(
						result.symbols.map((s) => [s.qualifiedName, s.kind]),
					)

					for (const sym of result.symbols) {
						const sid = stableSymbolId(filePath, sym.kind, sym.qualifiedName)
						processedStableIds.push(sid)
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
						symbolCount++
					}

					// insert intra-file edges (contains, etc.)
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
						edgeCount++
					}

					// store API endpoints if extracted
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
						absolutePaths.push(fileInfo.absolutePath)
					}
				} catch (e) {
					warnings.push(`failed to index ${filePath}: ${e}`)
					log.warn(`failed to index ${filePath}: ${e}`)
				}
			}
		})
		log.debug(`parsing + extraction: ${(performance.now() - t).toFixed(0)}ms`)

		// step 6: cross-file resolution via TS compiler API. skipped only
		// when there is nothing to process AND no deletions to clean up;
		// the resolver itself is expensive but it also owns cleanup of
		// stale cross-file edges that point to removed symbols.
		t = performance.now()
		if (absolutePaths.length === 0 && changes.deleted.length === 0) {
			log.debug('skipping cross-file resolution (no files processed, no deletions)')
		} else {
			log.info('resolving cross-file references...')
			try {
				// delete cross-file edges only for symbols in processed files (not all)
				if (processedStableIds.length > 0) {
					this.store.deleteCrossFileEdgesForSources(processedStableIds)
				}

				// when files were deleted in step 4 their symbols cascaded away
				// but cross-file edges pointing INTO those symbols (sourceId or
				// targetId referencing a now-missing stable_id) are orphaned.
				// rebuild from the current TS compiler view of the project to
				// drop the stale rows. only runs when we have something to resolve.
				const resolved =
					absolutePaths.length > 0
						? resolveProject(this.projectRoot, absolutePaths, this.store)
						: { edges: [], imports: [] }

				this.store.bulkInsert(() => {
					for (const edge of resolved.edges) {
						this.store.insertEdge({
							sourceId: edge.sourceStableId,
							targetId: edge.targetStableId,
							kind: edge.kind,
							fileId: null, // cross-file edges
							line: edge.line,
							col: edge.col,
							confidence: edge.confidence,
							metadata: null,
						})
						edgeCount++
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
				warnings.push(`cross-file resolution failed: ${e}`)
				log.warn(`cross-file resolution failed: ${e}`)
			}
			log.debug(`cross-file resolution: ${(performance.now() - t).toFixed(0)}ms`)
		}

		// step 7: embedding pipeline (optional)
		if (!opts?.noEmbed) {
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

		// step 8: LLM summaries (optional, requires Ollama chat model)
		if (!opts?.noSummarize) {
			try {
				const { runSummaryPipeline } = await import('../llm/summary-pipeline.js')
				const summaryResult = await runSummaryPipeline(this.store, this.projectRoot)
				if (summaryResult.generated > 0 || summaryResult.fileSummaries > 0) {
					log.info(`summarized ${summaryResult.generated} symbols, ${summaryResult.fileSummaries} files (${summaryResult.cached} cached)`)
				}
			} catch (e) {
				log.debug(`summary pipeline skipped: ${e}`)
			}
		}

		// step 9: flow detection
		t = performance.now()
		try {
			const { runFlowPipeline } = await import('../llm/flow-pipeline.js')
			const flowResult = await runFlowPipeline(this.store, { skipLLM: opts?.noSummarize })
			log.info(`flow detection: ${flowResult.detected} flows (${flowResult.named} named) in ${(performance.now() - t).toFixed(0)}ms`)
		} catch (e) {
			log.debug(`flow detection skipped: ${e}`)
		}

		// step 10: duplicate detection
		t = performance.now()
		try {
			const { detectDuplicatesFromEmbeddings } = await import('../queries/duplicate-detection.js')
			const dupCount = detectDuplicatesFromEmbeddings(this.store)
			log.info(`duplicate detection: ${dupCount} pairs in ${(performance.now() - t).toFixed(0)}ms`)
		} catch (e) {
			log.warn(`duplicate detection failed: ${e}`)
		}

		// step 11: subsystem detection
		t = performance.now()
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

		// step 12: update metadata
		const commit = getCurrentCommit(this.projectRoot)
		const branch = getCurrentBranch(this.projectRoot)
		const configHash = computeConfigHash(this.projectRoot)

		if (commit) this.store.setMeta('last_indexed_commit', commit)
		if (branch) this.store.setMeta('last_branch', branch)
		this.store.setMeta('config_hash', configHash)
		this.store.setMeta('last_indexed_at', String(Date.now()))

		const duration = performance.now() - start
		log.info(`indexing complete in ${(duration / 1000).toFixed(1)}s`)

		return {
			filesTotal: discovered.length,
			filesAdded: changes.added.length,
			filesModified: changes.modified.length,
			filesDeleted: changes.deleted.length,
			filesCached: discovered.length - changes.added.length - changes.modified.length,
			symbols: this.store.getSymbolCount(),
			edges: this.store.getEdgeCount(),
			references: this.store.getReferenceCount(),
			duration,
			warnings,
		}
	}
}
