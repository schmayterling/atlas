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
		}),
	indexPath: z.string().default('.atlas/atlas.db'),
})

export type AtlasConfig = z.infer<typeof ConfigSchema>

// rewrite test pattern shapes that the file-discovery matchPattern can't
// handle into the **/X/** form it understands. bare 'tests/**' or 'tests'
// would otherwise silently match nothing.
export function normalizeTestPatterns(patterns: string[]): string[] {
	return patterns.map((raw) => {
		const p = raw.trim()
		if (!p) return p
		if (p.startsWith('**/')) return p
		if (p.startsWith('*.')) return `**/${p}`
		if (p.endsWith('/**')) return `**/${p.slice(0, -3)}/**`
		return `**/${p}/**`
	})
}

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
				(p) => typeof p === 'string' && (p.includes('*.test.') || p.includes('*.spec.')),
			)
		const hasNoTestPatterns =
			!userRaw.testPatterns || (Array.isArray(userRaw.testPatterns) && userRaw.testPatterns.length === 0)
		if (hasLegacyTestExcludes && hasNoTestPatterns) {
			log.warn(
				`atlas now indexes test files by default. remove **/*.test.* and **/*.spec.* from "exclude" in ${configPath} to enable atlas tests / hot-fragile / coverage queries.`,
			)
		}
	}
	return parsed
}

export function getDbPath(projectRoot: string, config: AtlasConfig): string {
	return join(projectRoot, config.indexPath)
}
