import { dirname, relative } from 'node:path'
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
		const parent = dirname(dir)
		if (parent === dir || parent === '' || parent === '.') {
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
		const config = findNearestTsconfig(dirname(file), cache)
		const key: string | null = config ?? null
		const bucket = buckets.get(key)
		if (bucket) bucket.push(file)
		else buckets.set(key, [file])
	}
	return buckets
}

// parse a tsconfig path into TS compiler options. logs read/parse
// failures so a silently-misconfigured workspace surfaces in the
// indexer output instead of degrading resolution to defaults.
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
	if (configFile.error) {
		log.warn(`ts-resolver: failed to parse ${configPath}: ${configFile.error.messageText}`)
		return defaults
	}
	const configDir = dirname(configPath) || projectRoot
	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir)
	if (parsed.errors.length > 0) {
		const first = parsed.errors[0]
		log.warn(`ts-resolver: ${configPath} has ${parsed.errors.length} config error(s), first: ${first.messageText}`)
	}
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
		processBucket(configPath, bucketFiles, projectRoot, store, edges, imports)
	}

	return { edges, imports }
}

// re-run ts.resolveModuleName against the current filesystem state
// for every imports row that has a NULL target_file_id, and update
// the row in place when the import now resolves to a known file.
//
// this repairs the incremental-index hazard where a modified file's
// step 4 delete cascades through the files.id FK and sets
// imports.target_file_id to NULL for every unchanged importer; step
// 6's resolveProject only re-resolves the modified files, so the
// importer rows stay NULL until a full reindex. see #35.
//
// the walker uses a minimal CompilerOptions (bundler resolution,
// allowJs) so it does not need to spin up a ts.Program. that keeps
// the backfill O(orphaned imports) instead of O(all files).
export function rebindNullTargetImports(
	projectRoot: string,
	store: AtlasStore,
): { scanned: number; rebound: number } {
	const rows = store.getNullTargetImports()
	if (rows.length === 0) return { scanned: 0, rebound: 0 }
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowJs: true,
		noEmit: true,
	}
	let rebound = 0
	for (const row of rows) {
		const absSource = `${projectRoot}/${row.sourceFilePath}`
		let result: ts.ResolvedModuleWithFailedLookupLocations
		try {
			result = ts.resolveModuleName(row.importPath, absSource, options, ts.sys)
		} catch (e) {
			log.debug(`rebindNullTargetImports: resolve failed for ${row.importPath}: ${e}`)
			continue
		}
		if (!result.resolvedModule) continue
		const relPath = toForwardSlash(
			relative(projectRoot, result.resolvedModule.resolvedFileName),
		)
		const target = store.getFileByPath(relPath)
		if (!target) continue
		store.updateImportTargetFileId(row.id, target.id)
		rebound++
	}
	return { scanned: rows.length, rebound }
}

// one bucket of files sharing a tsconfig. extracted into its own
// function so the ts.Program + TypeChecker + ModuleGraph (~150-300MB
// resident on a mid-size workspace) go out of scope naturally at
// iteration end instead of being retained until resolveProject
// returns. on a 30+ workspace monorepo this keeps peak RSS bounded
// to one bucket's worth of state. see #53.
function processBucket(
	configPath: string | null,
	bucketFiles: string[],
	projectRoot: string,
	store: AtlasStore,
	edges: ResolvedEdge[],
	imports: ResolvedImport[],
) {
	const compilerOptions = readCompilerOptions(configPath, projectRoot)

	let program: ts.Program
	try {
		program = ts.createProgram(bucketFiles, compilerOptions)
	} catch (e) {
		log.warn(`failed to create TS program for ${configPath ?? '<no tsconfig>'}: ${e}`)
		return
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
			// also walk the arguments for function-valued references.
			// `router.get(path, handler)` has `handler` as an identifier
			// argument; if it resolves to a function/method symbol we
			// emit a passed_as edge (not calls — the handler is not
			// invoked at the registration site). see #49.
			resolveArgumentReferences(node, sourceFile, checker, relPath, projectRoot, store, edges)
		}

		// resolve new expressions: `new Foo(...)` emits an instantiates
		// edge to the resolved class symbol. arguments are still walked
		// for passed_as so `new Router(handler)` credits the handler.
		// see #87.
		if (ts.isNewExpression(node)) {
			resolveNewExpression(node, sourceFile, checker, relPath, projectRoot, store, edges)
			if (node.arguments) {
				resolveArgumentReferencesFromArgs(
					node.arguments,
					sourceFile,
					checker,
					relPath,
					projectRoot,
					store,
					edges,
				)
			}
		}

		// resolve type references
		if (ts.isTypeReferenceNode(node)) {
			resolveTypeReference(node, sourceFile, checker, relPath, projectRoot, store, edges)
		}

		// resolve heritage clauses (extends/implements)
		if (ts.isHeritageClause(node)) {
			resolveHeritageClause(node, sourceFile, checker, relPath, projectRoot, store, edges)
		}

		// resolve structural property access: `obj.field` emits a
		// field_access edge when the checker resolves `.field` to an
		// in-repo property/method symbol. skipped when this node is
		// the callee of a call expression (handled by calls/passed_as)
		// or the operand of a new expression (handled by instantiates).
		// see #85.
		if (ts.isPropertyAccessExpression(node)) {
			resolveFieldAccess(node, sourceFile, checker, relPath, projectRoot, store, edges)
		}

		ts.forEachChild(node, visit)
	})
}

// walk the arguments of a call expression and emit a passed_as edge
// for every argument that resolves to a function or method symbol.
// precise filters: rejects values, classes, variables that aren't
// function-valued, and the callee itself (that's handled by
// resolveCallExpression already). handles identifier and
// property-access argument shapes. covers #49.
function resolveArgumentReferences(
	call: ts.CallExpression,
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	relPath: string,
	projectRoot: string,
	store: AtlasStore,
	edges: ResolvedEdge[],
) {
	resolveArgumentReferencesFromArgs(
		call.arguments,
		sourceFile,
		checker,
		relPath,
		projectRoot,
		store,
		edges,
	)
}

// shared argument-walker reused by call expressions and new
// expressions. kept private so callers don't accidentally pass
// non-argument nodes. see #87.
function resolveArgumentReferencesFromArgs(
	args: ts.NodeArray<ts.Expression>,
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	relPath: string,
	projectRoot: string,
	store: AtlasStore,
	edges: ResolvedEdge[],
) {
	for (const arg of args) {
		if (!ts.isIdentifier(arg) && !ts.isPropertyAccessExpression(arg)) continue
		try {
			const sym = checker.getSymbolAtLocation(arg)
			if (!sym) continue

			const resolved = resolveOriginalSymbol(sym, checker)
			if (!resolved) continue

			// only emit passed_as when the resolved target is a function
			// or method declaration. variables, classes, and values are
			// skipped so we don't link every identifier argument.
			if (
				!ts.isFunctionDeclaration(resolved.decl) &&
				!ts.isMethodDeclaration(resolved.decl) &&
				!(
					ts.isVariableDeclaration(resolved.decl) &&
					resolved.decl.initializer &&
					(ts.isArrowFunction(resolved.decl.initializer) ||
						ts.isFunctionExpression(resolved.decl.initializer))
				)
			) {
				continue
			}

			const declFile = resolved.decl.getSourceFile()
			const declRelPath = toForwardSlash(relative(projectRoot, declFile.fileName))
			if (declRelPath.includes('node_modules')) continue

			const containingFn = findContainingFunction(arg, sourceFile, relPath)
			if (!containingFn) continue

			const targetName = resolved.symbol.getName()
			const targetKind = getSymbolKind(resolved.decl)
			const existing = store.findSymbolInFile(declRelPath, targetName, targetKind)
			const targetId = existing
				? existing.stableId
				: stableSymbolId(
						declRelPath,
						targetKind,
						buildQualifiedName(declRelPath, resolved.decl, targetName),
					)
			const sourceId = stableSymbolId(relPath, containingFn.kind, containingFn.qname)

			const pos = sourceFile.getLineAndCharacterOfPosition(arg.getStart())

			edges.push({
				sourceStableId: sourceId,
				targetStableId: targetId,
				kind: 'passed_as',
				line: pos.line + 1,
				col: pos.character,
				confidence: 'resolved',
			})
		} catch (e) {
			log.debug(`skipped passed_as resolution at ${relPath}: ${e}`)
		}
	}
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

// emit an instantiates edge from the enclosing function/method to
// the resolved class symbol of a `new Foo(...)` expression. mirrors
// resolveCallExpression but:
// - skips when the resolved target isn't a class declaration
//   (e.g. `new Error()`'s Error resolves to a lib declaration that is
//   not indexed; we never emit dangling edges)
// - targets the class itself, not a synthesized constructor symbol
//   (matches the #87 acceptance criterion)
// see #87.
function resolveNewExpression(
	node: ts.NewExpression,
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

		// only emit when the resolved target is actually a class. `new`
		// can apply to any constructable value (function constructors,
		// imported JSX elements, etc.) but the issue asks for class
		// instantiation specifically. everything else stays as a
		// type_ref edge via the existing resolveTypeReference path.
		if (!ts.isClassDeclaration(resolved.decl)) return

		const declFile = resolved.decl.getSourceFile()
		const declRelPath = toForwardSlash(relative(projectRoot, declFile.fileName))

		if (declRelPath.includes('node_modules')) return

		const containingFn = findContainingFunction(node, sourceFile, relPath)
		if (!containingFn) return

		const targetName = resolved.symbol.getName()
		const existing = store.findSymbolInFile(declRelPath, targetName, 'class')
		const targetId = existing
			? existing.stableId
			: stableSymbolId(declRelPath, 'class', buildQualifiedName(declRelPath, resolved.decl, targetName))

		const sourceId = stableSymbolId(relPath, containingFn.kind, containingFn.qname)

		const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart())

		edges.push({
			sourceStableId: sourceId,
			targetStableId: targetId,
			kind: 'instantiates',
			line: pos.line + 1,
			col: pos.character,
			confidence: 'resolved',
		})
	} catch (e) {
		log.debug(`skipped new resolution at ${relPath}: ${e}`)
	}
}

// emit a field_access edge from the enclosing function/method to
// the resolved property or method symbol of `obj.name`. this closes
// the structural-consumer blind spot where interface field reads
// (destructured or inferred, without a type annotation on the
// variable) produced no graph edge. see #85.
//
// noise controls:
// - skip when the parent is a CallExpression AND this node is that
//   call's expression (the callee): the calls edge already covers it
// - skip when the parent is a NewExpression's expression (instantiates
//   already covers the class)
// - only emit when the resolved target is a property or method symbol
//   (not a class/function/variable at the property position)
// - skip node_modules sources
function resolveFieldAccess(
	node: ts.PropertyAccessExpression,
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	relPath: string,
	projectRoot: string,
	store: AtlasStore,
	edges: ResolvedEdge[],
) {
	// don't double-count:
	// - callee of a call expression: `obj.method()` is covered by calls
	// - operand of a new expression: `new foo.Bar()` is covered by instantiates
	// - argument of a call/new expression when the target is a function
	//   or method: `arr.map(obj.method)` is covered by passed_as
	// the first two guards check by identity; the third check is done
	// later (after resolution) so it can inspect the decl kind.
	const parent = node.parent
	if (ts.isCallExpression(parent) && parent.expression === node) return
	if (ts.isNewExpression(parent) && parent.expression === node) return

	try {
		const sym = checker.getSymbolAtLocation(node.name)
		if (!sym) return

		const resolved = resolveOriginalSymbol(sym, checker)
		if (!resolved) return

		// only emit for declaration kinds the atlas extractor actually
		// indexes as its own symbol row. PropertyAssignment (object
		// literal keys) and EnumMember are not indexed, so an edge at
		// the computed stable_id would dangle. get/set accessors are
		// indexed as `method`, not `property`. see deep-review.
		const decl = resolved.decl
		let targetKind: SymbolKind
		if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) {
			targetKind = 'method'
		} else if (ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) {
			targetKind = 'method'
		} else if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) {
			targetKind = 'property'
		} else {
			return
		}

		// skip when this property access is a function-valued argument
		// to a call/new expression. `arr.map(obj.method)` emits a
		// passed_as edge from resolveArgumentReferencesFromArgs; without
		// this guard the same site would also emit a field_access edge.
		if (targetKind === 'method') {
			if (ts.isCallExpression(parent) && parent.arguments.includes(node)) return
			if (ts.isNewExpression(parent) && parent.arguments?.includes(node)) return
		}

		const declFile = decl.getSourceFile()
		const declRelPath = toForwardSlash(relative(projectRoot, declFile.fileName))
		if (declRelPath.includes('node_modules')) return

		const containingFn = findContainingFunction(node, sourceFile, relPath)
		if (!containingFn) return

		const targetName = resolved.symbol.getName()
		const existing = store.findSymbolInFile(declRelPath, targetName, targetKind)
		const targetId = existing
			? existing.stableId
			: stableSymbolId(declRelPath, targetKind, buildQualifiedName(declRelPath, decl, targetName))

		const sourceId = stableSymbolId(relPath, containingFn.kind, containingFn.qname)
		const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart())

		edges.push({
			sourceStableId: sourceId,
			targetStableId: targetId,
			kind: 'field_access',
			line: pos.line + 1,
			col: pos.character,
			confidence: 'resolved',
		})
	} catch (e) {
		log.debug(`skipped field_access resolution at ${relPath}: ${e}`)
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
			// bun:test / jest / mocha / vitest: `test('name', () => {...})`,
			// `describe('suite', () => {...})`, etc. attribute the callback's
			// inner calls to a synthetic `<callee>:<label>` symbol that the
			// tree-sitter extractor emits alongside. without this branch
			// call-sites inside test bodies return null and every edge out
			// of a test file is silently dropped. see deep-review follow-up
			// on atlas-002.
			const label = testCallableLabel(current.parent)
			if (label) {
				return { kind: 'function', qname: `${relPath}::${label}` }
			}
		}
		current = current.parent
	}
	return null
}

// test-framework callables whose first-arg string labels the callback
// body. must match TEST_CALLABLES in src/core/parser/extractors/typescript.ts.
const TS_RESOLVER_TEST_CALLABLES = new Set([
	'test', 'it', 'describe', 'suite', 'context',
	'beforeAll', 'beforeEach', 'afterAll', 'afterEach',
	'before', 'after',
])

// mirror of the tree-sitter extractor's testCallableInfo: returns the
// `<callee>:<label>` form when `node` is a recognized test callable's
// call expression, else null. kept here instead of shared because the
// extractor sees tree-sitter nodes while the resolver sees ts compiler
// nodes, and the duplication is tiny.
function testCallableLabel(node: ts.Node | undefined): string | null {
	if (!node || !ts.isCallExpression(node)) return null
	let callee: string | null = null
	const expr = node.expression
	if (ts.isIdentifier(expr)) {
		callee = expr.text
	} else if (ts.isPropertyAccessExpression(expr)) {
		// test.only / it.skip / describe.each -- walk down the object chain
		// to the root identifier.
		let cursor: ts.Expression = expr
		while (ts.isPropertyAccessExpression(cursor)) {
			cursor = cursor.expression
		}
		if (ts.isIdentifier(cursor)) callee = cursor.text
	} else if (ts.isCallExpression(expr)) {
		// describe.each(cases)('label', cb): the outer callee is a call.
		const inner = testCallableLabel(expr)
		if (inner) {
			// inner returns '<callee>:<innerLabel>'; we only need the callee
			// prefix for our outer label.
			const idx = inner.indexOf(':')
			callee = idx > 0 ? inner.slice(0, idx) : inner
		}
	}
	if (!callee || !TS_RESOLVER_TEST_CALLABLES.has(callee)) return null
	const firstArg = node.arguments[0]
	if (!firstArg) return null
	if (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
		const label = firstArg.text
		if (!label) return null
		const truncated = label.length > 80 ? `${label.slice(0, 80)}...` : label
		return `${callee}:${truncated}`
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
		if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
			// mirror findContainingFunction: type refs inside test callbacks
			// should attribute to the synthetic `<callee>:<label>` symbol.
			const label = testCallableLabel(current.parent)
			if (label) {
				return { kind: 'function', qname: `${relPath}::${label}` }
			}
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

