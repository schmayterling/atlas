import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { log } from '../../shared/logger.js'
import type { ChannelHit } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'
import { shouldKeepIdentifier } from './channel-utils.js'

// openapi_type channel linker (#30b). extracts schema definitions
// from openapi 3.x .yaml / .yml / .json files under the project root
// and matches them against ts/go symbols that already live in the
// store with the same name. the linker does NOT pull in a yaml parser
// dep — instead it does an indent-aware line scan to find the
// `components.schemas.X:` keys, which is sufficient for the openapi
// 3 schema layout. arbitrary yaml structures (custom anchors,
// flow-style maps) will be missed; that is documented as a known
// limitation.
//
// scope:
//   - openapi 3.x components.schemas.* keys
//   - swagger 2.0 definitions.* keys (legacy, included for compat)
//   - matched against indexed ts/go symbols by exact name; the
//     match is recorded as a heuristic name-link (no signature check)
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
	let schemasIndent = -1
	let definitionsIndent = -1

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
			if (inDefinitions) definitionsIndent = 0
			continue
		}

		if (inComponents && stripped.trim().startsWith('schemas:')) {
			inSchemas = true
			schemasIndent = indent
			continue
		}

		if (inSchemas && indent === schemasIndent + 2) {
			const m = stripped.trim().match(/^([A-Z][\w]+)\s*:/)
			if (m) {
				out.push({ name: m[1], relPath, line: i + 1 })
			}
		}

		if (inDefinitions && indent === definitionsIndent + 2) {
			const m = stripped.trim().match(/^([A-Z][\w]+)\s*:/)
			if (m) {
				out.push({ name: m[1], relPath, line: i + 1 })
			}
		}
	}

	return out
}

function walkOpenApi(root: string, dir: string, out: OpenApiSchema[]): void {
	let entries: string[]
	try {
		entries = readdirSync(dir)
	} catch (e) {
		log.debug(`openapi-linker: readdir ${dir}: ${e}`)
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
		}
		if (lstat.isDirectory() || lstat.isSymbolicLink()) {
			let isDir = lstat.isDirectory()
			if (lstat.isSymbolicLink()) {
				try {
					isDir = lstatSync(realpathSync(abs)).isDirectory()
				} catch {
					isDir = false
				}
			}
			if (isDir) {
				walkOpenApi(root, abs, out)
				continue
			}
		}
		// only scan yaml files whose basename hints at openapi /
		// swagger to avoid scanning every config yaml in the repo
		const lower = entry.toLowerCase()
		const looksOpenApi =
			(lower.endsWith('.yaml') || lower.endsWith('.yml')) &&
			(lower.includes('openapi') || lower.includes('swagger') || lower === 'api.yaml' || lower === 'api.yml')
		if (!looksOpenApi) continue
		try {
			const content = readFileSync(abs, 'utf-8')
			// quick smoke test: file must mention openapi or swagger
			// somewhere in the first 200 lines, otherwise it's some
			// other yaml that happens to share the basename.
			const head = content.split('\n').slice(0, 200).join('\n')
			if (!/openapi:|swagger:/i.test(head)) continue
			const relPath = relative(root, abs)
			const found = extractSchemasFromYaml(content, relPath)
			out.push(...found)
		} catch (e) {
			log.warn(`openapi-linker: read ${abs}: ${e}`)
		}
	}
}

function safeRealpath(p: string): string | null {
	try {
		return realpathSync(p)
	} catch {
		return null
	}
}

function isUnderRoot(abs: string, root: string): boolean {
	const normRoot = root.endsWith('/') ? root : `${root}/`
	return abs === root || abs.startsWith(normRoot)
}
