import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { log } from '../../shared/logger.js'
import { stableSymbolId } from '../../shared/identity.js'
import type { ChannelHit } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'
import {
	buildLineOffsets,
	isUnderRoot,
	offsetToLine,
	safeRealpath,
	shouldKeepIdentifier,
} from './channel-utils.js'

// graphql_type channel linker (#30b / #66). extracts type / input /
// enum / interface definitions from two sources:
//   1. `gql\`...\`` template literals embedded in already-indexed
//      ts/js files (original MVP scope)
//   2. standalone `.graphql` / `.graphqls` / `.gql` schema files,
//      which the indexer registers in the files table with
//      language='graphql' so channel_hits.file_id has a real target.
//      see file-discovery + indexer extractOneFile for the plumbing.
//
// writes channel_hits rows with kind='graphql_type'. for embedded
// literals, attribution goes to the surrounding function/class via
// store.getSymbolContainingByte. for standalone files there is no
// enclosing symbol, so the hit is attributed to the file-level
// stable_id recorded in metadata.schemaPath.
//
// out of scope:
//   - field references inside resolver bodies are NOT extracted

const GRAPHQL_DEF_RE = /^\s*(?:extend\s+)?(type|input|enum|interface|union|scalar)\s+([A-Z][\w]*)/gm
const TEMPLATE_TAG_RE = /\bgql\s*`([^`]+)`/g

export function linkGraphqlTypes(store: AtlasStore, projectRoot: string): { hits: number } {
	store.deleteChannelHitsByKind('graphql_type')

	const hits: ChannelHit[] = []
	const rootReal = safeRealpath(projectRoot) ?? projectRoot

	const indexedFiles = store.getAllFiles().filter((f) => !f.isTest)
	const tsExt = new Set(['.ts', '.tsx', '.js', '.jsx'])
	const graphqlExt = new Set(['.graphql', '.graphqls', '.gql'])
	for (const f of indexedFiles) {
		const dot = f.path.lastIndexOf('.')
		if (dot < 0) continue
		const ext = f.path.slice(dot)
		if (graphqlExt.has(ext)) {
			extractFromStandaloneSchema(store, projectRoot, rootReal, f, hits)
			continue
		}
		if (!tsExt.has(ext)) continue
		const abs = resolvePath(projectRoot, f.path)
		const real = safeRealpath(abs)
		if (real && !isUnderRoot(real, rootReal)) continue
		let source: string
		try {
			source = readFileSync(abs, 'utf-8')
		} catch (e) {
			log.warn(`graphql-linker: read ${f.path}: ${e}`)
			continue
		}
		// cheap pre-filter: skip the regex pass entirely for files that
		// don't reference the gql template tag at all. typical ts/js
		// projects have a handful of files that use gql and many that
		// don't, so this avoids allocating the match iterator for the
		// common case.
		if (!source.includes('gql`') && !source.includes('gql `')) continue
		const lineOffsets = buildLineOffsets(source)
		for (const tagMatch of source.matchAll(TEMPLATE_TAG_RE)) {
			const literalContent = tagMatch[1]
			// the literal starts after the opening backtick; offsets
			// inside literalContent need to be added to literalStart to
			// recover the absolute offset in source.
			const literalStart = (tagMatch.index ?? 0) + tagMatch[0].indexOf('`') + 1
			for (const m of literalContent.matchAll(GRAPHQL_DEF_RE)) {
				const definition = m[1]
				const name = m[2]
				if (!shouldKeepIdentifier(name)) continue
				const matchOffset = literalStart + (m.index ?? 0)
				const enclosing = store.getSymbolContainingByte(f.id, matchOffset)
				if (!enclosing) continue
				hits.push({
					symbolStableId: enclosing.stableId,
					fileId: f.id,
					kind: 'graphql_type',
					value: name,
					line: offsetToLine(lineOffsets, matchOffset) + 1,
					metadata: JSON.stringify({ definition, source: 'template_literal' }),
				})
			}
		}
	}

	if (hits.length > 0) store.insertChannelHits(hits)
	return { hits: hits.length }
}

// standalone .graphql / .graphqls / .gql schema file extraction.
// the indexer has already registered a files row (see extractOneFile
// no-extractor branch), so channel_hits.file_id points at a real
// file. for each type/input/enum definition:
//   1. emit one hit attributed to a synthetic per-file stable_id so
//      every definition in the same schema file groups together, and
//      distinct schema files don't collide.
//   2. emit additional hits attributed to any indexed ts/go symbol
//      (interface / type / class) sharing the type name, so
//      listChannels (which requires ≥2 distinct symbols per group)
//      actually groups the schema type with its language-level twin.
//      without this step, a schema-first project never produces
//      cross-language groups in listChannels. see #66 + deep-review.
function extractFromStandaloneSchema(
	store: AtlasStore,
	projectRoot: string,
	rootReal: string,
	f: { id: number; path: string },
	hits: ChannelHit[],
): void {
	const abs = resolvePath(projectRoot, f.path)
	const real = safeRealpath(abs)
	if (real && !isUnderRoot(real, rootReal)) return
	let source: string
	try {
		source = readFileSync(abs, 'utf-8')
	} catch (e) {
		log.warn(`graphql-linker: read ${f.path}: ${e}`)
		return
	}
	const lineOffsets = buildLineOffsets(source)
	const synthSid = stableSymbolId(f.path, 'module', `${f.path}::schema`)

	// collect definitions first so the cross-language lookup is one
	// batched query instead of n per-definition queries.
	const definitions: Array<{ definition: string; name: string; line: number }> = []
	for (const m of source.matchAll(GRAPHQL_DEF_RE)) {
		const definition = m[1]
		const name = m[2]
		if (!shouldKeepIdentifier(name)) continue
		const matchOffset = m.index ?? 0
		definitions.push({
			definition,
			name,
			line: offsetToLine(lineOffsets, matchOffset) + 1,
		})
	}
	if (definitions.length === 0) return

	const uniqueNames = Array.from(new Set(definitions.map((d) => d.name)))
	const namePlaceholders = uniqueNames.map(() => '?').join(',')
	const symRows = store.queryRawWithParams<{
		stableId: string
		name: string
		fileId: number
		lineStart: number
	}>(
		`SELECT s.stable_id as stableId, s.name as name, s.file_id as fileId, s.line_start as lineStart
		 FROM symbols s
		 JOIN files fi ON fi.id = s.file_id
		 WHERE s.name IN (${namePlaceholders})
		   AND s.kind IN ('interface', 'type', 'class')
		   AND fi.is_test = 0`,
		...uniqueNames,
	)
	const symsByName = new Map<string, Array<{ stableId: string; fileId: number; lineStart: number }>>()
	for (const row of symRows) {
		const list = symsByName.get(row.name) ?? []
		list.push({ stableId: row.stableId, fileId: row.fileId, lineStart: row.lineStart })
		symsByName.set(row.name, list)
	}

	for (const def of definitions) {
		// synthetic hit keeps the schema file itself groupable.
		hits.push({
			symbolStableId: synthSid,
			fileId: f.id,
			kind: 'graphql_type',
			value: def.name,
			line: def.line,
			metadata: JSON.stringify({
				definition: def.definition,
				source: 'schema_file',
				schemaPath: f.path,
			}),
		})
		// cross-language mirror hits so listChannels groups match the
		// expected "schema type X corresponds to ts interface X" shape.
		// each mirror hit records the ts/go symbol's own line_start
		// (its `fileId` points at the ts/go file, not the schema), so
		// downstream consumers that display file:line get a coherent
		// location. the schema path is preserved in metadata.
		const matches = symsByName.get(def.name)
		if (!matches) continue
		for (const sym of matches) {
			hits.push({
				symbolStableId: sym.stableId,
				fileId: sym.fileId,
				kind: 'graphql_type',
				value: def.name,
				line: sym.lineStart,
				metadata: JSON.stringify({
					definition: def.definition,
					source: 'schema_file',
					schemaPath: f.path,
					schemaLine: def.line,
					crossLanguageMirror: true,
				}),
			})
		}
	}
}
