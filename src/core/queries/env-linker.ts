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

// env-var channel linker (#30). detects every site that reads an
// environment variable across ts/js, go, and python idioms. groups
// symbols by env var name so users can answer "which symbols touch
// STRIPE_KEY" without grepping. follows the sql-linker / queue-linker
// shape: walk source files already in the store, regex over the file
// body, gate via channel-utils.shouldKeepIdentifier, write
// channel_hits rows with kind='env_var'. metadata records the access
// pattern (direct, getter, framework helper) so the channels show ui
// can group them.
//
// scope: literal-keyed reads only. variable-derived names
// (`process.env[VAR]` where VAR is a const) are out of scope because
// resolving the variable would require interpreter analysis.

interface EnvPattern {
	source: string
	regex: RegExp
}

const ENV_PATTERNS: EnvPattern[] = [
	// node / typescript: process.env.X and process.env['X']
	{ source: 'node', regex: /process\.env\.([A-Z][A-Z0-9_]+)/g },
	{ source: 'node', regex: /process\.env\[\s*['"`]([A-Z][A-Z0-9_]+)['"`]\s*\]/g },
	// import.meta.env (vite/astro)
	{ source: 'vite', regex: /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g },
	// go stdlib: os.Getenv("X")
	{ source: 'go', regex: /os\.Getenv\s*\(\s*['"`]([A-Z][A-Z0-9_]+)['"`]\s*\)/g },
	// go stdlib: os.LookupEnv("X")
	{ source: 'go', regex: /os\.LookupEnv\s*\(\s*['"`]([A-Z][A-Z0-9_]+)['"`]\s*\)/g },
	// viper: viper.GetString("KEY") / GetInt / GetBool / GetFloat64
	{ source: 'viper', regex: /viper\.Get\w*\s*\(\s*['"`]([\w.]+)['"`]\s*\)/g },
	// python: os.environ['X'] / os.environ.get('X')
	{ source: 'python', regex: /os\.environ\[\s*['"`]([A-Z][A-Z0-9_]+)['"`]\s*\]/g },
	{ source: 'python', regex: /os\.environ\.get\s*\(\s*['"`]([A-Z][A-Z0-9_]+)['"`]/g },
	// python: os.getenv('X')
	{ source: 'python', regex: /os\.getenv\s*\(\s*['"`]([A-Z][A-Z0-9_]+)['"`]/g },
]

// channel-specific extras: env names that are ubiquitous and not
// project-meaningful (PATH, HOME, USER, NODE_ENV, GO_ENV...).
const ENV_EXTRAS = new Set<string>([
	'path',
	'home',
	'user',
	'pwd',
	'shell',
	'lang',
	'tmp',
	'tmpdir',
	'temp',
])

export function linkEnvVars(store: AtlasStore, projectRoot: string): { hits: number } {
	store.deleteChannelHitsByKind('env_var')

	const files = store.getAllFiles().filter((f) => !f.isTest)
	const hits: ChannelHit[] = []
	const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.go', '.py'])
	const rootReal = safeRealpath(projectRoot) ?? projectRoot

	for (const f of files) {
		const dot = f.path.lastIndexOf('.')
		if (dot < 0) continue
		const ext = f.path.slice(dot)
		if (!allowedExtensions.has(ext)) continue

		const resolved = resolvePath(projectRoot, f.path)
		const resolvedReal = safeRealpath(resolved)
		if (resolvedReal && !isUnderRoot(resolvedReal, rootReal)) continue

		let source: string
		try {
			source = readFileSync(resolved, 'utf-8')
		} catch (e) {
			log.warn(`env-linker: read ${f.path}: ${e}`)
			continue
		}

		const lineOffsets = buildLineOffsets(source)

		for (const pat of ENV_PATTERNS) {
			for (const m of source.matchAll(pat.regex)) {
				const raw = m[1]
				const matchIndex = m.index
				if (!raw || matchIndex === undefined) continue
				// env vars use uppercase + underscore; we keep the original
				// casing as the canonical value. shouldKeepIdentifier does
				// a case-insensitive comparison against denylists.
				if (!shouldKeepIdentifier(raw, { extras: ENV_EXTRAS })) continue

				const line = offsetToLine(lineOffsets, matchIndex) + 1
				const enclosing = store.getSymbolContainingByte(f.id, matchIndex)
				if (!enclosing) continue

				hits.push({
					symbolStableId: enclosing.stableId,
					fileId: f.id,
					kind: 'env_var',
					value: raw,
					line,
					metadata: JSON.stringify({ source: pat.source }),
				})
			}
		}
	}

	if (hits.length > 0) store.insertChannelHits(hits)
	return { hits: hits.length }
}

