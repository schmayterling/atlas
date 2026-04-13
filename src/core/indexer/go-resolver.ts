import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { stableSymbolId } from '../../shared/identity.js'
import { log } from '../../shared/logger.js'
import { toForwardSlash } from '../../shared/paths.js'
import type Parser from 'tree-sitter'
import { parseSource } from '../parser/parser-manager.js'
import type { AtlasStore } from '../storage/store.js'
import type { ResolvedEdge, ResolvedImport } from './ts-resolver.js'
import type { RepoModule } from './module-detector.js'

type SyntaxNode = Parser.SyntaxNode

// go cross-file resolver MVP (covers #3). mirrors the shape of
// resolveProject in ts-resolver.ts: takes a list of absolute go file
// paths and emits the same ResolvedEdge + ResolvedImport rows, which
// the indexer bulk-inserts alongside the TS output in step 6.
//
// scope:
//   - package-qualified calls (`pkg.Foo()`) within one go.mod
//   - package-qualified type refs (`pkg.MyStruct`) within one go.mod
//   - `imports` table upgrades (null target -> resolved target_file_id)
//
// explicitly NOT in scope:
//   - receiver-method calls on typed variables (`s.Method()`)
//   - external imports (anything outside the project's own modulePath)
//   - vendor directories, build tags, generics, dot imports
//
// the current go extractor emits `calls` edges with
// targetName = `${filePath}::pkg.Foo`. we do NOT change that format
// (codex review flagged that splitting on `.` inside the extractor
// would break the intra-file stable_id round-trip). instead, this
// resolver splits inside its own walker and writes a cross-file edge
// with `confidence: 'resolved'` that points at the real symbol.
// positions of heuristic call edges that were upgraded to resolved
// cross-file edges. the indexer's step 6 wiring consumes this to
// issue targeted deletes against the edges table before bulk-inserting
// the resolved rows, so a single call site never shows up as both
// a heuristic and a resolved edge. see #40.
export interface HeuristicUpgradePosition {
	fileId: number
	line: number
	col: number
}

export function resolveGoProject(
	projectRoot: string,
	absoluteFilePaths: string[],
	store: AtlasStore,
	repoModules: RepoModule[],
): {
	edges: ResolvedEdge[]
	imports: ResolvedImport[]
	heuristicUpgrades: HeuristicUpgradePosition[]
} {
	const edges: ResolvedEdge[] = []
	const imports: ResolvedImport[] = []
	const heuristicUpgrades: HeuristicUpgradePosition[] = []
	if (absoluteFilePaths.length === 0) {
		return { edges, imports, heuristicUpgrades }
	}

	// only go modules matter for import-path resolution. filter once up
	// front so each file's lookup is linear in #go-modules, not total.
	const goModules = repoModules.filter((m) => m.kind === 'go' && m.modulePath)
	if (goModules.length === 0) {
		// a repo with .go files but no go.mod is unusual but not worth
		// warning about here; it just means the resolver has nothing to
		// do and the pipeline continues with heuristic edges only.
		return { edges, imports, heuristicUpgrades }
	}

	// cache resolved package directories across files so a monorepo
	// with many files importing the same package only walks the dir
	// once per resolver run.
	const dirListCache = new Map<string, string[]>()
	// cache package names per dir so we only read/parse the target
	// package's package_clause once per resolver run. see #28.
	const packageNameCache = new Map<string, string | null>()

	for (const absPath of absoluteFilePaths) {
		const relPath = toForwardSlash(relative(projectRoot, absPath))
		const fileRecord = store.getFileByPath(relPath)
		if (!fileRecord) continue

		let source: string
		try {
			source = readFileSync(absPath, 'utf-8')
		} catch (e) {
			log.warn(`go-resolver: read ${relPath}: ${e}`)
			continue
		}

		const tree = parseSource(source, 'go')
		const root = tree.rootNode

		// collect raw imports (path + optional alias) then bind each
		// to a local name via the target package_clause. handles
		// plain imports, aliased imports, and `_ "pkg"` side-effect
		// form. dot imports (`. "pkg"`) are skipped — they inject
		// names into the file's namespace without a package qualifier.
		const rawImports: RawImport[] = []
		for (const child of root.namedChildren) {
			if (child.type !== 'import_declaration') continue
			collectImports(child, rawImports)
		}
		const localToPath = new Map<string, string>()
		for (const raw of rawImports) {
			if (raw.alias) {
				localToPath.set(raw.alias, raw.importPath)
				continue
			}
			// un-aliased import: bind the local name to the target
			// file's declared package, falling back to the path's
			// last component when we can't resolve the directory
			// (external / unresolved). see #28.
			const dir = resolveImportPath(raw.importPath, goModules, projectRoot)
			let localName: string | null = null
			if (dir) {
				localName = discoverPackageName(dir, packageNameCache, dirListCache)
			}
			if (!localName) localName = basename(raw.importPath)
			localToPath.set(localName, raw.importPath)
		}

		// map each import path to an absolute directory via the longest-matching
		// go.mod modulePath. cached per (importPath) to amortize
		// directory listings across files that import the same package.
		// emits one row per import (resolved or not) so that after the
		// indexer's deleteImportsForSourceFiles cleanup, every original
		// import is still visible in the imports table — unresolved
		// externals keep their null target_file_id just like step 5
		// wrote them.
		const pathToDir = new Map<string, string | null>()
		const importLines = collectImportLines(root)
		const emitted = new Set<string>()
		for (const [, importPath] of localToPath) {
			if (emitted.has(importPath)) continue
			emitted.add(importPath)
			if (!pathToDir.has(importPath)) {
				pathToDir.set(importPath, resolveImportPath(importPath, goModules, projectRoot))
			}
			const dir = pathToDir.get(importPath) ?? null
			const line = importLines.get(importPath) ?? 0
			if (!dir) {
				// external / stdlib import: keep it visible with a null
				// target so consumers can still see the import exists.
				imports.push({
					sourceFileId: fileRecord.id,
					targetFileId: null,
					importPath,
					isTypeOnly: false,
					line,
				})
				continue
			}
			// in-module import: emit one row per go file in the target
			// package that the indexer already knows about. a package
			// with several files produces several imports rows, which
			// matches the ts-resolver's fan-out semantics (one row per
			// resolved destination file).
			const targetFiles = listGoFilesCached(dir, dirListCache)
			let resolvedAny = false
			for (const name of targetFiles) {
				const targetRel = toForwardSlash(relative(projectRoot, join(dir, name)))
				const targetRecord = store.getFileByPath(targetRel)
				if (!targetRecord) continue
				imports.push({
					sourceFileId: fileRecord.id,
					targetFileId: targetRecord.id,
					importPath,
					isTypeOnly: false,
					line,
				})
				resolvedAny = true
			}
			if (!resolvedAny) {
				// in-module but the target package happened to have no
				// indexed files (e.g. test-only files were excluded).
				// still emit a null-target row so the import stays
				// visible in the imports table.
				imports.push({
					sourceFileId: fileRecord.id,
					targetFileId: null,
					importPath,
					isTypeOnly: false,
					line,
				})
			}
		}

		// walk the body of every function/method and emit resolved
		// cross-file edges for `pkg.Foo()` calls and `pkg.MyStruct`
		// type refs. call sites that upgrade from heuristic to
		// resolved record their (file_id, line, col) so the indexer
		// can delete the old heuristic edge before inserting the
		// resolved one. see #40.
		walkAndResolve(
			root,
			relPath,
			fileRecord.id,
			localToPath,
			pathToDir,
			store,
			projectRoot,
			edges,
			heuristicUpgrades,
		)
	}

	return { edges, imports, heuristicUpgrades }
}

// ---

// raw import entries collected from a single import_declaration. we
// defer binding the local name until pathToDir is resolved so we can
// read the target file's actual `package foo` clause instead of
// assuming basename(importPath) == packageName. see #28.
interface RawImport {
	importPath: string
	alias: string | null
}

function collectImports(decl: SyntaxNode, out: RawImport[]): void {
	for (const spec of decl.descendantsOfType('import_spec')) {
		const pathNode = spec.childForFieldName('path')
		if (!pathNode) continue
		const importPath = pathNode.text.replace(/^["']|["']$/g, '')
		const aliasNode = spec.childForFieldName('name')
		if (aliasNode) {
			const alias = aliasNode.text
			if (alias === '_' || alias === '.') continue // side-effect or dot import
			out.push({ importPath, alias })
		} else {
			out.push({ importPath, alias: null })
		}
	}
}

// discover the `package foo` declaration of a go package directory by
// peeking at the first .go file and reading its package_clause. used
// by collectImports to bind an un-aliased import to the correct local
// name when the directory basename and the declared package name
// diverge (e.g. cmd/app/main.go with `package main`). caches per dir
// so every importer only parses the target once. see #28.
function discoverPackageName(
	dir: string,
	cache: Map<string, string | null>,
	dirListCache: Map<string, string[]>,
): string | null {
	const cached = cache.get(dir)
	if (cached !== undefined) return cached
	const files = listGoFilesCached(dir, dirListCache)
	for (const name of files) {
		let source: string
		try {
			source = readFileSync(join(dir, name), 'utf-8')
		} catch {
			continue
		}
		// tree-sitter parse is overkill for a 1-line lookup; a
		// line-wise regex over the first 50 non-comment lines is
		// enough and avoids pulling in another parse pass.
		let lines = 0
		for (const rawLine of source.split('\n')) {
			const line = rawLine.trim()
			if (!line || line.startsWith('//') || line.startsWith('/*')) continue
			if (lines++ > 50) break
			const m = line.match(/^package\s+(\w+)/)
			if (m) {
				cache.set(dir, m[1])
				return m[1]
			}
		}
	}
	cache.set(dir, null)
	return null
}

// resolve an import path to an absolute directory on disk via the
// longest-matching go.mod modulePath. returns null when the path
// doesn't belong to any of the project's own go modules (external
// dependencies fall through to heuristic edges). rootDir on RepoModule
// is a path relative to projectRoot (see module-detector.ts:126), so
// the caller must pass projectRoot in to build the absolute path.
function resolveImportPath(
	importPath: string,
	goModules: RepoModule[],
	projectRoot: string,
): string | null {
	let best: RepoModule | null = null
	for (const mod of goModules) {
		const mp = mod.modulePath!
		if (importPath === mp || importPath.startsWith(`${mp}/`)) {
			if (!best || (best.modulePath && mp.length > best.modulePath.length)) {
				best = mod
			}
		}
	}
	if (!best) return null
	const suffix = importPath.slice(best.modulePath!.length).replace(/^\//, '')
	const absRoot = best.rootDir ? join(projectRoot, best.rootDir) : projectRoot
	return suffix ? join(absRoot, suffix) : absRoot
}

function listGoFilesCached(dir: string, cache: Map<string, string[]>): string[] {
	const cached = cache.get(dir)
	if (cached) return cached
	let entries: string[]
	try {
		entries = readdirSync(dir).filter((e) => e.endsWith('.go') && !e.endsWith('_test.go'))
	} catch {
		entries = []
	}
	cache.set(dir, entries)
	return entries
}

// walk a go AST, find `selector_expression` nodes in calling or type
// positions whose receiver is a known imported package name, and emit
// a resolved edge pointing at the symbol in the resolved target
// directory.
function walkAndResolve(
	root: SyntaxNode,
	sourceRelPath: string,
	sourceFileId: number,
	localToPath: Map<string, string>,
	pathToDir: Map<string, string | null>,
	store: AtlasStore,
	projectRoot: string,
	edges: ResolvedEdge[],
	heuristicUpgrades: HeuristicUpgradePosition[],
) {
	// tracks the nearest enclosing function/method so call edges get a
	// meaningful source stable_id. mirrors the go extractor's intra-file
	// behaviour.
	type ContainerKind = 'function' | 'method'
	interface Container {
		qname: string
		kind: ContainerKind
	}

	// the type inferred for a receiver variable. `pkgAlias` is the
	// import's local name (so we can reach the right dir via
	// localToPath/pathToDir), and `typeName` is the go type identifier
	// the dot-lookup should search for. see #27.
	interface ReceiverType {
		pkgAlias: string
		typeName: string
	}

	// a stack of block-scoped variable type maps. short_var_decl and
	// var_decl inside a block push entries into the innermost frame;
	// entering a new `block`/`if_statement`/`for_statement` pushes a
	// frame, exiting pops. a new function_declaration / method_declaration
	// starts an entirely new stack so outer functions don't leak.
	type ScopeStack = Map<string, ReceiverType>[]

	const trackLocalType = (
		nameNode: SyntaxNode | null,
		valueNode: SyntaxNode | null,
		scope: ScopeStack,
	) => {
		if (!nameNode || !valueNode || scope.length === 0) return
		const name = nameNode.text
		const frame = scope[scope.length - 1]
		// the MVP shape we handle: `x := pkg.NewFoo()` or
		// `x := pkg.NewFoo(args)`. the value side is a call_expression
		// on a selector_expression whose operand is an imported pkg
		// alias. tree-sitter-go models `pkg.NewFoo()` as
		// call_expression(function: selector_expression).
		if (valueNode.type !== 'call_expression') return
		const funcNode = valueNode.childForFieldName('function')
		if (!funcNode || funcNode.type !== 'selector_expression') return
		const operand = funcNode.childForFieldName('operand')
		const field = funcNode.childForFieldName('field')
		if (!operand || !field || operand.type !== 'identifier') return
		// heuristic: constructor-style names starting with New or Make
		// return the package's eponymous type (pkg.NewFoo() -> pkg.Foo).
		// this covers the dominant server/handler pattern without a
		// real type checker. see #27 scope note.
		const ctorName = field.text
		let inferredType: string | null = null
		if (ctorName.startsWith('New')) inferredType = ctorName.slice(3)
		else if (ctorName.startsWith('Make')) inferredType = ctorName.slice(4)
		if (!inferredType) return
		frame.set(name, { pkgAlias: operand.text, typeName: inferredType })
	}

	const lookupLocalType = (name: string, scope: ScopeStack): ReceiverType | null => {
		for (let i = scope.length - 1; i >= 0; i--) {
			const hit = scope[i].get(name)
			if (hit) return hit
		}
		return null
	}

	const walk = (node: SyntaxNode, container: Container | null, scope: ScopeStack) => {
		// enter function/method scope — reset the local type stack
		// so outer bindings don't leak into nested function bodies.
		if (node.type === 'function_declaration') {
			const nameNode = node.childForFieldName('name')
			if (nameNode) {
				const next: Container = {
					qname: `${sourceRelPath}::${nameNode.text}`,
					kind: 'function',
				}
				const freshScope: ScopeStack = [new Map()]
				for (const child of node.namedChildren) walk(child, next, freshScope)
				return
			}
		}
		if (node.type === 'method_declaration') {
			const nameNode = node.childForFieldName('name')
			const receiver = node.childForFieldName('receiver')
			if (nameNode && receiver) {
				const recvType = firstTypeIdentifier(receiver)
				if (recvType) {
					const next: Container = {
						qname: `${sourceRelPath}::${recvType}.${nameNode.text}`,
						kind: 'method',
					}
					const freshScope: ScopeStack = [new Map()]
					for (const child of node.namedChildren) walk(child, next, freshScope)
					return
				}
			}
		}

		// push a new frame on block entry so shadowing works.
		if (node.type === 'block' && container && scope.length > 0) {
			const frame = new Map<string, ReceiverType>()
			scope.push(frame)
			for (const child of node.namedChildren) walk(child, container, scope)
			scope.pop()
			return
		}

		// `x := pkg.NewFoo()` — short variable declaration binds the
		// receiver type into the current scope frame. tree-sitter-go
		// names these `short_var_declaration` with `left` and `right`
		// fields. left is an expression_list of identifiers; right is
		// an expression_list of values. we handle the common 1:1 case.
		if (node.type === 'short_var_declaration') {
			const left = node.childForFieldName('left')
			const right = node.childForFieldName('right')
			if (left && right) {
				const lefts = left.namedChildren
				const rights = right.namedChildren
				for (let i = 0; i < Math.min(lefts.length, rights.length); i++) {
					trackLocalType(lefts[i], rights[i], scope)
				}
			}
		}
		// `var x = pkg.NewFoo()` — var_spec inside var_declaration has
		// name + value fields shaped differently.
		if (node.type === 'var_spec') {
			const nameList = node.childForFieldName('name')
			const valueList = node.childForFieldName('value')
			if (nameList && valueList) {
				const names = nameList.type === 'identifier' ? [nameList] : nameList.namedChildren
				const values =
					valueList.type === 'expression_list' ? valueList.namedChildren : [valueList]
				for (let i = 0; i < Math.min(names.length, values.length); i++) {
					trackLocalType(names[i], values[i], scope)
				}
			}
		}

		// package-qualified call: `pkg.Foo(...)` or receiver-method
		// call: `recv.Method(...)` where recv's type was declared
		// earlier in scope via `recv := pkg.NewFoo()`.
		if (node.type === 'call_expression' && container) {
			const func = node.childForFieldName('function')
			if (func && func.type === 'selector_expression') {
				const recv = func.childForFieldName('operand')
				const field = func.childForFieldName('field')
				if (recv && field && recv.type === 'identifier') {
					const line = node.startPosition.row + 1
					const col = node.startPosition.column
					// path 1: package-qualified call. recv is an
					// imported alias, field is the exported function.
					const importPath = localToPath.get(recv.text)
					const dir = importPath ? pathToDir.get(importPath) ?? null : null
					if (dir) {
						const resolved = findSymbolAcrossDir(
							store,
							dir,
							projectRoot,
							field.text,
							['function', 'method'],
						)
						if (resolved) {
							edges.push({
								sourceStableId: stableSymbolId(
									sourceRelPath,
									container.kind,
									container.qname,
								),
								targetStableId: resolved,
								kind: 'calls',
								line,
								col,
								confidence: 'resolved',
							})
							heuristicUpgrades.push({ fileId: sourceFileId, line, col })
						}
					} else {
						// path 2: receiver-method call. recv is a local
						// variable whose type we inferred earlier via
						// `recv := pkgAlias.NewType()`. resolve the
						// method against the inferred type's package
						// directory. see #27.
						const recvType = lookupLocalType(recv.text, scope)
						if (recvType) {
							const rtImportPath = localToPath.get(recvType.pkgAlias)
							const rtDir = rtImportPath
								? pathToDir.get(rtImportPath) ?? null
								: null
							if (rtDir) {
								const resolved = findSymbolAcrossDir(
									store,
									rtDir,
									projectRoot,
									field.text,
									['method'],
								)
								if (resolved) {
									edges.push({
										sourceStableId: stableSymbolId(
											sourceRelPath,
											container.kind,
											container.qname,
										),
										targetStableId: resolved,
										kind: 'calls',
										line,
										col,
										confidence: 'resolved',
									})
									heuristicUpgrades.push({
										fileId: sourceFileId,
										line,
										col,
									})
								}
							}
						}
					}
				}
			}
		}

		// package-qualified type ref: `pkg.MyStruct` in a parameter,
		// return type, or field type position. tree-sitter-go models
		// these as `qualified_type` nodes.
		if (node.type === 'qualified_type' && container) {
			const pkgNode = node.childForFieldName('package')
			const nameNode = node.childForFieldName('name')
			if (pkgNode && nameNode) {
				const importPath = localToPath.get(pkgNode.text)
				const dir = importPath ? pathToDir.get(importPath) ?? null : null
				if (dir) {
					// types can be emitted by the go extractor as
					// 'class' (struct), 'interface', or 'type' (alias).
					// try each in order.
					const resolved = findSymbolAcrossDir(
						store,
						dir,
						projectRoot,
						nameNode.text,
						['class', 'interface', 'type'],
					)
					if (resolved) {
						edges.push({
							sourceStableId: stableSymbolId(
								sourceRelPath,
								container.kind,
								container.qname,
							),
							targetStableId: resolved,
							kind: 'type_ref',
							line: node.startPosition.row + 1,
							col: node.startPosition.column,
							confidence: 'resolved',
						})
					}
				}
			}
		}

		for (const child of node.namedChildren) walk(child, container, scope)
	}

	for (const child of root.namedChildren) walk(child, null, [])
}

// iterate every .go file in `dir` and return the stable_id of the
// first file that declares a symbol with the given name and a kind in
// `allowedKinds`. uses store.findSymbolInFile which is prepared and
// cached so this stays off the slow path.
function findSymbolAcrossDir(
	store: AtlasStore,
	dir: string,
	projectRoot: string,
	name: string,
	allowedKinds: ('function' | 'method' | 'class' | 'interface' | 'type')[],
): string | null {
	let entries: string[]
	try {
		entries = readdirSync(dir).filter((e) => e.endsWith('.go') && !e.endsWith('_test.go'))
	} catch {
		return null
	}
	for (const entry of entries) {
		const targetRel = toForwardSlash(relative(projectRoot, join(dir, entry)))
		for (const kind of allowedKinds) {
			const sym = store.findSymbolInFile(targetRel, name, kind)
			if (sym) return sym.stableId
		}
	}
	return null
}

function firstTypeIdentifier(node: SyntaxNode): string | null {
	if (node.type === 'type_identifier') return node.text
	for (const child of node.namedChildren) {
		const found = firstTypeIdentifier(child)
		if (found) return found
	}
	return null
}

// builds a lookup of importPath -> source line number for each import
// spec in the file so the imports table can record where each import
// statement lives. tracked once per file.
function collectImportLines(root: SyntaxNode): Map<string, number> {
	const out = new Map<string, number>()
	for (const decl of root.descendantsOfType('import_declaration')) {
		for (const spec of decl.descendantsOfType('import_spec')) {
			const pathNode = spec.childForFieldName('path')
			if (!pathNode) continue
			const importPath = pathNode.text.replace(/^["']|["']$/g, '')
			if (!out.has(importPath)) {
				out.set(importPath, spec.startPosition.row + 1)
			}
		}
	}
	return out
}
