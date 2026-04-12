import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, getDbPath } from '../../src/shared/config.js'

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
