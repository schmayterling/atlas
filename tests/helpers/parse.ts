import './setup.js'
import { parseSource } from '../../src/core/parser/parser-manager.js'
import { extractTypeScript } from '../../src/core/parser/extractors/typescript.js'
import { extractPython } from '../../src/core/parser/extractors/python.js'
import type { ExtractionResult } from '../../src/core/parser/extractors/typescript.js'

export function extractTS(source: string, filePath = 'src/fake.ts'): ExtractionResult {
	const tree = parseSource(source, 'typescript')
	return extractTypeScript(tree, filePath, source)
}

export function extractPY(source: string, filePath = 'src/fake.py'): ExtractionResult {
	const tree = parseSource(source, 'python')
	return extractPython(tree, filePath, source)
}
