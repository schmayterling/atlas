import { realpathSync } from 'node:fs'

// shared precision helpers and filesystem utilities for cross-
// language channel linkers. rules deliberately err on the side of
// false negatives: better to miss a real table reference than to
// surface nonsense words in `channels list`.

// english stopwords + sql connectives that occasionally land where
// the linker expects an identifier. lowercased, compared
// case-insensitively.
const COMMON_STOPWORDS = new Set<string>([
	'a',
	'an',
	'and',
	'any',
	'all',
	'as',
	'at',
	'be',
	'but',
	'by',
	'can',
	'do',
	'each',
	'every',
	'for',
	'from',
	'has',
	'have',
	'here',
	'how',
	'if',
	'in',
	'is',
	'it',
	'its',
	'me',
	'more',
	'must',
	'no',
	'not',
	'now',
	'of',
	'on',
	'one',
	'only',
	'or',
	'our',
	'so',
	'some',
	'than',
	'that',
	'the',
	'then',
	'there',
	'these',
	'they',
	'this',
	'those',
	'to',
	'too',
	'two',
	'up',
	'us',
	'use',
	'we',
	'were',
	'what',
	'when',
	'where',
	'which',
	'who',
	'why',
	'will',
	'with',
	'would',
	'you',
	'your',
])

// sql keyword denylist that often appears between sql keywords and a
// real table name (e.g. `FROM (SELECT ...)`, `JOIN ON`, `INTO TEMPORARY`).
// these are technically valid sql but should never be classified as
// table identifiers.
const SQL_RESERVED_WORDS = new Set<string>([
	'select',
	'insert',
	'update',
	'delete',
	'where',
	'order',
	'group',
	'having',
	'limit',
	'offset',
	'as',
	'on',
	'using',
	'left',
	'right',
	'inner',
	'outer',
	'full',
	'cross',
	'natural',
	'into',
	'temporary',
	'temp',
	'recursive',
	'with',
	'union',
	'except',
	'intersect',
	'distinct',
	'all',
	'true',
	'false',
	'null',
])

// additional sqlite internal table names that are real in the schema
// but not project-meaningful. surfacing them in `channels list`
// distracts from real table linking.
const SQLITE_INTERNAL_TABLES = new Set<string>([
	'sqlite_master',
	'sqlite_sequence',
	'sqlite_stat1',
	'sqlite_stat4',
	'sqlite_temp_master',
])

// minimum length for a table/topic/env-var identifier. anything
// shorter is almost certainly a false positive (1-2 char hits in
// real corpora are noise). callers can override per channel kind.
const MIN_IDENTIFIER_LENGTH = 3

// a precompiled denylist of "junk" identifiers used by every
// channel linker. callers can pass an extra channel-specific set
// via shouldKeepIdentifier(channelExtras).
const BASE_JUNK = new Set<string>([
	...COMMON_STOPWORDS,
	...SQL_RESERVED_WORDS,
	...SQLITE_INTERNAL_TABLES,
])

// returns true when the identifier is a plausible channel value (real
// table, topic, schema, env var, etc.) and false when it should be
// dropped. the `extras` set lets a specific linker add its own
// language-specific junk (e.g. queue linker might denylist 'event',
// 'message', 'topic' literals).
export function shouldKeepIdentifier(
	value: string,
	opts: {
		extras?: Set<string>
		minLength?: number
	} = {},
): boolean {
	const lower = value.toLowerCase().trim()
	if (lower.length === 0) return false
	if (lower.length < (opts.minLength ?? MIN_IDENTIFIER_LENGTH)) return false
	if (BASE_JUNK.has(lower)) return false
	if (opts.extras?.has(lower)) return false
	// must contain at least one alphabetic character; pure numeric
	// values (`123`) are never identifiers.
	if (!/[a-z]/.test(lower)) return false
	return true
}

// gating helper: many false positives come from prose strings that
// happen to contain a sql keyword followed by an english word
// (`from and to project IDs required`). require the enclosing string
// literal to contain a recognizable channel marker before accepting
// the match. each channel passes its own marker regex.
//
// scans backwards for the most recent unescaped opening quote on the
// same line; if there is one, scans forward for the matching close
// quote. for single + double quotes the scan stays inside the line
// (those literals don't legally span lines without escapes). for
// backtick template literals the scan continues across newlines so
// multi-line `\`SELECT ... FROM users\`` queries still match. when
// no enclosing literal is found on the line head, returns null.
function findEnclosingStringLiteral(
	source: string,
	matchIndex: number,
): { start: number; end: number; quote: string } | null {
	const lineStart = source.lastIndexOf('\n', matchIndex) + 1
	const lineHead = source.slice(lineStart, matchIndex)

	let inSingle = false
	let inDouble = false
	let inBacktick = false
	let openIdx = -1
	let openQuote = ''
	for (let i = 0; i < lineHead.length; i++) {
		const c = lineHead[i]
		if (c === '\\') {
			i++
			continue
		}
		if (c === "'" && !inDouble && !inBacktick) {
			if (!inSingle) {
				openIdx = lineStart + i
				openQuote = "'"
			}
			inSingle = !inSingle
		} else if (c === '"' && !inSingle && !inBacktick) {
			if (!inDouble) {
				openIdx = lineStart + i
				openQuote = '"'
			}
			inDouble = !inDouble
		} else if (c === '`' && !inSingle && !inDouble) {
			if (!inBacktick) {
				openIdx = lineStart + i
				openQuote = '`'
			}
			inBacktick = !inBacktick
		}
	}
	if (!(inSingle || inDouble || inBacktick)) return null

	// for ' and " stay on the line (those quotes don't legally span
	// lines without escapes). for ` (template literals) walk forward
	// across newlines so multi-line sql template strings work.
	const tailEnd = openQuote === '`'
		? source.length
		: (() => {
				const nl = source.indexOf('\n', matchIndex)
				return nl === -1 ? source.length : nl
			})()
	const tail = source.slice(matchIndex, tailEnd)
	let closeIdx = -1
	for (let i = 0; i < tail.length; i++) {
		const c = tail[i]
		if (c === '\\') {
			i++
			continue
		}
		if (c === openQuote) {
			closeIdx = matchIndex + i
			break
		}
	}
	if (closeIdx === -1) return null

	return { start: openIdx + 1, end: closeIdx, quote: openQuote }
}

// convenience: extract the literal content the match was inside, or
// null when not inside a string literal. used by linkers to gate
// matches on "the surrounding literal contains <marker>".
export function getEnclosingLiteralContent(source: string, matchIndex: number): string | null {
	const range = findEnclosingStringLiteral(source, matchIndex)
	if (!range) return null
	return source.slice(range.start, range.end)
}

// precompute newline byte offsets once per file so per-match line
// lookup is O(log N) via binary search instead of O(N) per hit.
export function buildLineOffsets(source: string): number[] {
	const offsets = [0]
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10) offsets.push(i + 1)
	}
	return offsets
}

// binary-search the offset table for the line containing a byte
// offset. returns a 0-indexed line number; add 1 for 1-indexed.
export function offsetToLine(offsets: number[], matchIndex: number): number {
	let lo = 0
	let hi = offsets.length - 1
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if (offsets[mid] <= matchIndex) lo = mid
		else hi = mid - 1
	}
	return lo
}

// wrapper around realpathSync that returns null on any error. used
// by the symlink containment guard in every channel linker and the
// schema file walkers.
export function safeRealpath(p: string): string | null {
	try {
		return realpathSync(p)
	} catch {
		return null
	}
}

// true when abs is inside root (exactly root, or a sub-path thereof).
// used by linkers to reject symlink targets that escape the project.
export function isUnderRoot(abs: string, root: string): boolean {
	const normRoot = root.endsWith('/') ? root : `${root}/`
	return abs === root || abs.startsWith(normRoot)
}
