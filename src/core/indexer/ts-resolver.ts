import { relative } from 'node:path'
import ts from 'typescript'
import { stableSymbolId } from '../../shared/identity.js'
import { log } from '../../shared/logger.js'
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

export function resolveProject(
	projectRoot: string,
	filePaths: string[],
	store: AtlasStore,
): { edges: ResolvedEdge[]; imports: ResolvedImport[] } {
	if (filePaths.length === 0) return { edges: [], imports: [] }

	const edges: ResolvedEdge[] = []
	const imports: ResolvedImport[] = []

	// find and parse tsconfig
	const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json')
	let compilerOptions: ts.CompilerOptions = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowJs: true,
		noEmit: true,
	}

	if (configPath) {
		const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
		if (!configFile.error) {
			const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot)
			compilerOptions = { ...parsed.options, noEmit: true }
		}
	}

	// create program
	let program: ts.Program
	try {
		program = ts.createProgram(filePaths, compilerOptions)
	} catch (e) {
		log.warn(`failed to create TS program: ${e}`)
		return { edges: [], imports: [] }
	}

	const checker = program.getTypeChecker()

	// process each source file
	for (const filePath of filePaths) {
		const sourceFile = program.getSourceFile(filePath)
		if (!sourceFile) continue

		const relPath = toForwardSlash(relative(projectRoot, filePath))
		const fileRecord = store.getFileByPath(relPath)
		if (!fileRecord) continue

		resolveImports(sourceFile, relPath, compilerOptions, projectRoot, fileRecord.id, store, imports)
		resolveReferences(sourceFile, checker, relPath, projectRoot, fileRecord.id, store, edges)
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
	ts.forEachChild(sourceFile, function visit(node) {
		if (ts.isImportDeclaration(node)) {
			const specifier = node.moduleSpecifier
			if (!ts.isStringLiteral(specifier)) return

			const importPath = specifier.text
			const isTypeOnly = node.importClause?.isTypeOnly ?? false
			const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1

			// resolve module to file
			const result = ts.resolveModuleName(importPath, sourceFile.fileName, options, ts.sys)
			let targetFileId: number | null = null

			if (result.resolvedModule) {
				const resolvedPath = toForwardSlash(
					relative(projectRoot, result.resolvedModule.resolvedFileName),
				)
				const targetFile = store.getFileByPath(resolvedPath)
				targetFileId = targetFile?.id ?? null
			}

			imports.push({
				sourceFileId,
				targetFileId,
				importPath,
				isTypeOnly,
				line,
			})
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
		const symbol = checker.getSymbolAtLocation(node.expression)
		if (!symbol) return

		const decl = symbol.valueDeclaration ?? symbol.declarations?.[0]
		if (!decl) return

		const declFile = decl.getSourceFile()
		const declRelPath = toForwardSlash(relative(projectRoot, declFile.fileName))

		// skip calls to external libraries
		if (declRelPath.includes('node_modules')) return

		// find the containing function at the call site
		const containingFn = findContainingFunction(node, sourceFile, relPath)
		if (!containingFn) return

		// find the target symbol name
		const targetName = symbol.getName()
		const targetKind = getSymbolKind(decl)
		const targetQName = buildQualifiedName(declRelPath, decl, targetName)

		const sourceId = stableSymbolId(relPath, containingFn.kind, containingFn.qname)
		const targetId = stableSymbolId(declRelPath, targetKind, targetQName)

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
		const symbol = checker.getSymbolAtLocation(node.typeName)
		if (!symbol) return

		const decl = symbol.declarations?.[0]
		if (!decl) return

		const declFile = decl.getSourceFile()
		const declRelPath = toForwardSlash(relative(projectRoot, declFile.fileName))

		// skip references to node_modules
		if (declRelPath.includes('node_modules')) return

		const containingDecl = findContainingDeclaration(node, sourceFile, relPath)
		if (!containingDecl) return

		const targetName = symbol.getName()
		const targetKind = getSymbolKind(decl)
		const targetQName = buildQualifiedName(declRelPath, decl, targetName)

		const sourceId = stableSymbolId(relPath, containingDecl.kind, containingDecl.qname)
		const targetId = stableSymbolId(declRelPath, targetKind, targetQName)

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
			const symbol = checker.getSymbolAtLocation(expr.expression)
			if (!symbol) continue

			const decl = symbol.declarations?.[0]
			if (!decl) continue

			const declFile = decl.getSourceFile()
			const declRelPath = toForwardSlash(relative(projectRoot, declFile.fileName))
			if (declRelPath.includes('node_modules')) continue

			// find the class/interface being declared
			const parentDecl = node.parent
			if (!parentDecl) continue

			const parentName = (parentDecl as ts.ClassDeclaration).name?.getText()
			if (!parentName) continue

			const parentKind = ts.isClassDeclaration(parentDecl) ? 'class' : 'interface'
			const parentQName = `${relPath}::${parentName}`
			const sourceId = stableSymbolId(relPath, parentKind as 'class' | 'interface', parentQName)

			const targetName = symbol.getName()
			const targetKind = getSymbolKind(decl)
			const targetQName = buildQualifiedName(declRelPath, decl, targetName)
			const targetId = stableSymbolId(declRelPath, targetKind, targetQName)

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
	// check if it's a class member
	const parent = decl.parent
	if (parent && ts.isClassDeclaration(parent) && parent.name) {
		return `${relPath}::${parent.name.getText()}.${name}`
	}
	if (parent && ts.isInterfaceDeclaration(parent) && parent.name) {
		return `${relPath}::${parent.name.getText()}.${name}`
	}
	return `${relPath}::${name}`
}

function toForwardSlash(p: string): string {
	return p.replace(/\\/g, '/')
}
