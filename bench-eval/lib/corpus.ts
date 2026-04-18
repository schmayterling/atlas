// idempotent git clone + checkout into .bench-cache/<name>/<short_ref>/.
// the cache is gitignored. callers get an absolute path to feed into
// getOrCreateEngine().
//
// philosophy: small surface, no fancy clone strategies. depth=100 keeps
// last-changed/contributors queries usable without pulling all of history.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface CorpusManifest {
	name: string
	git_url: string
	ref: string
	expected_languages: string[]
	root_subdir?: string
	notes?: string
}

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const CACHE_ROOT = join(REPO_ROOT, '.bench-cache')

export function loadManifest(corpusName: string): CorpusManifest {
	const path = join(REPO_ROOT, 'bench-eval', 'corpora', corpusName, 'manifest.json')
	if (!existsSync(path)) throw new Error(`no manifest for corpus '${corpusName}' at ${path}`)
	const raw = JSON.parse(readFileSync(path, 'utf-8')) as CorpusManifest
	if (!raw.git_url || !raw.ref) throw new Error(`manifest ${path} missing git_url or ref`)
	return { ...raw, name: corpusName }
}

export function listCorpora(): string[] {
	const dir = join(REPO_ROOT, 'bench-eval', 'corpora')
	if (!existsSync(dir)) return []
	const { readdirSync } = require('node:fs')
	return (readdirSync(dir) as string[])
		.filter((entry) => {
			try { return statSync(join(dir, entry)).isDirectory() } catch { return false }
		})
		.sort()
}

// shortRef: 12 chars; enough to disambiguate but keeps cache paths readable.
function shortRef(ref: string): string {
	const cleaned = ref.replace(/[^a-zA-Z0-9._-]/g, '_')
	return cleaned.length > 12 ? cleaned.slice(0, 12) : cleaned
}

export interface EnsureResult {
	rootPath: string  // absolute path the engine should index
	clonePath: string // absolute path to the clone (may equal rootPath if no root_subdir)
	cached: boolean   // true if we skipped the clone
}

export function ensureCorpus(manifest: CorpusManifest, opts?: { freshClone?: boolean }): EnsureResult {
	mkdirSync(CACHE_ROOT, { recursive: true })
	const clonePath = join(CACHE_ROOT, manifest.name, shortRef(manifest.ref))
	const rootPath = manifest.root_subdir ? join(clonePath, manifest.root_subdir) : clonePath

	if (!opts?.freshClone && existsSync(join(clonePath, '.git'))) {
		return { rootPath, clonePath, cached: true }
	}

	mkdirSync(clonePath, { recursive: true })
	// shallow clone with depth=100 keeps git/contributors/lastChanged queries
	// usable while staying under ~100MB for most repos.
	run('git', ['init', '--quiet'], clonePath)
	run('git', ['remote', 'add', 'origin', manifest.git_url], clonePath)
	// fetch by SHA via partial clone — works on github since 2020.
	const fetchResult = spawnSync(
		'git',
		['fetch', '--quiet', '--depth', '100', 'origin', manifest.ref],
		{ cwd: clonePath, stdio: 'inherit' },
	)
	if (fetchResult.status !== 0) {
		// fallback: full fetch then checkout. slower but tolerates branch refs etc.
		run('git', ['fetch', '--quiet', '--depth', '100', 'origin'], clonePath)
	}
	run('git', ['checkout', '--quiet', manifest.ref], clonePath)

	return { rootPath, clonePath, cached: false }
}

function run(cmd: string, args: string[], cwd: string): void {
	const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`)
}
