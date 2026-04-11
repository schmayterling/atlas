import type Parser from 'tree-sitter'
import type { ExtractionResult } from './extractors/typescript.js'

export interface LanguageExtractor {
	extract(tree: Parser.Tree, filePath: string, source: string): ExtractionResult
}

const registry = new Map<string, LanguageExtractor>()

export function registerExtractor(language: string, extractor: LanguageExtractor) {
	registry.set(language, extractor)
}

export function getExtractor(language: string): LanguageExtractor | null {
	return registry.get(language) ?? null
}

export function hasExtractor(language: string): boolean {
	return registry.has(language)
}
