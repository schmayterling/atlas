// minimal .gitignore parser. atlas's file-discovery already supports
// glob patterns of the form **/dir/**, **/*.ext, exact paths — so we
// translate gitignore lines into those shapes rather than implementing
// the full gitignore spec (which has nested .gitignore files, negation,
// re-inclusion, anchored vs non-anchored rules, etc).
//
// scope: root .gitignore only. nested .gitignore files are not honored
// in v1 — flag this explicitly so users with monorepo subgitignores
// know to put exclude patterns in atlas.config.json.
//
// negation patterns ('!path') are skipped with a debug log. they're
// rare enough in real projects that supporting them isn't worth the
// complexity until someone hits the limitation.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../../shared/logger.js'

export interface GitignoreRules {
	// directory names safe to short-circuit during walk (no recurse)
	skipDirs: Set<string>
	// glob patterns appended to config.exclude for everything else
	excludePatterns: string[]
}

export function readGitignore(projectRoot: string): GitignoreRules {
	const path = join(projectRoot, '.gitignore')
	if (!existsSync(path)) return { skipDirs: new Set(), excludePatterns: [] }
	let text: string
	try {
		text = readFileSync(path, 'utf-8')
	} catch (e) {
		log.debug(`could not read .gitignore: ${e}`)
		return { skipDirs: new Set(), excludePatterns: [] }
	}
	return parseGitignore(text)
}

export function parseGitignore(text: string): GitignoreRules {
	const skipDirs = new Set<string>()
	const excludePatterns: string[] = []

	for (const rawLine of text.split('\n')) {
		const line = rawLine.replace(/\r$/, '').trim()
		if (!line || line.startsWith('#')) continue
		if (line.startsWith('!')) {
			log.debug(`gitignore: skipping unsupported negation pattern '${line}'`)
			continue
		}

		// strip leading slash (gitignore-anchored vs atlas's "anywhere"
		// semantics differ; atlas's patterns already match anywhere via **)
		let pat = line.startsWith('/') ? line.slice(1) : line

		// trailing slash → directory only
		const isDir = pat.endsWith('/')
		if (isDir) pat = pat.slice(0, -1)

		// fast path: bare directory name with no glob chars and no slashes
		// is the most common case (`node_modules`, `.bench-cache/`,
		// `.claude/`). add to skipDirs so the walker short-circuits.
		if (!pat.includes('/') && !pat.includes('*') && !pat.includes('?')) {
			skipDirs.add(pat)
			// also add the matching glob form so non-walker code paths
			// (matchesAnyPattern) reject it consistently
			excludePatterns.push(isDir ? `**/${pat}/**` : `**/${pat}`)
			continue
		}

		// `*.ext` style — atlas already supports `**/*.ext`
		if (/^\*\.[A-Za-z0-9_]+$/.test(pat)) {
			excludePatterns.push(`**/${pat}`)
			continue
		}

		// `dir/**`, `dir/*.ext`, `path/to/file` — pass through. for
		// directory shapes ensure trailing /** so descendants match.
		if (isDir) {
			excludePatterns.push(`**/${pat}/**`)
		} else if (pat.includes('/')) {
			excludePatterns.push(pat)
		} else {
			// catchall: bare pattern with glob chars (e.g. `*.bak.tmp`)
			excludePatterns.push(`**/${pat}`)
		}
	}

	return { skipDirs, excludePatterns }
}
