import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	detectRepoModules,
	matchFileToModule,
	type RepoModule,
} from '../../src/core/indexer/module-detector.js'
import type { DiscoveredFile } from '../../src/core/indexer/file-discovery.js'

let root: string

function df(path: string): DiscoveredFile {
	return {
		path,
		absolutePath: join(root, path),
		language: 'typescript',
		sizeBytes: 1,
		isTest: false,
	}
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'atlas-module-detect-'))
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe('detectRepoModules', () => {
	test('finds nested go.mod + package.json + pyproject.toml', () => {
		mkdirSync(join(root, 'apps/api'), { recursive: true })
		mkdirSync(join(root, 'apps/web'), { recursive: true })
		mkdirSync(join(root, 'services/worker'), { recursive: true })
		writeFileSync(join(root, 'apps/api/go.mod'), 'module github.com/example/api\n\ngo 1.22\n')
		writeFileSync(join(root, 'apps/web/package.json'), '{"name":"@example/web","version":"0.1.0"}')
		writeFileSync(
			join(root, 'services/worker/pyproject.toml'),
			'[project]\nname = "worker"\nversion = "0.1.0"\n',
		)

		const modules = detectRepoModules(root, [
			df('apps/api/main.go'),
			df('apps/web/src/app.tsx'),
			df('services/worker/worker.py'),
		])

		const byKind = (k: RepoModule['kind']) => modules.filter((m) => m.kind === k)
		expect(byKind('go')).toHaveLength(1)
		expect(byKind('node')).toHaveLength(1)
		expect(byKind('python')).toHaveLength(1)

		const goMod = byKind('go')[0]
		expect(goMod.name).toBe('api')
		expect(goMod.modulePath).toBe('github.com/example/api')
		expect(goMod.rootDir).toBe('apps/api')

		const nodeMod = byKind('node')[0]
		expect(nodeMod.name).toBe('@example/web')
		expect(nodeMod.rootDir).toBe('apps/web')

		const pyMod = byKind('python')[0]
		expect(pyMod.name).toBe('worker')
		expect(pyMod.rootDir).toBe('services/worker')
	})

	test('top-level package.json becomes a module with rootDir = ""', () => {
		writeFileSync(join(root, 'package.json'), '{"name":"atlas","version":"0.1.0"}')

		const modules = detectRepoModules(root, [df('src/index.ts')])
		expect(modules).toHaveLength(1)
		expect(modules[0].rootDir).toBe('')
		expect(modules[0].name).toBe('atlas')
	})

	test('malformed manifests are skipped silently', () => {
		mkdirSync(join(root, 'apps/bad'), { recursive: true })
		writeFileSync(join(root, 'apps/bad/package.json'), '{not valid json')

		const modules = detectRepoModules(root, [df('apps/bad/index.ts')])
		expect(modules).toHaveLength(0)
	})

	test('module ids are deterministic across runs', () => {
		mkdirSync(join(root, 'apps/api'), { recursive: true })
		writeFileSync(join(root, 'apps/api/go.mod'), 'module foo\n')

		const first = detectRepoModules(root, [df('apps/api/x.go')])
		const second = detectRepoModules(root, [df('apps/api/x.go')])
		expect(first[0].id).toBe(second[0].id)
	})
})

describe('matchFileToModule', () => {
	const modules: RepoModule[] = [
		{ id: 'r', name: 'root', kind: 'node', manifestPath: 'package.json', rootDir: '', modulePath: 'root' },
		{ id: 'a', name: 'api', kind: 'go', manifestPath: 'apps/api/go.mod', rootDir: 'apps/api', modulePath: 'example/api' },
		{ id: 'n', name: 'nested', kind: 'node', manifestPath: 'apps/api/web/package.json', rootDir: 'apps/api/web', modulePath: 'nested' },
	]

	test('picks the longest matching rootDir', () => {
		const m = matchFileToModule('apps/api/web/src/index.ts', modules)
		expect(m?.id).toBe('n')
	})

	test('falls back to the shorter rootDir when the longer one does not match', () => {
		const m = matchFileToModule('apps/api/internal/handler.go', modules)
		expect(m?.id).toBe('a')
	})

	test('uses the root-level module for files with no closer match', () => {
		const m = matchFileToModule('scripts/dogfood.ts', modules)
		expect(m?.id).toBe('r')
	})
})
