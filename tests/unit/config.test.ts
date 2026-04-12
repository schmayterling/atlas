import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TEST_PATTERNS, loadConfig, getDbPath, normalizeTestPatterns } from '../../src/shared/config.js'
import { log } from '../../src/shared/logger.js'

function withTempProject(fn: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), 'atlas-config-'))
	try {
		fn(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

describe('loadConfig', () => {
	test('returns defaults when .atlas/config.json is absent', () => {
		withTempProject((root) => {
			const config = loadConfig(root)
			expect(config.languages.typescript).toBeDefined()
			expect(config.languages.python).toBeDefined()
			expect(config.languages.go).toBeDefined()
			expect(config.languages.rust).toBeDefined()
			expect(config.exclude).toContain('**/node_modules/**')
		})
	})

	test('reads explicit config when present', () => {
		withTempProject((root) => {
			mkdirSync(join(root, '.atlas'), { recursive: true })
			writeFileSync(
				join(root, '.atlas/config.json'),
				JSON.stringify({
					include: ['src/**/*.ts'],
					exclude: ['**/skipme/**'],
					languages: { typescript: { extensions: ['.ts'] } },
				}),
			)
			const config = loadConfig(root)
			expect(config.include).toEqual(['src/**/*.ts'])
			expect(config.exclude).toEqual(['**/skipme/**'])
		})
	})

	test('throws on malformed JSON', () => {
		withTempProject((root) => {
			mkdirSync(join(root, '.atlas'), { recursive: true })
			writeFileSync(join(root, '.atlas/config.json'), '{not valid json')
			expect(() => loadConfig(root)).toThrow()
		})
	})
})

describe('testPatterns', () => {
	test('default patterns include the canonical test layouts', () => {
		withTempProject((root) => {
			const config = loadConfig(root)
			expect(config.testPatterns).toEqual([...DEFAULT_TEST_PATTERNS])
		})
	})

	test('default patterns cover go and python test conventions', () => {
		expect(DEFAULT_TEST_PATTERNS).toContain('**/*_test.go')
		expect(DEFAULT_TEST_PATTERNS).toContain('**/*_test.py')
		expect(DEFAULT_TEST_PATTERNS).toContain('**/test_*.py')
	})

	test('normalizeTestPatterns rewrites only bare directory forms', () => {
		expect(normalizeTestPatterns(['tests/**', 'spec', '__tests__', '*.spec.ts', '**/already/**'])).toEqual([
			'**/tests/**',
			'**/spec/**',
			'**/__tests__/**',
			'*.spec.ts',
			'**/already/**',
		])
	})

	test('normalizeTestPatterns leaves multi-segment and file globs alone', () => {
		// these patterns can't be matched by file-discovery's matchPattern
		// either way, but rewriting them would silently produce impossible
		// directory patterns. leaving them alone preserves user intent.
		expect(
			normalizeTestPatterns(['foo.test.ts', 'src/**/__tests__/**', 'tests/*', 'src/tests/**']),
		).toEqual(['foo.test.ts', 'src/**/__tests__/**', 'tests/*', 'src/tests/**'])
	})

	test('loadConfig normalizes user-supplied testPatterns', () => {
		withTempProject((root) => {
			mkdirSync(join(root, '.atlas'), { recursive: true })
			writeFileSync(
				join(root, '.atlas/config.json'),
				JSON.stringify({ testPatterns: ['tests/**', '__tests__'] }),
			)
			const config = loadConfig(root)
			expect(config.testPatterns).toEqual(['**/tests/**', '**/__tests__/**'])
		})
	})

	test('loadConfig warns when legacy test excludes are present without testPatterns', () => {
		const warns: string[] = []
		const original = log.warn
		log.warn = ((msg: string) => warns.push(msg)) as typeof log.warn
		try {
			withTempProject((root) => {
				mkdirSync(join(root, '.atlas'), { recursive: true })
				writeFileSync(
					join(root, '.atlas/config.json'),
					JSON.stringify({ exclude: ['**/*.test.*', '**/node_modules/**'] }),
				)
				loadConfig(root)
			})
			expect(warns.some((w) => w.includes('atlas now indexes test files'))).toBe(true)
		} finally {
			log.warn = original
		}
	})

	test('loadConfig warns on directory-style legacy test excludes too', () => {
		const warns: string[] = []
		const original = log.warn
		log.warn = ((msg: string) => warns.push(msg)) as typeof log.warn
		try {
			withTempProject((root) => {
				mkdirSync(join(root, '.atlas'), { recursive: true })
				writeFileSync(
					join(root, '.atlas/config.json'),
					JSON.stringify({ exclude: ['**/tests/**', '**/node_modules/**'] }),
				)
				loadConfig(root)
			})
			expect(warns.some((w) => w.includes('atlas now indexes test files'))).toBe(true)
		} finally {
			log.warn = original
		}
	})

	test('loadConfig does not warn when user already supplied testPatterns', () => {
		const warns: string[] = []
		const original = log.warn
		log.warn = ((msg: string) => warns.push(msg)) as typeof log.warn
		try {
			withTempProject((root) => {
				mkdirSync(join(root, '.atlas'), { recursive: true })
				writeFileSync(
					join(root, '.atlas/config.json'),
					JSON.stringify({
						exclude: ['**/*.test.*'],
						testPatterns: ['**/__tests__/**'],
					}),
				)
				loadConfig(root)
			})
			expect(warns.length).toBe(0)
		} finally {
			log.warn = original
		}
	})
})

describe('getDbPath', () => {
	test('joins project root with config indexPath', () => {
		withTempProject((root) => {
			const config = loadConfig(root)
			const dbPath = getDbPath(root, config)
			expect(dbPath.startsWith(root)).toBe(true)
			expect(dbPath).toContain('.atlas')
		})
	})
})
