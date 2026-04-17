import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { log } from './logger.js'

export const DEFAULT_TEST_PATTERNS = [
	'**/*.test.*',
	'**/*.spec.*',
	'**/tests/**',
	'**/__tests__/**',
	'**/test/**',
	// go convention: foo_test.go sits next to foo.go
	'**/*_test.go',
	// python conventions: pytest and unittest style both in use
	'**/*_test.py',
	'**/test_*.py',
] as const

const ConfigSchema = z.object({
	include: z
		.array(z.string())
		.default([
			'**/*.ts',
			'**/*.tsx',
			'**/*.js',
			'**/*.jsx',
			'**/*.py',
			'**/*.go',
			'**/*.rs',
		]),
	exclude: z
		.array(z.string())
		.default([
			'**/node_modules/**',
			'**/dist/**',
			'**/build/**',
			'**/.git/**',
		]),
	testPatterns: z.array(z.string()).default([...DEFAULT_TEST_PATTERNS]),
	languages: z
		.record(z.object({ extensions: z.array(z.string()) }))
		.default({
			typescript: { extensions: ['.ts', '.tsx'] },
			javascript: { extensions: ['.js', '.jsx', '.mjs', '.cjs'] },
			python: { extensions: ['.py'] },
			go: { extensions: ['.go'] },
			rust: { extensions: ['.rs'] },
			// graphql schema-only language. no tree-sitter grammar or
			// extractor is registered; the indexer records a file row
			// (0 symbols) so the graphql channel linker can attribute
			// channel_hits.file_id against a real file rather than
			// widening the FK constraint. see #66.
			graphql: { extensions: ['.graphql', '.graphqls', '.gql'] },
		}),
	indexPath: z.string().default('.atlas/atlas.db'),
})

export type AtlasConfig = z.infer<typeof ConfigSchema>

// rewrite the small set of legacy directory shapes the file-discovery
// matchPattern can't handle directly. bare `tests` or `tests/**` would
// otherwise silently match nothing because matchPattern only recognizes
// `**/<dir>/**`. patterns that already use any matchPattern-supported
// shape (`**/...`, `*.ext`, exact path) are returned untouched, since
// rewriting them would turn valid file globs into impossible directory
// patterns (e.g. `foo.test.ts` -> `**/foo.test.ts/**`).
export function normalizeTestPatterns(patterns: string[]): string[] {
	return patterns.map((raw) => {
		const p = raw.trim()
		if (!p) return p
		// already in a shape matchPattern handles
		if (p.startsWith('**/')) return p
		if (p.startsWith('*.')) return p
		// bare `dir/**` -> `**/dir/**`
		if (p.endsWith('/**')) {
			const inner = p.slice(0, -3)
			// only rewrite if the inner part is a single directory name
			// without slashes; multi-segment paths (`src/tests/**`) are
			// left alone because matchPattern can't match them anyway and
			// silently rewriting them is misleading.
			if (inner && !inner.includes('/')) return `**/${inner}/**`
			return p
		}
		// bare directory name with no slashes -> `**/dir/**`
		if (!p.includes('/') && !p.includes('*') && !p.includes('.')) {
			return `**/${p}/**`
		}
		return p
	})
}

// directory-style fragments that, when present in a user's exclude list,
// would silently suppress every test file discovered by tier 4 even though
// the new tier-4 features expect to see them.
const LEGACY_TEST_EXCLUDE_FRAGMENTS = [
	'*.test.',
	'*.spec.',
	'/tests/',
	'/__tests__/',
	'/test/',
] as const

export function loadConfig(projectRoot: string): AtlasConfig {
	const configPath = join(projectRoot, '.atlas', 'config.json')
	let parsed: AtlasConfig
	let raw: unknown = null
	if (existsSync(configPath)) {
		try {
			raw = JSON.parse(readFileSync(configPath, 'utf-8'))
			parsed = ConfigSchema.parse(raw)
		} catch (e) {
			throw new Error(`invalid atlas config at ${configPath}: ${e}`)
		}
	} else {
		parsed = ConfigSchema.parse({})
	}
	parsed.testPatterns = normalizeTestPatterns(parsed.testPatterns)
	if (raw && typeof raw === 'object') {
		const userRaw = raw as { exclude?: unknown; testPatterns?: unknown }
		const hasLegacyTestExcludes =
			Array.isArray(userRaw.exclude) &&
			userRaw.exclude.some(
				(p) =>
					typeof p === 'string' &&
					LEGACY_TEST_EXCLUDE_FRAGMENTS.some((f) => p.includes(f)),
			)
		const hasNoTestPatterns =
			!userRaw.testPatterns || (Array.isArray(userRaw.testPatterns) && userRaw.testPatterns.length === 0)
		if (hasLegacyTestExcludes && hasNoTestPatterns) {
			log.warn(
				`atlas now indexes test files by default. remove test patterns (**/*.test.*, **/*.spec.*, **/tests/**, **/__tests__/**, **/test/**) from "exclude" in ${configPath} to enable atlas tests / hot-fragile / coverage queries.`,
			)
		}
	}
	return parsed
}

export function getDbPath(projectRoot: string, config: AtlasConfig): string {
	return join(projectRoot, config.indexPath)
}
