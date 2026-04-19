#!/usr/bin/env bun
// generate 14 bench-eval tasks per corpus by mining real symbols + file
// counts from the corpus's atlas index. emits stable, reproducible task
// json files under bench-eval/tasks/<corpus>/ that exercise the same 7
// capabilities as the existing ripgrep+zod tasks (indexing, discovery,
// code-access, call-tracing, graph-querying, file-navigation × 2 each
// + 2 text-content). authored programmatically because hand-authoring
// 84 task files (6 corpora × 14) without inspecting the corpus first
// invites stale references.
//
// re-run safely whenever a manifest's ref changes: queries the indexed
// db live, picks the most-popular symbols by inbound edge count, and
// pins them in the json. existing files are overwritten.

import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { initSqliteExtensions, loadVecExtension } from '../src/core/storage/sqlite-ext.js'
initSqliteExtensions()

const REPO_ROOT = resolve(import.meta.dir, '..')

interface CorpusSpec {
	name: string
	primaryLang: string
	primaryExt: string
	secondaryLang?: string
	secondaryExt?: string
	commonString: string
	commonStringTolerance: number
	wellKnownPath: string
}

// per-corpus fixed inputs picked by hand against the public project
// structure. languages match the manifest expected_languages. the
// `commonString` is a literal substring guaranteed to appear in many
// files (used by text-content tasks); `wellKnownPath` is a stable
// directory the project ships (used by file-navigation tasks).
const SPECS: CorpusSpec[] = [
	{ name: 'pydantic', primaryLang: 'python', primaryExt: 'py', commonString: 'Field', commonStringTolerance: 8, wellKnownPath: 'pydantic/' },
	{ name: 'hugo',     primaryLang: 'go',     primaryExt: 'go', commonString: 'context', commonStringTolerance: 12, wellKnownPath: 'commands/' },
	{ name: 'gradio',   primaryLang: 'python', primaryExt: 'py', secondaryLang: 'typescript', secondaryExt: 'ts',
	  commonString: 'gradio', commonStringTolerance: 10, wellKnownPath: 'gradio/' },
	{ name: 'turbo',    primaryLang: 'rust',   primaryExt: 'rs', secondaryLang: 'typescript', secondaryExt: 'ts',
	  commonString: 'TODO', commonStringTolerance: 15, wellKnownPath: 'crates/' },
	{ name: 'unleash',  primaryLang: 'typescript', primaryExt: 'ts', commonString: 'feature', commonStringTolerance: 30, wellKnownPath: 'src/lib/' },
	{ name: 'expo',     primaryLang: 'typescript', primaryExt: 'ts', commonString: 'expo', commonStringTolerance: 50, wellKnownPath: 'packages/expo/' },
]

function findDb(corpus: string): string {
	const dir = join(REPO_ROOT, '.bench-cache', corpus)
	if (!existsSync(dir)) throw new Error(`no .bench-cache for ${corpus}; run \`bun run bench-eval --corpus ${corpus}\` first`)
	const subdirs = require('node:fs').readdirSync(dir).filter((d: string) => statSync(join(dir, d)).isDirectory())
	if (subdirs.length === 0) throw new Error(`no clone subdir under ${dir}`)
	return join(dir, subdirs[0], '.atlas', 'atlas.db')
}

interface SymbolHit {
	name: string
	qualifiedName: string
	kind: string
	filePath: string
	inboundEdgeCount: number
}

function topInboundSymbols(db: Database, kind: string, limit: number): SymbolHit[] {
	return db
		.query<SymbolHit, [string, number]>(
			`SELECT s.name, s.qualified_name as qualifiedName, s.kind,
			        f.path as filePath,
			        (SELECT COUNT(*) FROM edges e WHERE e.target_id = s.stable_id AND e.kind = 'calls') as inboundEdgeCount
			 FROM symbols s
			 JOIN files f ON f.id = s.file_id
			 WHERE s.kind = ? AND s.is_exported = 1 AND f.is_test = 0
			 ORDER BY inboundEdgeCount DESC
			 LIMIT ?`,
		)
		.all(kind, limit)
}

function fileCountByLanguage(db: Database, language: string): number {
	const r = db.query<{ c: number }, [string]>(
		'SELECT COUNT(*) c FROM files WHERE language = ? AND is_test = 0',
	).get(language)
	return r?.c ?? 0
}

function fileCountUnderPath(db: Database, prefix: string, language?: string): number {
	const sql = language
		? 'SELECT COUNT(*) c FROM files WHERE path LIKE ? AND language = ? AND is_test = 0'
		: 'SELECT COUNT(*) c FROM files WHERE path LIKE ? AND is_test = 0'
	const params = language ? [`${prefix}%`, language] : [`${prefix}%`]
	const r = db.query<{ c: number }, any[]>(sql).get(...params as any[])
	return r?.c ?? 0
}

function countOccurrences(corpus: string, needle: string, ext: string): number {
	const root = join(REPO_ROOT, '.bench-cache', corpus)
	const subdirs = require('node:fs').readdirSync(root).filter((d: string) => statSync(join(root, d)).isDirectory())
	const cwd = join(root, subdirs[0])
	const r = require('node:child_process').spawnSync(
		'rg', ['-l', needle, '--glob', `**/*.${ext}`, '.'],
		{ cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
	)
	if (r.status !== 0 && r.status !== 1) return 0
	return (r.stdout ?? '').trim().split('\n').filter(Boolean).length
}

function emit(corpus: string, file: string, body: object): void {
	const dir = join(REPO_ROOT, 'bench-eval', 'tasks', corpus)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, file), JSON.stringify(body, null, '\t') + '\n')
}

function buildTasks(spec: CorpusSpec): void {
	const dbPath = findDb(spec.name)
	const db = new Database(dbPath, { readonly: true })
	loadVecExtension(db)

	const fileCount = fileCountByLanguage(db, spec.primaryLang)
	const wellKnownCount = fileCountUnderPath(db, spec.wellKnownPath, spec.primaryLang)
	const wellKnownAllLang = fileCountUnderPath(db, spec.wellKnownPath)
	const commonCount = countOccurrences(spec.name, spec.commonString, spec.primaryExt)

	const classes = topInboundSymbols(db, 'class', 5)
	const funcs = topInboundSymbols(db, 'function', 5)
	const callTargets = [...classes, ...funcs].filter((s) => s.inboundEdgeCount >= 1).slice(0, 4)

	const cls0 = classes[0] ?? null
	const cls1 = classes[1] ?? null
	const fn0 = funcs[0] ?? null
	const fn1 = funcs[1] ?? null
	const callT0 = callTargets[0] ?? null
	const callT1 = callTargets[1] ?? null

	// 01 indexing
	emit(spec.name, '01-indexing.json', {
		id: `${spec.name}-01-indexing`,
		capability: 'indexing',
		intent: `how many ${spec.primaryLang} files does the ${spec.name} project have?`,
		atlas_method: 'files',
		atlas_args: { language: spec.primaryLang, includeTests: true },
		expected: { type: 'count', value: fileCount, tolerance: Math.max(2, Math.round(fileCount * 0.05)) },
		comparable_to_text_search: true,
		text_search_strategy: { mode: 'glob', pattern: `**/*.${spec.primaryExt}` },
	})

	// 02 discovery
	if (cls0) {
		emit(spec.name, '02-discovery.json', {
			id: `${spec.name}-02-discovery`,
			capability: 'discovery',
			intent: `find the ${cls0.name} class definition in ${spec.name}`,
			atlas_method: 'search',
			atlas_args: { q: cls0.name, kind: 'class', limit: 10 },
			expected: { type: 'symbol-set', symbols: [cls0.qualifiedName] },
			comparable_to_text_search: true,
			text_search_strategy: { mode: 'rg-symbols', pattern: `^\\s*class\\s+(${cls0.name})\\b`, glob: `*.${spec.primaryExt}`, capture: 1 },
		})
	}

	// 03 code-access
	if (fn0) {
		emit(spec.name, '03-code-access.json', {
			id: `${spec.name}-03-code-access`,
			capability: 'code-access',
			intent: `where is ${fn0.name} defined in ${spec.name}?`,
			atlas_method: 'symbolDetail',
			atlas_args: { symbol: fn0.qualifiedName },
			expected: { type: 'file-path', paths: [fn0.filePath] },
			comparable_to_text_search: true,
			text_search_strategy: { mode: 'rg-files-with-matches', pattern: `def ${fn0.name}|fn ${fn0.name}|function ${fn0.name}|func ${fn0.name}`, glob: `**/*.${spec.primaryExt}` },
		})
	}

	// 04 call-tracing
	if (callT0) {
		emit(spec.name, '04-call-tracing.json', {
			id: `${spec.name}-04-call-tracing`,
			capability: 'call-tracing',
			intent: `find call sites of ${callT0.name} (a popular ${callT0.kind} in ${spec.name})`,
			atlas_method: 'callSites',
			atlas_args: { symbol: callT0.qualifiedName, direction: 'inbound', limit: 50 },
			expected: { type: 'structural', predicates: [{ kind: 'min-results', n: Math.max(2, Math.min(5, Math.floor(callT0.inboundEdgeCount / 2))) }] },
			comparable_to_text_search: false,
			notes: `${callT0.name} has ${callT0.inboundEdgeCount} inbound calls per the indexed graph`,
		})
	}

	// 05 graph-querying
	if (callT0) {
		emit(spec.name, '05-graph-querying.json', {
			id: `${spec.name}-05-graph-querying`,
			capability: 'graph-querying',
			intent: `what depends on ${callT0.name} in ${spec.name} (upstream graph)?`,
			atlas_method: 'deps',
			atlas_args: { symbol: callT0.qualifiedName, direction: 'upstream', depth: 3 },
			expected: { type: 'structural', predicates: [{ kind: 'min-results', n: 2 }] },
			comparable_to_text_search: false,
			notes: 'upstream dependents walk; text-search has no graph',
		})
	}

	// 06 file-navigation
	if (wellKnownCount > 0) {
		emit(spec.name, '06-file-navigation.json', {
			id: `${spec.name}-06-file-navigation`,
			capability: 'file-navigation',
			intent: `list ${spec.primaryLang} files under ${spec.wellKnownPath}`,
			atlas_method: 'files',
			atlas_args: { pathPrefix: spec.wellKnownPath, language: spec.primaryLang, includeTests: true },
			expected: { type: 'count', value: wellKnownCount, tolerance: Math.max(2, Math.round(wellKnownCount * 0.05)) },
			comparable_to_text_search: true,
			text_search_strategy: { mode: 'glob-count', pattern: `${spec.wellKnownPath}**/*.${spec.primaryExt}` },
		})
	}

	// 07 indexing (second variant: under path, all languages)
	if (wellKnownAllLang > 0) {
		emit(spec.name, '07-indexing.json', {
			id: `${spec.name}-07-indexing`,
			capability: 'indexing',
			intent: `how many files (any language) live under ${spec.wellKnownPath}?`,
			atlas_method: 'files',
			atlas_args: { pathPrefix: spec.wellKnownPath, includeTests: true },
			expected: { type: 'count', value: wellKnownAllLang, tolerance: Math.max(3, Math.round(wellKnownAllLang * 0.05)) },
			comparable_to_text_search: true,
			text_search_strategy: { mode: 'glob-count', pattern: `${spec.wellKnownPath}**/*` },
		})
	}

	// 08 discovery (second class)
	if (cls1) {
		emit(spec.name, '08-discovery.json', {
			id: `${spec.name}-08-discovery`,
			capability: 'discovery',
			intent: `find the ${cls1.name} class definition`,
			atlas_method: 'search',
			atlas_args: { q: cls1.name, kind: 'class', limit: 10 },
			expected: { type: 'symbol-set', symbols: [cls1.qualifiedName] },
			comparable_to_text_search: true,
			text_search_strategy: { mode: 'rg-symbols', pattern: `^\\s*class\\s+(${cls1.name})\\b`, glob: `*.${spec.primaryExt}`, capture: 1 },
		})
	}

	// 09 code-access (second function)
	if (fn1) {
		emit(spec.name, '09-code-access.json', {
			id: `${spec.name}-09-code-access`,
			capability: 'code-access',
			intent: `where is ${fn1.name} defined?`,
			atlas_method: 'symbolDetail',
			atlas_args: { symbol: fn1.qualifiedName },
			expected: { type: 'file-path', paths: [fn1.filePath] },
			comparable_to_text_search: true,
			text_search_strategy: { mode: 'rg-files-with-matches', pattern: `def ${fn1.name}|fn ${fn1.name}|function ${fn1.name}|func ${fn1.name}`, glob: `**/*.${spec.primaryExt}` },
		})
	}

	// 10 call-tracing (second target)
	if (callT1) {
		emit(spec.name, '10-call-tracing.json', {
			id: `${spec.name}-10-call-tracing`,
			capability: 'call-tracing',
			intent: `find call sites of ${callT1.name}`,
			atlas_method: 'callSites',
			atlas_args: { symbol: callT1.qualifiedName, direction: 'inbound', limit: 50 },
			expected: { type: 'structural', predicates: [{ kind: 'min-results', n: Math.max(2, Math.min(5, Math.floor(callT1.inboundEdgeCount / 2))) }] },
			comparable_to_text_search: false,
		})
	}

	// 11 graph-querying (downstream variant)
	if (callT0) {
		emit(spec.name, '11-graph-querying.json', {
			id: `${spec.name}-11-graph-querying`,
			capability: 'graph-querying',
			intent: `what does ${callT0.name} call (downstream callees, depth 2)?`,
			atlas_method: 'deps',
			atlas_args: { symbol: callT0.qualifiedName, direction: 'downstream', depth: 2 },
			expected: { type: 'structural', predicates: [{ kind: 'min-results', n: 1 }] },
			comparable_to_text_search: false,
		})
	}

	// 12 file-navigation (root inventory by language)
	emit(spec.name, '12-file-navigation.json', {
		id: `${spec.name}-12-file-navigation`,
		capability: 'file-navigation',
		intent: `count source files by language across the entire ${spec.name} project`,
		atlas_method: 'files',
		atlas_args: { includeTests: true },
		expected: { type: 'count', value: fileCount, tolerance: Math.max(3, Math.round(fileCount * 0.1)) },
		comparable_to_text_search: true,
		text_search_strategy: { mode: 'glob', pattern: `**/*.${spec.primaryExt}` },
		notes: 'sanity-check that the indexed file count matches a glob walk',
	})

	// 13 text-content (substring count)
	emit(spec.name, '13-text-content.json', {
		id: `${spec.name}-13-text-content`,
		capability: 'text-content',
		intent: `how many ${spec.primaryLang} files mention "${spec.commonString}" in their content?`,
		atlas_method: 'searchContent',
		atlas_args: { q: spec.commonString, language: spec.primaryLang, maxMatches: 1000 },
		expected: { type: 'count', value: commonCount, tolerance: spec.commonStringTolerance },
		comparable_to_text_search: true,
		text_search_strategy: { mode: 'rg-files-with-matches', pattern: spec.commonString, glob: `**/*.${spec.primaryExt}` },
	})

	// 14 text-content (TODO substring)
	const todoCount = countOccurrences(spec.name, 'TODO', spec.primaryExt)
	emit(spec.name, '14-comments.json', {
		id: `${spec.name}-14-comments`,
		capability: 'text-content',
		intent: `how many ${spec.primaryLang} files contain a TODO marker?`,
		atlas_method: 'searchContent',
		atlas_args: { q: 'TODO', language: spec.primaryLang, maxMatches: 1000 },
		expected: { type: 'count', value: todoCount, tolerance: Math.max(2, Math.round(todoCount * 0.15)) },
		comparable_to_text_search: true,
		text_search_strategy: { mode: 'rg-files-with-matches', pattern: 'TODO', glob: `**/*.${spec.primaryExt}` },
	})

	console.log(`${spec.name}: emitted 14 tasks (${fileCount} files, top class=${cls0?.name ?? '—'}, top fn=${fn0?.name ?? '—'}, top call=${callT0?.name ?? '—'} ×${callT0?.inboundEdgeCount ?? 0}, common ${spec.commonString}=${commonCount}, TODO=${todoCount})`)
	db.close()
}

for (const spec of SPECS) {
	try {
		buildTasks(spec)
	} catch (e) {
		console.error(`${spec.name}: failed -- ${e instanceof Error ? e.message : e}`)
	}
}
