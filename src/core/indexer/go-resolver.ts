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
export function resolveGoProject(
	projectRoot: string,
	absoluteFilePaths: string[],
	store: AtlasStore,
	repoModules: RepoModule[],
): { edges: ResolvedEdge[]; imports: ResolvedImport[] } {
	const edges: ResolvedEdge[] = []
	const imports: ResolvedImport[] = []
	if (absoluteFilePaths.length === 0) {
		return { edges, imports }
	}

	// only go modules matter for import-path resolution. filter once up
	// front so each file's lookup is linear in #go-modules, not total.
	const goModules = repoModules.filter((m) => m.kind === 'go' && m.modulePath)
	if (goModules.length === 0) {
		// a repo with .go files but no go.mod is unusual but not worth
		// warning about here; it just means the resolver has nothing to
		// do and the pipeline continues with heuristic edges only.
		return { edges, imports }
	}

	// cache resolved package directories across files so a monorepo
	// with many files importing the same package only walks the dir
	// once per resolver run.
	const dirListCache = new Map<string, string[]>()

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

		// build (local name -> import path) map from this file's import
		// declarations. handles plain imports, aliased imports, and the
		// `_ "pkg"` side-effect form. dot imports (`. "pkg"`) are not
		// resolved because they inject names into the file's namespace
		// without a package qualifier, which is out of scope for the
		// MVP — see the scope comment at the top of the file.
		const localToPath = new Map<string, string>()
		for (const child of root.namedChildren) {
			if (child.type !== 'import_declaration') continue
			collectImports(child, localToPath)
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
		// type refs.
		walkAndResolve(root, relPath, localToPath, pathToDir, store, projectRoot, edges)
	}

	return { edges, imports }
}

// ---

// fill localToPath with (localName -> importPath) entries for a single
// import_declaration. handles `import "x"`, `import alias "x"`, and
// `import ( "x"; alias "y" )` grouped forms.
function collectImports(decl: SyntaxNode, localToPath: Map<string, string>) {
	for (const spec of decl.descendantsOfType('import_spec')) {
		const pathNode = spec.childForFieldName('path')
		if (!pathNode) continue
		const importPath = pathNode.text.replace(/^["']|["']$/g, '')
		const aliasNode = spec.childForFieldName('name')
		if (aliasNode) {
			const alias = aliasNode.text
			if (alias === '_' || alias === '.') continue // side-effect or dot import
			localToPath.set(alias, importPath)
		} else {
			// no alias: the local name is the package's last path
			// component. this is a go convention, not a guarantee (the
			// package declaration inside the target file may differ),
			// but it's the dominant case and lines up with the
			// resolver's best-effort scope.
			const last = basename(importPath)
			localToPath.set(last, importPath)
		}
	}
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
	localToPath: Map<string, string>,
	pathToDir: Map<string, string | null>,
	store: AtlasStore,
	projectRoot: string,
	edges: ResolvedEdge[],
) {
	// tracks the nearest enclosing function/method so call edges get a
	// meaningful source stable_id. mirrors the go extractor's intra-file
	// behaviour.
	type ContainerKind = 'function' | 'method'
	interface Container {
		qname: string
		kind: ContainerKind
	}

	const walk = (node: SyntaxNode, container: Container | null) => {
		// enter function/method scope
		if (node.type === 'function_declaration') {
			const nameNode = node.childForFieldName('name')
			if (nameNode) {
				const next: Container = {
					qname: `${sourceRelPath}::${nameNode.text}`,
					kind: 'function',
				}
				for (const child of node.namedChildren) walk(child, next)
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
					for (const child of node.namedChildren) walk(child, next)
					return
				}
			}
		}

		// package-qualified call: `pkg.Foo(...)`
		if (node.type === 'call_expression' && container) {
			const func = node.childForFieldName('function')
			if (func && func.type === 'selector_expression') {
				const recv = func.childForFieldName('operand')
				const field = func.childForFieldName('field')
				if (recv && field && recv.type === 'identifier') {
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
								line: node.startPosition.row + 1,
								col: node.startPosition.column,
								confidence: 'resolved',
							})
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

		for (const child of node.namedChildren) walk(child, container)
	}

	for (const child of root.namedChildren) walk(child, null)
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
