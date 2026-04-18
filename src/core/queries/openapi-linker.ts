import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { log } from '../../shared/logger.js'
import type { ChannelHit } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'
import { isUnderRoot, safeRealpath, shouldKeepIdentifier } from './channel-utils.js'

// openapi_type channel linker. extracts schema definitions from
// openapi 3.x / swagger 2.0 yaml files (`.yaml`/`.yml`) and openapi
// json bundles (`.json`) under the project root, and matches them
// against indexed ts/go symbols that share a name. no yaml parser
// dep: an indent-aware line scan picks out `components.schemas.X:`
// keys for yaml. json bundles parse with JSON.parse and walk
// components.schemas / definitions directly.
//
// scope:
//   - openapi 3.x components.schemas.* keys (yaml + json)
//   - swagger 2.0 definitions.* keys (legacy compat, yaml + json)
//   - matches indexed ts/go symbols by exact name; recorded as a
//     heuristic name-link with no signature check
//
// hits write to channel_hits with kind='openapi_type'. each hit is
// attributed to the matching ts/go symbol's stable_id so the channels
// view groups the schema name with all symbols sharing the same name.

const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'.atlas',
	'vendor',
	'target',
	'.next',
	'.nuxt',
	'.output',
	'coverage',
])

interface OpenApiSchema {
	name: string
	relPath: string
	line: number
}

export function linkOpenApiTypes(store: AtlasStore, projectRoot: string): { hits: number } {
	store.deleteChannelHitsByKind('openapi_type')

	const rootReal = safeRealpath(projectRoot) ?? projectRoot
	const schemas: OpenApiSchema[] = []
	walkOpenApi(rootReal, rootReal, schemas)
	if (schemas.length === 0) return { hits: 0 }

	// dedupe schema names so the symbol lookup is one batched query
	const uniqueNames = Array.from(new Set(schemas.map((s) => s.name).filter((n) => shouldKeepIdentifier(n))))
	if (uniqueNames.length === 0) return { hits: 0 }

	// match against indexed ts/go symbols by exact name. only certain
	// kinds make sense as openapi schema mirrors (interface, type, class,
	// struct). function/method matches would be noise.
	const allowedKinds = ['interface', 'type', 'class']
	const namePlaceholders = uniqueNames.map(() => '?').join(',')
	const kindPlaceholders = allowedKinds.map(() => '?').join(',')
	const symbolRows = store.queryRawWithParams<{
		stableId: string
		name: string
		kind: string
		fileId: number
	}>(
		`SELECT s.stable_id as stableId, s.name as name, s.kind as kind, s.file_id as fileId
		 FROM symbols s
		 JOIN files f ON f.id = s.file_id
		 WHERE s.name IN (${namePlaceholders})
		   AND s.kind IN (${kindPlaceholders})
		   AND f.is_test = 0`,
		...uniqueNames,
		...allowedKinds,
	)

	const hits: ChannelHit[] = []
	const symsByName = new Map<string, Array<{ stableId: string; fileId: number }>>()
	for (const row of symbolRows) {
		const list = symsByName.get(row.name) ?? []
		list.push({ stableId: row.stableId, fileId: row.fileId })
		symsByName.set(row.name, list)
	}

	for (const schema of schemas) {
		const matches = symsByName.get(schema.name)
		if (!matches) continue
		for (const m of matches) {
			hits.push({
				symbolStableId: m.stableId,
				fileId: m.fileId,
				kind: 'openapi_type',
				value: schema.name,
				line: schema.line,
				metadata: JSON.stringify({ schemaPath: schema.relPath }),
			})
		}
	}

	if (hits.length > 0) store.insertChannelHits(hits)
	return { hits: hits.length }
}

// indent-aware line scan: track when we enter `components:` then
// `schemas:` then collect every key indented exactly two more spaces.
// also handles swagger 2.0's top-level `definitions:` block. enough
// to cover the common openapi 3 layout without a yaml parser dep.
function extractSchemasFromYaml(content: string, relPath: string): OpenApiSchema[] {
	const out: OpenApiSchema[] = []
	const lines = content.split('\n')
	let inComponents = false
	let inSchemas = false
	let inDefinitions = false
	let componentsIndent = -1
	let schemasIndent = -1
	let definitionsIndent = -1
	const schemaEntryRe = /^([A-Z][\w]+)\s*:/

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const stripped = line.replace(/\s+$/, '')
		if (stripped.length === 0 || stripped.trimStart().startsWith('#')) continue
		const indent = line.length - line.trimStart().length

		// top-level keys (indent === 0) reset all section flags
		if (indent === 0) {
			inComponents = stripped.startsWith('components:')
			inDefinitions = stripped.startsWith('definitions:')
			inSchemas = false
			componentsIndent = inComponents ? 0 : -1
			schemasIndent = -1
			definitionsIndent = inDefinitions ? 0 : -1
			continue
		}

		// when we pop back to a sibling of `schemas:` under `components:`
		// (e.g. `responses:`, `parameters:`, `headers:`), exit the schemas
		// scope so capitalized keys beneath those sections aren't
		// mis-attributed. swagger 2.0 definitions are single-level so no
		// equivalent handling is needed.
		if (inSchemas && indent <= schemasIndent) {
			inSchemas = false
			schemasIndent = -1
		}

		if (inComponents && indent === componentsIndent + 2 && stripped.trim().startsWith('schemas:')) {
			inSchemas = true
			schemasIndent = indent
			continue
		}

		if (inSchemas && indent === schemasIndent + 2) {
			const m = stripped.trim().match(schemaEntryRe)
			if (m) out.push({ name: m[1], relPath, line: i + 1 })
			continue
		}

		if (inDefinitions && indent === definitionsIndent + 2) {
			const m = stripped.trim().match(schemaEntryRe)
			if (m) out.push({ name: m[1], relPath, line: i + 1 })
		}
	}

	return out
}

// openapi json bundles either live under `components.schemas.*`
// (openapi 3.x) or `definitions.*` (swagger 2.0). we require the
// `openapi` or `swagger` top-level marker to avoid treating random
// json configs as schemas. line numbers aren't meaningful inside a
// compact json, so we record line 1 for every hit.
function extractSchemasFromJson(content: string, relPath: string): OpenApiSchema[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch (e) {
		log.warn(`openapi-linker: JSON.parse failed for ${relPath}: ${e}`)
		return []
	}
	if (!parsed || typeof parsed !== 'object') return []
	const doc = parsed as Record<string, unknown>
	if (!('openapi' in doc) && !('swagger' in doc)) return []
	const out: OpenApiSchema[] = []
	const components = doc.components as Record<string, unknown> | undefined
	const schemas = components && typeof components === 'object'
		? (components.schemas as Record<string, unknown> | undefined)
		: undefined
	if (schemas && typeof schemas === 'object') {
		for (const name of Object.keys(schemas)) {
			if (/^[A-Z][\w]*$/.test(name)) out.push({ name, relPath, line: 1 })
		}
	}
	const definitions = doc.definitions as Record<string, unknown> | undefined
	if (definitions && typeof definitions === 'object') {
		for (const name of Object.keys(definitions)) {
			if (/^[A-Z][\w]*$/.test(name)) out.push({ name, relPath, line: 1 })
		}
	}
	return out
}

function walkOpenApi(root: string, dir: string, out: OpenApiSchema[]): void {
	let entries: string[]
	try {
		entries = readdirSync(dir)
	} catch (e) {
		log.warn(`openapi-linker: readdir ${dir}: ${e}`)
		return
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue
		const abs = join(dir, entry)
		let lstat
		try {
			lstat = lstatSync(abs)
		} catch {
			continue
		}
		if (lstat.isSymbolicLink()) {
			const real = safeRealpath(abs)
			if (!real || !isUnderRoot(real, root)) continue
			// resolve link target shape without a second unguarded
			// realpathSync; the previous call already validated root
			// containment and gave us the real path.
			let targetStat
			try {
				targetStat = lstatSync(real)
			} catch {
				continue
			}
			if (targetStat.isDirectory()) {
				walkOpenApi(root, abs, out)
				continue
			}
		} else if (lstat.isDirectory()) {
			walkOpenApi(root, abs, out)
			continue
		}
		// only scan files whose basename hints at openapi / swagger
		// to avoid scanning every config yaml / json in the repo.
		const lower = entry.toLowerCase()
		const isYaml = lower.endsWith('.yaml') || lower.endsWith('.yml')
		const isJson = lower.endsWith('.json')
		const looksOpenApi =
			(isYaml || isJson) &&
			(lower.includes('openapi') || lower.includes('swagger') ||
				lower === 'api.yaml' || lower === 'api.yml' || lower === 'api.json')
		if (!looksOpenApi) continue
		try {
			const content = readFileSync(abs, 'utf-8')
			const relPath = relative(root, abs)
			if (isJson) {
				const found = extractSchemasFromJson(content, relPath)
				out.push(...found)
				continue
			}
			// quick smoke test: file must mention openapi or swagger
			// somewhere in the first 200 lines, otherwise it's some
			// other yaml that happens to share the basename.
			const head = content.split('\n').slice(0, 200).join('\n')
			if (!/openapi:|swagger:/i.test(head)) continue
			const found = extractSchemasFromYaml(content, relPath)
			out.push(...found)
		} catch (e) {
			log.warn(`openapi-linker: read ${abs}: ${e}`)
		}
	}
}

