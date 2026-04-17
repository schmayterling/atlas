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
// file. there's no enclosing code symbol, so attribution uses a
// synthetic stable_id tied to the schema file itself so every hit in
// that file groups together but distinct files don't collide.
function extractFromStandaloneSchema(
	_store: AtlasStore,
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
	// synthetic per-file stable_id so all hits in this schema group
	// under one symbol in listChannels / showChannel. kind 'module'
	// matches the convention used by other file-level attributions.
	const synthSid = stableSymbolId(f.path, 'module', `${f.path}::schema`)
	for (const m of source.matchAll(GRAPHQL_DEF_RE)) {
		const definition = m[1]
		const name = m[2]
		if (!shouldKeepIdentifier(name)) continue
		const matchOffset = m.index ?? 0
		hits.push({
			symbolStableId: synthSid,
			fileId: f.id,
			kind: 'graphql_type',
			value: name,
			line: offsetToLine(lineOffsets, matchOffset) + 1,
			metadata: JSON.stringify({ definition, source: 'schema_file', schemaPath: f.path }),
		})
	}
}
