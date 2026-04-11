import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { AtlasConfig } from '../../shared/config.js'
import { contentHash, stableSymbolId } from '../../shared/identity.js'
import { log } from '../../shared/logger.js'
import type { IndexResult, SymbolKind } from '../../shared/types.js'
import { getLanguageForExtension, parseSource } from '../parser/parser-manager.js'
import { extractTypeScript } from '../parser/extractors/typescript.js'
import type { ExtractedSymbol } from '../parser/extractors/typescript.js'
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

	index(opts?: { force?: boolean; dryRun?: boolean }): IndexResult {
		const start = performance.now()
		const warnings: string[] = []

		// step 1: discover files
		log.info('discovering files...')
		const discovered = discoverFiles(this.projectRoot, this.config)
		log.info(`found ${discovered.length} files`)

		// step 2: detect changes
		let changes = detectChanges(this.projectRoot, discovered, this.store)

		if (opts?.force) {
			// compute stale files that exist in DB but not on disk
			const existingPaths = new Set(this.store.getAllFiles().map((f) => f.path))
			const discoveredPaths = new Set(discovered.map((f) => f.path))
			const stale = [...existingPaths].filter((p) => !discoveredPaths.has(p))

			changes = {
				added: discovered.map((f) => f.path),
				modified: [],
				deleted: stale,
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

					// determine parser language from extension
					const ext = extname(filePath)
					const parserLang = getLanguageForExtension(ext)
					if (!parserLang) {
						warnings.push(`unsupported extension: ${ext} (${filePath})`)
						continue
					}

					// parse with tree-sitter
					const tree = parseSource(source, parserLang)
					const result = extractTypeScript(tree, filePath, source)

					// insert file
					const fileId = this.store.insertFile(filePath, hash, fileInfo.language, fileInfo.sizeBytes)

					// insert symbols
					for (const sym of result.symbols) {
						const sid = stableSymbolId(filePath, sym.kind, sym.qualifiedName)
						const parentId = sym.parentQualifiedName
							? stableSymbolId(
									filePath,
									resolveParentKind(sym.parentQualifiedName, result.symbols),
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
						const sourceKind = resolveParentKind(
							edge.sourceQualifiedName,
							result.symbols,
						)
						const targetKind = resolveParentKind(
							edge.targetName,
							result.symbols,
						)
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

		// step 7: update metadata
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

// look up the kind of a symbol by its qualified name in the extraction results
function resolveParentKind(qualifiedName: string, symbols: ExtractedSymbol[]): SymbolKind {
	const sym = symbols.find((s) => s.qualifiedName === qualifiedName)
	return sym?.kind ?? 'variable'
}
