import Parser from 'tree-sitter'
// @ts-ignore: tree-sitter-typescript has no type declarations
import TypeScript from 'tree-sitter-typescript'

const LANGUAGE_MAP: Record<string, Parser.Language> = {
	typescript: TypeScript.typescript as Parser.Language,
	tsx: TypeScript.tsx as Parser.Language,
	javascript: TypeScript.typescript as Parser.Language,
	jsx: TypeScript.tsx as Parser.Language,
}

const EXTENSION_LANGUAGE: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'tsx',
	'.js': 'javascript',
	'.jsx': 'jsx',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
}

// cache one parser per language to avoid repeated construction
const parserCache = new Map<string, Parser>()

function getParser(language: string): Parser {
	let parser = parserCache.get(language)
	if (!parser) {
		parser = new Parser()
		parser.setLanguage(LANGUAGE_MAP[language])
		parserCache.set(language, parser)
	}
	return parser
}

export function getLanguageForExtension(ext: string): string | null {
	return EXTENSION_LANGUAGE[ext] ?? null
}

export function parseSource(source: string, language: string): Parser.Tree {
	if (!LANGUAGE_MAP[language]) {
		throw new Error(`unsupported language: ${language}`)
	}
	return getParser(language).parse(source)
}
