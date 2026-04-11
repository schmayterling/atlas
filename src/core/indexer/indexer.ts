import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { AtlasConfig } from '../../shared/config.js'
import { contentHash, stableSymbolId } from '../../shared/identity.js'
import { log } from '../../shared/logger.js'
import type { IndexResult } from '../../shared/types.js'
import { getLanguageForExtension, parseSource } from '../parser/parser-manager.js'
import { extractTypeScript } from '../parser/extractors/typescript.js'
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

	async index(opts?: { force?: boolean; dryRun?: boolean; noEmbed?: boolean }): Promise<IndexResult> {
		const start = performance.now()
		const warnings: string[] = []

		// step 1: discover files
		log.info('discovering files...')
		const discovered = discoverFiles(this.projectRoot, this.config)
		log.info(`found ${discovered.length} files`)

		// step 2: detect changes
		let changes = detectChanges(this.projectRoot, discovered, this.store)

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

		// step 3: dry run
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

		if (totalChanged === 0) {
			log.info('no changes detected')
			return {
				filesTotal: discovered.length,
				filesAdded: 0,
				filesModified: 0,
				filesDeleted: 0,
				filesCached: discovered.length,
				symbols: this.store.getSymbolCount(),
				edges: this.store.getEdgeCount(),
				references: this.store.getReferenceCount(),
				duration: performance.now() - start,
				warnings,
			}
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

					const tree = parseSource(source, parserLang)
					const result = extractTypeScript(tree, filePath, source)
					const fileId = this.store.insertFile(filePath, hash, fileInfo.language, fileInfo.sizeBytes)

					// build a lookup map for O(1) kind resolution instead of O(n) per symbol
					const kindByQName = new Map(
						result.symbols.map((s) => [s.qualifiedName, s.kind]),
					)

					for (const sym of result.symbols) {
						const sid = stableSymbolId(filePath, sym.kind, sym.qualifiedName)
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

					absolutePaths.push(fileInfo.absolutePath)
				} catch (e) {
					warnings.push(`failed to index ${filePath}: ${e}`)
					log.warn(`failed to index ${filePath}: ${e}`)
				}
			}
		})

		// step 6: cross-file resolution via TS compiler API
		log.info('resolving cross-file references...')
		try {
			// clean stale cross-file edges (file_id IS NULL) before re-inserting
			this.store.deleteCrossFileEdges()

			const resolved = resolveProject(this.projectRoot, absolutePaths, this.store)

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

		// step 7: embedding pipeline (optional)
		if (!opts?.noEmbed) {
			try {
				const { runEmbeddingPipeline } = await import('../embeddings/embed-pipeline.js')
				const embedResult = await runEmbeddingPipeline(this.store)
				if (embedResult.embedded > 0) {
					log.info(`embedded ${embedResult.embedded} symbols (${embedResult.skipped} cached)`)
				}
			} catch (e) {
				log.warn(`embedding pipeline failed: ${e}`)
			}
		}

		// step 8: update metadata
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
