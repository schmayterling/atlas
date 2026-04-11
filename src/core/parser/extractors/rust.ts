import type Parser from 'tree-sitter'
import type { ExtractionResult, ExtractedSymbol, ExtractedEdge, ExtractedImport } from './typescript.js'
import type { SymbolKind, Confidence } from '../../../shared/types.js'

type SyntaxNode = Parser.SyntaxNode

export function extractRust(
	tree: Parser.Tree,
	filePath: string,
	_source: string,
): ExtractionResult {
	const symbols: ExtractedSymbol[] = []
	const edges: ExtractedEdge[] = []
	const imports: ExtractedImport[] = []

	const root = tree.rootNode

	for (let i = 0; i < root.namedChildCount; i++) {
		const child = root.namedChild(i)!
		switch (child.type) {
			case 'function_item':
				extractFunction(child, filePath, null, symbols, edges)
				break
			case 'struct_item':
				extractStruct(child, filePath, symbols, edges)
				break
			case 'impl_item':
				extractImpl(child, filePath, symbols, edges)
				break
			case 'trait_item':
				extractTrait(child, filePath, symbols, edges)
				break
			case 'enum_item':
				extractEnum(child, filePath, symbols)
				break
			case 'const_item':
			case 'static_item':
				extractConst(child, filePath, symbols)
				break
			case 'use_declaration':
				extractUse(child, imports)
				break
			case 'mod_item':
				extractMod(child, filePath, symbols)
				break
		}
	}

	return { symbols, edges, imports }
}

function qname(filePath: string, parentName: string | null, name: string): string {
	if (parentName) return `${filePath}::${parentName}.${name}`
	return `${filePath}::${name}`
}

function isPub(node: SyntaxNode): boolean {
	for (let i = 0; i < node.namedChildCount; i++) {
		if (node.namedChild(i)!.type === 'visibility_modifier') return true
	}
	return false
}

function getDocComment(node: SyntaxNode): string | null {
	const prev = node.previousNamedSibling
	if (prev?.type === 'line_comment' && prev.text.startsWith('///')) {
		return prev.text.replace(/^\/\/\/\s?/, '').trim()
	}
	return null
}

function extractFunction(
	node: SyntaxNode,
	filePath: string,
	parentName: string | null,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const qualName = qname(filePath, parentName, name)
	const exported = isPub(node)

	const params = node.childForFieldName('parameters')
	const returnType = node.childForFieldName('return_type')
	let signature = params ? params.text : '()'
	if (returnType) signature += ` -> ${returnType.text}`

	symbols.push({
		name,
		qualifiedName: qualName,
		kind: parentName ? 'method' : 'function',
		isExported: exported,
		visibility: exported ? 'export' : null,
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		colStart: node.startPosition.column,
		colEnd: node.endPosition.column,
		byteStart: node.startIndex,
		byteEnd: node.endIndex,
		parentQualifiedName: parentName ? `${filePath}::${parentName}` : null,
		signature,
		docComment: getDocComment(node),
	})

	if (parentName) {
		edges.push({
			sourceQualifiedName: `${filePath}::${parentName}`,
			targetName: qualName,
			kind: 'contains',
			line: node.startPosition.row + 1,
			col: node.startPosition.column,
			confidence: 'resolved' as Confidence,
		})
	}

	const body = node.childForFieldName('body')
	if (body) extractCalls(body, filePath, qualName, edges)
}

function extractStruct(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const qualName = qname(filePath, null, name)

	symbols.push({
		name,
		qualifiedName: qualName,
		kind: 'class',
		isExported: isPub(node),
		visibility: isPub(node) ? 'export' : null,
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		colStart: node.startPosition.column,
		colEnd: node.endPosition.column,
		byteStart: node.startIndex,
		byteEnd: node.endIndex,
		parentQualifiedName: null,
		signature: null,
		docComment: getDocComment(node),
	})

	// extract fields
	const body = node.childForFieldName('body')
	if (body) {
		for (let i = 0; i < body.namedChildCount; i++) {
			const field = body.namedChild(i)!
			if (field.type === 'field_declaration') {
				const fieldName = field.childForFieldName('name')
				if (fieldName) {
					const fieldQName = `${filePath}::${name}.${fieldName.text}`
					symbols.push({
						name: fieldName.text,
						qualifiedName: fieldQName,
						kind: 'property',
						isExported: isPub(field),
						visibility: isPub(field) ? 'export' : null,
						lineStart: field.startPosition.row + 1,
						lineEnd: field.endPosition.row + 1,
						colStart: field.startPosition.column,
						colEnd: field.endPosition.column,
						byteStart: field.startIndex,
						byteEnd: field.endIndex,
						parentQualifiedName: qualName,
						signature: field.text.trim(),
						docComment: null,
					})
					edges.push({
						sourceQualifiedName: qualName,
						targetName: fieldQName,
						kind: 'contains',
						line: field.startPosition.row + 1,
						col: field.startPosition.column,
						confidence: 'resolved' as Confidence,
					})
				}
			}
		}
	}
}

function extractImpl(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	// get the type being implemented
	const typeNode = node.childForFieldName('type')
	if (!typeNode) return
	const typeName = typeNode.text

	// check if it implements a trait
	const traitNode = node.childForFieldName('trait')
	if (traitNode) {
		// impl Trait for Type -> extends edge
		edges.push({
			sourceQualifiedName: qname(filePath, null, typeName),
			targetName: qname(filePath, null, traitNode.text),
			kind: 'type_ref',
			line: node.startPosition.row + 1,
			col: node.startPosition.column,
			confidence: 'heuristic' as Confidence,
		})
	}

	// extract methods from the impl block
	const body = node.childForFieldName('body')
	if (body) {
		for (let i = 0; i < body.namedChildCount; i++) {
			const child = body.namedChild(i)!
			if (child.type === 'function_item') {
				extractFunction(child, filePath, typeName, symbols, edges)
			}
		}
	}
}

function extractTrait(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const qualName = qname(filePath, null, name)

	symbols.push({
		name,
		qualifiedName: qualName,
		kind: 'interface',
		isExported: isPub(node),
		visibility: isPub(node) ? 'export' : null,
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		colStart: node.startPosition.column,
		colEnd: node.endPosition.column,
		byteStart: node.startIndex,
		byteEnd: node.endIndex,
		parentQualifiedName: null,
		signature: null,
		docComment: getDocComment(node),
	})

	// extract trait method signatures
	const body = node.childForFieldName('body')
	if (body) {
		for (let i = 0; i < body.namedChildCount; i++) {
			const child = body.namedChild(i)!
			if (child.type === 'function_signature_item') {
				const methodName = child.childForFieldName('name')
				if (methodName) {
					const methodQName = `${filePath}::${name}.${methodName.text}`
					symbols.push({
						name: methodName.text,
						qualifiedName: methodQName,
						kind: 'method',
						isExported: true,
						visibility: 'export',
						lineStart: child.startPosition.row + 1,
						lineEnd: child.endPosition.row + 1,
						colStart: child.startPosition.column,
						colEnd: child.endPosition.column,
						byteStart: child.startIndex,
						byteEnd: child.endIndex,
						parentQualifiedName: qualName,
						signature: child.text,
						docComment: null,
					})
					edges.push({
						sourceQualifiedName: qualName,
						targetName: methodQName,
						kind: 'contains',
						line: child.startPosition.row + 1,
						col: child.startPosition.column,
						confidence: 'resolved' as Confidence,
					})
				}
			}
		}
	}
}

function extractEnum(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	symbols.push({
		name: nameNode.text,
		qualifiedName: qname(filePath, null, nameNode.text),
		kind: 'enum',
		isExported: isPub(node),
		visibility: isPub(node) ? 'export' : null,
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		colStart: node.startPosition.column,
		colEnd: node.endPosition.column,
		byteStart: node.startIndex,
		byteEnd: node.endIndex,
		parentQualifiedName: null,
		signature: null,
		docComment: getDocComment(node),
	})
}

function extractConst(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	symbols.push({
		name: nameNode.text,
		qualifiedName: qname(filePath, null, nameNode.text),
		kind: 'variable',
		isExported: isPub(node),
		visibility: isPub(node) ? 'export' : null,
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		colStart: node.startPosition.column,
		colEnd: node.endPosition.column,
		byteStart: node.startIndex,
		byteEnd: node.endIndex,
		parentQualifiedName: null,
		signature: null,
		docComment: null,
	})
}

function extractMod(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	symbols.push({
		name: nameNode.text,
		qualifiedName: qname(filePath, null, nameNode.text),
		kind: 'module',
		isExported: isPub(node),
		visibility: isPub(node) ? 'export' : null,
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		colStart: node.startPosition.column,
		colEnd: node.endPosition.column,
		byteStart: node.startIndex,
		byteEnd: node.endIndex,
		parentQualifiedName: null,
		signature: null,
		docComment: null,
	})
}

function extractUse(node: SyntaxNode, imports: ExtractedImport[]) {
	const arg = node.namedChild(0)
	if (!arg) return

	const path = arg.text.replace(/::/g, '/')
	imports.push({
		importPath: path,
		isTypeOnly: false,
		importedNames: [path.split('/').pop() ?? path],
		line: node.startPosition.row + 1,
		isDefault: false,
		isNamespace: path.includes('*'),
		namespaceAlias: null,
	})
}

function extractCalls(
	node: SyntaxNode,
	filePath: string,
	sourceQName: string,
	edges: ExtractedEdge[],
) {
	if (node.type === 'call_expression') {
		const func = node.childForFieldName('function')
		if (func) {
			const callName = func.type === 'identifier'
				? func.text
				: func.type === 'scoped_identifier' || func.type === 'field_expression'
					? func.text
					: null
			if (callName) {
				edges.push({
					sourceQualifiedName: sourceQName,
					targetName: `${filePath}::${callName}`,
					kind: 'calls',
					line: node.startPosition.row + 1,
					col: node.startPosition.column,
					confidence: 'heuristic' as Confidence,
				})
			}
		}
	}

	for (let i = 0; i < node.namedChildCount; i++) {
		extractCalls(node.namedChild(i)!, filePath, sourceQName, edges)
	}
}
