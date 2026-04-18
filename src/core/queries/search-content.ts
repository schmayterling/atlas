// content search over indexed source files. structural atlas_search matches
// by symbol name; this tool answers "which files mention this string?" , a
// capability atlas's graph index cannot cover on its own.
//
// implementation: shell out to ripgrep (`rg`), scoped via a glob of indexed
// files and always using -F (fixed-string) to prevent regex-syntax confusion
// when agents pass literal search strings containing special characters.
// returns matches grouped by file plus aggregate counts.
//
// why rg: the bench-llm baseline agent already depends on rg being on PATH
// for its text tool surface, and rg is ~10× faster than node-side scanning
// on real-world corpora.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { log } from '../../shared/logger.js'
import type { AtlasStore } from '../storage/store.js'

export interface ContentMatch {
	file: string
	line: number
	text: string
}

export interface ContentSearchResult {
	query: string
	matches: ContentMatch[]
	fileCount: number
	matchCount: number
	// when non-null, rg was unavailable or errored and we returned an
	// empty result rather than throwing. callers can surface this to the
	// user without breaking on machines without rg installed.
	warning?: string
}

export interface ContentSearchOpts {
	pathPrefix?: string
	language?: string
	maxMatches?: number
}

const DEFAULT_MAX_MATCHES = 200
const LINE_TRUNC = 200

export function searchContent(
	store: AtlasStore,
	projectRoot: string,
	query: string,
	opts?: ContentSearchOpts,
): ContentSearchResult {
	if (!query || query.length === 0) {
		return { query, matches: [], fileCount: 0, matchCount: 0, warning: 'empty query' }
	}

	const max = opts?.maxMatches ?? DEFAULT_MAX_MATCHES
	const files = filterIndexedFiles(store, projectRoot, opts)
	if (files.length === 0) {
		return { query, matches: [], fileCount: 0, matchCount: 0, warning: 'no indexed files match filters' }
	}

	// rg arguments:
	//   -F  : fixed-string search (no regex). atlases pass literal queries
	//         like "pcre2", "TODO", "safeParse", never regex.
	//   -n  : include 1-indexed line numbers.
	//   --no-heading / --color=never : machine-parseable output.
	//   --max-count : per-file cap so pathological files don't dominate.
	//   --max-columns 400 : cap line length at the rg layer; we truncate
	//                       further below for the response payload.
	//   --regexp=... : pass the query via the option form so a user query
	//                  starting with "-" (e.g. "--files", "--pre=/bin/bad")
	//                  cannot be re-parsed as an rg flag. combined with -F
	//                  this stays a fixed-string search; combined with the
	//                  "=" form the value can never be mistaken for a flag
	//                  regardless of its contents. critical: without this
	//                  option-injection lets a caller trigger --pre which
	//                  executes an arbitrary binary.
	const rgArgs = [
		'-F',
		'-n',
		'--no-heading',
		'--color=never',
		`--max-count=${Math.max(1, Math.ceil(max / Math.max(1, files.length)))}`,
		'--max-columns=400',
		`--regexp=${query}`,
		'--',
		...files.map((f) => f.absPath),
	]

	const out = spawnSync('rg', rgArgs, { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 })
	if (out.error) {
		const code = (out.error as NodeJS.ErrnoException).code
		if (code === 'ENOENT') {
			return { query, matches: [], fileCount: 0, matchCount: 0, warning: 'ripgrep (rg) not installed' }
		}
		log.warn(`searchContent rg failed: ${out.error}`)
		return { query, matches: [], fileCount: 0, matchCount: 0, warning: `rg failed: ${out.error.message}` }
	}
	// rg exit 1 means "no matches", which is a valid result.
	if (out.status !== 0 && out.status !== 1) {
		return { query, matches: [], fileCount: 0, matchCount: 0, warning: `rg exited ${out.status}: ${(out.stderr || '').slice(0, 120)}` }
	}

	const absToRel = new Map(files.map((f) => [f.absPath, f.relPath]))
	const matches: ContentMatch[] = []
	const seenFiles = new Set<string>()
	const lines = (out.stdout ?? '').split('\n')
	let rgProducedMore = false
	for (const raw of lines) {
		if (!raw) continue
		if (matches.length >= max) {
			// rg still had output past our cap, remember so we can flag
			// the returned counts as a floor rather than a ground truth.
			rgProducedMore = true
			break
		}
		// format: <absPath>:<line>:<text>
		const firstColon = raw.indexOf(':')
		if (firstColon < 0) continue
		const secondColon = raw.indexOf(':', firstColon + 1)
		if (secondColon < 0) continue
		const abs = raw.slice(0, firstColon)
		const lineStr = raw.slice(firstColon + 1, secondColon)
		const text = raw.slice(secondColon + 1)
		const lineNum = Number(lineStr)
		if (!Number.isFinite(lineNum)) continue
		const rel = absToRel.get(abs) ?? abs
		seenFiles.add(rel)
		matches.push({
			file: rel,
			line: lineNum,
			text: text.length > LINE_TRUNC ? `${text.slice(0, LINE_TRUNC)}…` : text,
		})
	}

	// surface the fact that per-file rg caps + maxMatches slicing means
	// fileCount/matchCount are a FLOOR when truncation happened, not the
	// exact repo-wide total. critical for count-type LLM questions, which
	// otherwise silently under-report.
	const truncatedByMax = rgProducedMore || matches.length >= max
	const warning = truncatedByMax
		? `result truncated at maxMatches=${max}; fileCount/matchCount are a lower bound`
		: undefined

	return {
		query,
		matches,
		fileCount: seenFiles.size,
		matchCount: matches.length,
		...(warning ? { warning } : {}),
	}
}

// pull the indexed file set from the store and apply pathPrefix / language
// filters. file.path is project-relative in the db; we compose absolute
// paths here because rg needs real FS paths.
function filterIndexedFiles(
	store: AtlasStore,
	projectRoot: string,
	opts?: ContentSearchOpts,
): Array<{ absPath: string; relPath: string }> {
	const all = store.getAllFiles()
	const prefix = opts?.pathPrefix ?? ''
	const lang = opts?.language
	const out: Array<{ absPath: string; relPath: string }> = []
	for (const f of all) {
		if (prefix && !f.path.startsWith(prefix)) continue
		if (lang && f.language !== lang) continue
		out.push({ absPath: join(projectRoot, f.path), relPath: f.path })
	}
	return out
}
