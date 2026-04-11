import Parser from 'tree-sitter'
// @ts-ignore: tree-sitter-typescript has no type declarations
import TypeScript from 'tree-sitter-typescript'
// @ts-ignore: tree-sitter-python has no type declarations
import Python from 'tree-sitter-python'
// @ts-ignore: tree-sitter-go has no type declarations
import Go from 'tree-sitter-go'
import { extractTypeScript } from './extractors/typescript.js'
import { extractPython } from './extractors/python.js'
import { extractGo } from './extractors/go.js'
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
	return getParser(language).parse(source)
}

// initialize on import
registerBuiltins()
