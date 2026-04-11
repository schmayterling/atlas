import Parser from 'tree-sitter'
// @ts-ignore: tree-sitter-typescript has no type declarations
import TypeScript from 'tree-sitter-typescript'

const LANGUAGE_MAP: Record<string, unknown> = {
	typescript: TypeScript.typescript,
	tsx: TypeScript.tsx,
	javascript: TypeScript.typescript, // TS grammar handles JS
	jsx: TypeScript.tsx, // TSX grammar handles JSX
}

const EXTENSION_LANGUAGE: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'tsx',
	'.js': 'javascript',
	'.jsx': 'jsx',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
}

export function getLanguageForExtension(ext: string): string | null {
	return EXTENSION_LANGUAGE[ext] ?? null
}

export function parseSource(source: string, language: string): Parser.Tree {
	const grammar = LANGUAGE_MAP[language]
	if (!grammar) {
		throw new Error(`unsupported language: ${language}`)
	}

	const parser = new Parser()
	parser.setLanguage(grammar as Parser.Language)
	return parser.parse(source)
}
