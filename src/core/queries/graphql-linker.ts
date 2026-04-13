import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { log } from '../../shared/logger.js'
import type { ChannelHit } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'
import {
	buildLineOffsets,
	isUnderRoot,
	offsetToLine,
	safeRealpath,
	shouldKeepIdentifier,
} from './channel-utils.js'

// graphql_type channel linker (#30b). extracts type / input / enum /
// interface definitions from `gql\`...\`` template literals embedded
// in already-indexed ts/js files. writes channel_hits rows with
// kind='graphql_type', attributing each hit to the surrounding
// function/class via store.getSymbolContainingByte.
//
// scope:
//   - top-level definitions inside gql template literals
//     (`gql\`type X { ... }\``, `gql\`input X { ... }\``)
//   - field references inside resolver bodies are NOT extracted
//   - **standalone .graphql / .graphqls / .gql schema files are NOT
//     extracted in this MVP**. those files don't go through the
//     normal file-discovery pipeline, so they have no row in the
//     files table, and channel_hits.file_id has a NOT NULL FK
//     constraint. extracting them would require either inserting
//     the schema file into the files table (mixing schema with
//     source language extractors) or relaxing the FK. tracked as a
//     follow-up to #30b.

const GRAPHQL_DEF_RE = /^\s*(?:extend\s+)?(type|input|enum|interface|union|scalar)\s+([A-Z][\w]*)/gm
const TEMPLATE_TAG_RE = /\bgql\s*`([^`]+)`/g

export function linkGraphqlTypes(store: AtlasStore, projectRoot: string): { hits: number } {
	store.deleteChannelHitsByKind('graphql_type')

	const hits: ChannelHit[] = []
	const rootReal = safeRealpath(projectRoot) ?? projectRoot

	const indexedFiles = store.getAllFiles().filter((f) => !f.isTest)
	const tsExt = new Set(['.ts', '.tsx', '.js', '.jsx'])
	for (const f of indexedFiles) {
		const dot = f.path.lastIndexOf('.')
		if (dot < 0 || !tsExt.has(f.path.slice(dot))) continue
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
