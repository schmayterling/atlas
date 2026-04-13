import { relative } from 'node:path'
import ts from 'typescript'
import { stableSymbolId } from '../../shared/identity.js'
import { log } from '../../shared/logger.js'
import { toForwardSlash } from '../../shared/paths.js'
import type { Confidence, EdgeKind, SymbolKind } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'

export interface ResolvedEdge {
	sourceStableId: string
	targetStableId: string
	kind: EdgeKind
	line: number
	col: number
	confidence: Confidence
}

export interface ResolvedImport {
	sourceFileId: number
	targetFileId: number | null
	importPath: string
	isTypeOnly: boolean
	line: number
}

// the nearest tsconfig directory for a file. used by the monorepo
// bucketing in resolveProject: each file lives under exactly one
// tsconfig, and each tsconfig drives one ts.Program. cached per
// directory so a fan of files in the same package only walks the
// filesystem once.
function findNearestTsconfig(fromDir: string, cache: Map<string, string | null>): string | null {
	const cached = cache.get(fromDir)
	if (cached !== undefined) return cached
	let dir = fromDir
	while (true) {
		const candidate = `${dir}/tsconfig.json`
		if (ts.sys.fileExists(candidate)) {
			cache.set(fromDir, candidate)
			return candidate
		}
		const parent = dir.replace(/[\\/][^\\/]+$/, '')
		if (parent === dir || parent === '') {
			cache.set(fromDir, null)
			return null
		}
		dir = parent
	}
}

// bucket file paths by their nearest tsconfig. files that share a
// tsconfig are resolved together in one ts.Program so workspace-local
// path aliases (paths, baseUrl) work. files without any tsconfig fall
// into a single `null` bucket that uses default compiler options.
function bucketByTsconfig(filePaths: string[]): Map<string | null, string[]> {
	const cache = new Map<string, string | null>()
	const buckets = new Map<string | null, string[]>()
	for (const file of filePaths) {
		const dir = file.replace(/[\\/][^\\/]+$/, '')
		const config = findNearestTsconfig(dir, cache)
		const key: string | null = config ?? null
		const bucket = buckets.get(key)
		if (bucket) bucket.push(file)
		else buckets.set(key, [file])
	}
	return buckets
}

// parse a tsconfig path into TS compiler options. centralised so both
// the bucketed and the fallback (null config) paths go through the
// same parser with the same safety fallbacks.
function readCompilerOptions(configPath: string | null, projectRoot: string): ts.CompilerOptions {
	const defaults: ts.CompilerOptions = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowJs: true,
		noEmit: true,
	}
	if (!configPath) return defaults
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
	if (configFile.error) return defaults
	const configDir = configPath.replace(/[\\/][^\\/]+$/, '') || projectRoot
	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir)
	return { ...parsed.options, noEmit: true }
}

export function resolveProject(
	projectRoot: string,
	filePaths: string[],
	store: AtlasStore,
): { edges: ResolvedEdge[]; imports: ResolvedImport[] } {
	if (filePaths.length === 0) return { edges: [], imports: [] }

	const edges: ResolvedEdge[] = []
	const imports: ResolvedImport[] = []

	// group files by nearest tsconfig so a monorepo with apps/* each
	// owning its own tsconfig.json resolves path aliases correctly.
	// single-tsconfig repos (including atlas itself) fall into exactly
	// one bucket and the behaviour is identical to the previous single
	// ts.Program path. stable ids stay relative to projectRoot (the
	// identity root) regardless of which bucket owns a file.
	const buckets = bucketByTsconfig(filePaths)

	for (const [configPath, bucketFiles] of buckets) {
		const compilerOptions = readCompilerOptions(configPath, projectRoot)

		let program: ts.Program
		try {
			program = ts.createProgram(bucketFiles, compilerOptions)
		} catch (e) {
			log.warn(`failed to create TS program for ${configPath ?? '<no tsconfig>'}: ${e}`)
			continue
		}

		const checker = program.getTypeChecker()

		for (const filePath of bucketFiles) {
			const sourceFile = program.getSourceFile(filePath)
			if (!sourceFile) continue

			const relPath = toForwardSlash(relative(projectRoot, filePath))
			const fileRecord = store.getFileByPath(relPath)
			if (!fileRecord) continue

			resolveImports(
				sourceFile,
				relPath,
				compilerOptions,
				projectRoot,
				fileRecord.id,
				store,
				imports,
			)
			resolveReferences(sourceFile, checker, relPath, projectRoot, fileRecord.id, store, edges)
		}
	}

	return { edges, imports }
}

function resolveImports(
	sourceFile: ts.SourceFile,
	_relPath: string,
	options: ts.CompilerOptions,
	projectRoot: string,
	sourceFileId: number,
	store: AtlasStore,
	imports: ResolvedImport[],
) {
	const pushImport = (importPath: string, isTypeOnly: boolean, node: ts.Node) => {
		const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
		const result = ts.resolveModuleName(importPath, sourceFile.fileName, options, ts.sys)
		let targetFileId: number | null = null
		if (result.resolvedModule) {
			const resolvedPath = toForwardSlash(
				relative(projectRoot, result.resolvedModule.resolvedFileName),
			)
			targetFileId = store.getFileByPath(resolvedPath)?.id ?? null
		}
		imports.push({ sourceFileId, targetFileId, importPath, isTypeOnly, line })
	}

	ts.forEachChild(sourceFile, function visit(node) {
		if (ts.isImportDeclaration(node)) {
			const specifier = node.moduleSpecifier
			if (ts.isStringLiteral(specifier)) {
				pushImport(specifier.text, node.importClause?.isTypeOnly ?? false, node)
			}
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			pushImport((node.arguments[0] as ts.StringLiteral).text, false, node)
		}

		ts.forEachChild(node, visit)
	})
}

function resolveReferences(
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	relPath: string,
	projectRoot: string,
	_fileId: number,
	store: AtlasStore,
	edges: ResolvedEdge[],
) {
	ts.forEachChild(sourceFile, function visit(node) {
		// resolve call expressions
		if (ts.isCallExpression(node)) {
			resolveCallExpression(node, sourceFile, checker, relPath, projectRoot, store, edges)
		}

		// resolve type references
		if (ts.isTypeReferenceNode(node)) {
			resolveTypeReference(node, sourceFile, checker, relPath, projectRoot, store, edges)
		}

		// resolve heritage clauses (extends/implements)
		if (ts.isHeritageClause(node)) {
			resolveHeritageClause(node, sourceFile, checker, relPath, projectRoot, store, edges)
		}

		ts.forEachChild(node, visit)
	})
}

function resolveCallExpression(
	node: ts.CallExpression,
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	relPath: string,
	projectRoot: string,
	store: AtlasStore,
	edges: ResolvedEdge[],
) {
	try {
		const sym = checker.getSymbolAtLocation(node.expression)
		if (!sym) return

		const resolved = resolveOriginalSymbol(sym, checker)
		if (!resolved) return

		const declFile = resolved.decl.getSourceFile()
		const declRelPath = toForwardSlash(relative(projectRoot, declFile.fileName))

		if (declRelPath.includes('node_modules')) return

		const containingFn = findContainingFunction(node, sourceFile, relPath)
		if (!containingFn) return

		const targetName = resolved.symbol.getName()
		const targetKind = getSymbolKind(resolved.decl)
		const existing = store.findSymbolInFile(declRelPath, targetName, targetKind)
		const targetId = existing
			? existing.stableId
			: stableSymbolId(declRelPath, targetKind, buildQualifiedName(declRelPath, resolved.decl, targetName))

		const sourceId = stableSymbolId(relPath, containingFn.kind, containingFn.qname)

		const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart())

		edges.push({
			sourceStableId: sourceId,
			targetStableId: targetId,
			kind: 'calls',
			line: pos.line + 1,
			col: pos.character,
			confidence: 'resolved',
		})
	} catch (e) {
		log.debug(`skipped call resolution at ${relPath}: ${e}`)
	}
}

function resolveTypeReference(
	node: ts.TypeReferenceNode,
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	relPath: string,
	projectRoot: string,
	store: AtlasStore,
	edges: ResolvedEdge[],
) {
	try {
		const sym = checker.getSymbolAtLocation(node.typeName)
		if (!sym) return

		const resolved = resolveOriginalSymbol(sym, checker)
		if (!resolved) return

		const declFile = resolved.decl.getSourceFile()
		const declRelPath = toForwardSlash(relative(projectRoot, declFile.fileName))

		if (declRelPath.includes('node_modules')) return

		const containingDecl = findContainingDeclaration(node, sourceFile, relPath)
		if (!containingDecl) return

		const targetName = resolved.symbol.getName()
		const targetKind = getSymbolKind(resolved.decl)
		const existing = store.findSymbolInFile(declRelPath, targetName, targetKind)
		const targetId = existing
			? existing.stableId
			: stableSymbolId(declRelPath, targetKind, buildQualifiedName(declRelPath, resolved.decl, targetName))

		const sourceId = stableSymbolId(relPath, containingDecl.kind, containingDecl.qname)

		const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart())

		edges.push({
			sourceStableId: sourceId,
			targetStableId: targetId,
			kind: 'type_ref',
			line: pos.line + 1,
			col: pos.character,
			confidence: 'resolved',
		})
	} catch (e) {
		log.debug(`skipped resolution at ${relPath}: ${e}`)
	}
}

function resolveHeritageClause(
	node: ts.HeritageClause,
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	relPath: string,
	projectRoot: string,
	store: AtlasStore,
	edges: ResolvedEdge[],
) {
	const edgeKind: EdgeKind =
		node.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'type_ref'

	for (const expr of node.types) {
		try {
			const sym = checker.getSymbolAtLocation(expr.expression)
			if (!sym) continue

			const resolved = resolveOriginalSymbol(sym, checker)
			if (!resolved) continue

			const declFile = resolved.decl.getSourceFile()
			const declRelPath = toForwardSlash(relative(projectRoot, declFile.fileName))
			if (declRelPath.includes('node_modules')) continue

			const parentDecl = node.parent
			if (!parentDecl) continue

			const parentName = (parentDecl as ts.ClassDeclaration).name?.getText()
			if (!parentName) continue

			const parentKind = ts.isClassDeclaration(parentDecl) ? 'class' : 'interface'
			const parentQName = `${relPath}::${parentName}`
			const sourceId = stableSymbolId(relPath, parentKind as 'class' | 'interface', parentQName)

			const targetName = resolved.symbol.getName()
			const targetKind = getSymbolKind(resolved.decl)
			const existing = store.findSymbolInFile(declRelPath, targetName, targetKind)
			const targetId = existing
				? existing.stableId
				: stableSymbolId(declRelPath, targetKind, buildQualifiedName(declRelPath, resolved.decl, targetName))

			const pos = sourceFile.getLineAndCharacterOfPosition(expr.getStart())

			edges.push({
				sourceStableId: sourceId,
				targetStableId: targetId,
				kind: edgeKind,
				line: pos.line + 1,
				col: pos.character,
				confidence: 'resolved',
			})
		} catch {
			// skip
		}
	}
}

// --- helpers ---

interface ContainingInfo {
	kind: SymbolKind
	qname: string
}

function findContainingFunction(
	node: ts.Node,
	sourceFile: ts.SourceFile,
	relPath: string,
): ContainingInfo | null {
	let current: ts.Node | undefined = node.parent
	while (current) {
		if (ts.isFunctionDeclaration(current) && current.name) {
			return { kind: 'function', qname: `${relPath}::${current.name.getText()}` }
		}
		if (ts.isMethodDeclaration(current) && current.name) {
			const className = findParentClassName(current)
			const methodName = current.name.getText()
			if (className) {
				return { kind: 'method', qname: `${relPath}::${className}.${methodName}` }
			}
			return { kind: 'method', qname: `${relPath}::${methodName}` }
		}
		if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
			const varDecl = current.parent
			if (ts.isVariableDeclaration(varDecl) && ts.isIdentifier(varDecl.name)) {
				return { kind: 'function', qname: `${relPath}::${varDecl.name.getText()}` }
			}
		}
		current = current.parent
	}
	return null
}

function findContainingDeclaration(
	node: ts.Node,
	sourceFile: ts.SourceFile,
	relPath: string,
): ContainingInfo | null {
	let current: ts.Node | undefined = node.parent
	while (current) {
		if (ts.isFunctionDeclaration(current) && current.name) {
			return { kind: 'function', qname: `${relPath}::${current.name.getText()}` }
		}
		if (ts.isClassDeclaration(current) && current.name) {
			return { kind: 'class', qname: `${relPath}::${current.name.getText()}` }
		}
		if (ts.isInterfaceDeclaration(current) && current.name) {
			return { kind: 'interface', qname: `${relPath}::${current.name.getText()}` }
		}
		if (ts.isTypeAliasDeclaration(current)) {
			return { kind: 'type', qname: `${relPath}::${current.name.getText()}` }
		}
		if (ts.isMethodDeclaration(current) && current.name) {
			const className = findParentClassName(current)
			const methodName = current.name.getText()
			if (className) {
				return { kind: 'method', qname: `${relPath}::${className}.${methodName}` }
			}
		}
		if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
			return { kind: 'variable', qname: `${relPath}::${current.name.getText()}` }
		}
		current = current.parent
	}
	return null
}

function findParentClassName(node: ts.Node): string | null {
	let current: ts.Node | undefined = node.parent
	while (current) {
		if (ts.isClassDeclaration(current) && current.name) {
			return current.name.getText()
		}
		current = current.parent
	}
	return null
}

function getSymbolKind(decl: ts.Declaration): SymbolKind {
	if (ts.isFunctionDeclaration(decl)) return 'function'
	if (ts.isClassDeclaration(decl)) return 'class'
	if (ts.isInterfaceDeclaration(decl)) return 'interface'
	if (ts.isTypeAliasDeclaration(decl)) return 'type'
	if (ts.isEnumDeclaration(decl)) return 'enum'
	if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) return 'method'
	if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) return 'property'
	if (ts.isVariableDeclaration(decl)) {
		// check if initializer is an arrow function or function expression
		// to match the extractor which stores these as 'function'
		const init = (decl as ts.VariableDeclaration).initializer
		if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
			return 'function'
		}
		return 'variable'
	}
	return 'variable'
}

function buildQualifiedName(relPath: string, decl: ts.Declaration, name: string): string {
	// walk the full parent chain to match tree-sitter's qualifiedName format
	const parents: string[] = []
	let current = decl.parent
	while (current) {
		if (ts.isClassDeclaration(current) && current.name) {
			parents.unshift(current.name.getText())
		} else if (ts.isInterfaceDeclaration(current) && current.name) {
			parents.unshift(current.name.getText())
		} else if (ts.isModuleDeclaration(current) && current.name) {
			parents.unshift(current.name.getText())
		}
		current = current.parent
	}
	if (parents.length > 0) {
		return `${relPath}::${parents.join('.')}.${name}`
	}
	return `${relPath}::${name}`
}

// follow import aliases to the original declaration.
// the TS compiler resolves imported names to their import specifier,
// not the original declaration. this follows aliases through to the source.
function resolveOriginalSymbol(
	symbol: ts.Symbol,
	checker: ts.TypeChecker,
): { symbol: ts.Symbol; decl: ts.Declaration } | null {
	let resolved = symbol
	// follow aliases (import specifiers -> original declarations)
	try {
		if (resolved.flags & ts.SymbolFlags.Alias) {
			resolved = checker.getAliasedSymbol(resolved)
		}
	} catch {
		// getAliasedSymbol can throw for unresolvable imports
	}
	const decl = resolved.valueDeclaration ?? resolved.declarations?.[0]
	if (!decl) return null
	return { symbol: resolved, decl }
}

