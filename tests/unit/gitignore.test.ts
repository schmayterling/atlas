import { describe, expect, test } from 'bun:test'
import { parseGitignore } from '../../src/core/indexer/gitignore.js'

describe('parseGitignore', () => {
	test('bare directory names land in skipDirs and excludePatterns', () => {
		const r = parseGitignore('node_modules/\n.bench-cache/\n.claude/\n')
		expect(r.skipDirs).toContain('node_modules')
		expect(r.skipDirs).toContain('.bench-cache')
		expect(r.skipDirs).toContain('.claude')
		expect(r.excludePatterns).toContain('**/node_modules/**')
		expect(r.excludePatterns).toContain('**/.bench-cache/**')
	})

	test('extension globs become **/*.ext', () => {
		const r = parseGitignore('*.db\n*.log\n')
		expect(r.excludePatterns).toContain('**/*.db')
		expect(r.excludePatterns).toContain('**/*.log')
	})

	test('comments and blank lines are ignored', () => {
		const r = parseGitignore('# top of file\n\n\n# inline comment line\nnode_modules/\n')
		expect(r.skipDirs.size).toBe(1)
		expect(r.excludePatterns).toEqual(['**/node_modules/**'])
	})

	test('negation patterns are skipped (not yet supported)', () => {
		const r = parseGitignore('build/\n!build/keep-this/\n')
		expect(r.skipDirs.has('build')).toBe(true)
		expect(r.skipDirs.has('build/keep-this')).toBe(false)
		// no negation pattern leaked into excludes
		for (const p of r.excludePatterns) expect(p).not.toContain('!')
	})

	test('leading slash is stripped (atlas patterns match anywhere)', () => {
		const r = parseGitignore('/dist/\n/.atlas/\n')
		expect(r.skipDirs).toContain('dist')
		expect(r.skipDirs).toContain('.atlas')
	})

	test('subpath without trailing slash is treated as a path', () => {
		const r = parseGitignore('docs/internal/secret.md\n')
		expect(r.excludePatterns).toContain('docs/internal/secret.md')
	})

	test('bare filename becomes **/<name>', () => {
		const r = parseGitignore('CLAUDE.md\n.DS_Store\n')
		expect(r.excludePatterns).toContain('**/CLAUDE.md')
		expect(r.excludePatterns).toContain('**/.DS_Store')
	})

	test('CRLF line endings handled', () => {
		const r = parseGitignore('node_modules/\r\n.atlas/\r\n')
		expect(r.skipDirs).toContain('node_modules')
		expect(r.skipDirs).toContain('.atlas')
	})

	test('subdir glob shape passes through', () => {
		const r = parseGitignore('packages/*/dist/\n')
		expect(r.excludePatterns).toContain('**/packages/*/dist/**')
	})
})
