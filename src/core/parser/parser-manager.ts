import Parser from 'tree-sitter'
// @ts-ignore: tree-sitter-typescript has no type declarations
import TypeScript from 'tree-sitter-typescript'
// @ts-ignore: tree-sitter-python has no type declarations
import Python from 'tree-sitter-python'
// @ts-ignore: tree-sitter-go has no type declarations
import Go from 'tree-sitter-go'
// @ts-ignore: tree-sitter-rust has no type declarations
import Rust from 'tree-sitter-rust'
import { extractTypeScript } from './extractors/typescript.js'
import { extractPython } from './extractors/python.js'
import { extractGo } from './extractors/go.js'
import { extractRust } from './extractors/rust.js'
import { registerExtractor } from './extractor-registry.js'

const languageMap = new Map<string, Parser.Language>()
const extensionMap = new Map<string, string>()

// register built-in TypeScript/JavaScript support
function registerBuiltins() {
	registerLanguage('typescript', TypeScript.typescript as Parser.Language, ['.ts'])
	registerLanguage('tsx', TypeScript.tsx as Parser.Language, ['.tsx'])
	registerLanguage('javascript', TypeScript.typescript as Parser.Language, ['.js', '.mjs', '.cjs'])
	registerLanguage('jsx', TypeScript.tsx as Parser.Language, ['.jsx'])

	// register the TypeScript extractor for all JS/TS variants
	const tsExtractor = { extract: extractTypeScript }
	registerExtractor('typescript', tsExtractor)
	registerExtractor('tsx', tsExtractor)
	registerExtractor('javascript', tsExtractor)
	registerExtractor('jsx', tsExtractor)

	// register Python support
	registerLanguage('python', Python as Parser.Language, ['.py'])
	registerExtractor('python', { extract: extractPython })

	// register Go support
	registerLanguage('go', Go as Parser.Language, ['.go'])
	registerExtractor('go', { extract: extractGo })

	// register Rust support
	registerLanguage('rust', Rust as Parser.Language, ['.rs'])
	registerExtractor('rust', { extract: extractRust })
}

export function registerLanguage(language: string, grammar: Parser.Language, extensions: string[]) {
	languageMap.set(language, grammar)
	for (const ext of extensions) {
		extensionMap.set(ext, language)
	}
}

// cache one parser per language to avoid repeated construction
const parserCache = new Map<string, Parser>()

function getParser(language: string): Parser {
	let parser = parserCache.get(language)
	if (!parser) {
		const grammar = languageMap.get(language)
		if (!grammar) throw new Error(`no grammar registered for language: ${language}`)
		parser = new Parser()
		parser.setLanguage(grammar)
		parserCache.set(language, parser)
	}
	return parser
}

export function getLanguageForExtension(ext: string): string | null {
	return extensionMap.get(ext) ?? null
}

export function parseSource(source: string, language: string): Parser.Tree {
	if (!languageMap.has(language)) {
		throw new Error(`unsupported language: ${language}`)
	}
	const prepared = needsTypeScriptPreprocessing(language) ? stripInlineImportTypes(source) : source
	return getParser(language).parse(prepared)
}

function needsTypeScriptPreprocessing(language: string): boolean {
	return (
		language === 'typescript' ||
		language === 'tsx' ||
		language === 'javascript' ||
		language === 'jsx'
	)
}

// tree-sitter-typescript cannot recover from inline `import('./path.js').X`
// types in class-member return positions. the first occurrence inside a
// class body silently drops every subsequent method/property declaration
// as ERROR nodes, so callers of those methods end up with source_ids that
// match no symbol row and deps/blast-radius/trace all show `<unknown>`.
// see #81. we replace `import('...').Name` with `Name` plus trailing
// spaces so byte offsets stay intact for downstream line/column data.
const INLINE_IMPORT_TYPE_RE = /import\(\s*['"][^'"]+['"]\s*\)\s*\.([A-Za-z_$][A-Za-z0-9_$]*)/g

export function stripInlineImportTypes(source: string): string {
	return source.replace(INLINE_IMPORT_TYPE_RE, (match, name: string) => {
		const pad = match.length - name.length
		return pad > 0 ? name + ' '.repeat(pad) : name
	})
}

// initialize on import
registerBuiltins()
