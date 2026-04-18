// server-side syntax highlighting via shiki.
//
// strategy: lazy-load a single highlighter for the languages atlas indexes
// today (ts/js/tsx/jsx/python). emit dual-theme html (github-light +
// github-dark) so the client can swap themes via css vars without
// re-rendering. cache by (lang, sha256(code)) with a soft size cap.
//
// shiki escapes inputs and produces well-formed pre/code with inline
// styles. consumers wrap the output in <CodeBlock html={...} /> which
// renders into our themed <pre>.

import { createHighlighter, type Highlighter } from 'shiki'
import { createHash } from 'node:crypto'

const LANGS = ['typescript', 'tsx', 'javascript', 'jsx', 'python', 'json', 'bash'] as const
const LIGHT_THEME = 'github-light'
const DARK_THEME = 'github-dark'

const CACHE_LIMIT = 512
const cache = new Map<string, string>()

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: [LIGHT_THEME, DARK_THEME],
			langs: [...LANGS],
		})
	}
	return highlighterPromise
}

function langFor(input: string | undefined): string {
	if (!input) return 'typescript'
	const lc = input.toLowerCase()
	if (lc === 'ts' || lc === 'typescript') return 'typescript'
	if (lc === 'tsx') return 'tsx'
	if (lc === 'js' || lc === 'javascript') return 'javascript'
	if (lc === 'jsx') return 'jsx'
	if (lc === 'py' || lc === 'python') return 'python'
	if (lc === 'json') return 'json'
	if (lc === 'sh' || lc === 'bash') return 'bash'
	return 'typescript'
}

function trim(map: Map<string, string>) {
	if (map.size <= CACHE_LIMIT) return
	const drop = map.size - CACHE_LIMIT
	let i = 0
	for (const k of map.keys()) {
		if (i++ >= drop) break
		map.delete(k)
	}
}

export async function highlight(code: string, language?: string): Promise<string> {
	const lang = langFor(language)
	const key = `${lang}:${createHash('sha256').update(code).digest('hex')}`
	const cached = cache.get(key)
	if (cached) return cached
	const hl = await getHighlighter()
	const html = hl.codeToHtml(code, {
		lang,
		themes: { light: LIGHT_THEME, dark: DARK_THEME },
		defaultColor: 'light',
		cssVariablePrefix: '--shiki-',
	})
	cache.set(key, html)
	trim(cache)
	return html
}

export function clearHighlightCache() {
	cache.clear()
}
