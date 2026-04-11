import type Parser from 'tree-sitter'
import type { ExtractionResult, ExtractedSymbol, ExtractedEdge, ExtractedImport } from './typescript.js'
import type { SymbolKind, Confidence } from '../../../shared/types.js'

type SyntaxNode = Parser.SyntaxNode

export function extractGo(
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
			case 'function_declaration':
				extractFunction(child, filePath, symbols, edges)
				break
			case 'method_declaration':
				extractMethod(child, filePath, symbols, edges)
				break
			case 'type_declaration':
				extractTypeDecl(child, filePath, symbols, edges)
				break
			case 'var_declaration':
			case 'const_declaration':
				extractVarDecl(child, filePath, symbols)
				break
			case 'import_declaration':
				extractImport(child, imports)
				break
		}
	}

	return { symbols, edges, imports }
}

function qname(filePath: string, name: string): string {
	return `${filePath}::${name}`
}

function extractFunction(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const params = node.childForFieldName('parameters')
	const result = node.childForFieldName('result')
	let signature = params ? params.text : '()'
	if (result) signature += ` ${result.text}`

	// extract doc comment (comment immediately before the function)
	const docComment = getDocComment(node)

	symbols.push({
		name,
		qualifiedName: qname(filePath, name),
		kind: 'function',
		isExported: name[0] === name[0].toUpperCase() && /^[A-Z]/.test(name),
		visibility: /^[A-Z]/.test(name) ? 'export' : null,
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		colStart: node.startPosition.column,
		colEnd: node.endPosition.column,
		byteStart: node.startIndex,
		byteEnd: node.endIndex,
		parentQualifiedName: null,
		signature,
		docComment,
	})

	// extract intra-file calls from body
	const body = node.childForFieldName('body')
	if (body) extractCalls(body, filePath, qname(filePath, name), edges)
}

function extractMethod(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text

	// get receiver type
	const receiverList = node.childForFieldName('receiver')
	let receiverType: string | null = null
	if (receiverList) {
		// walk receiver to find the type identifier
		for (let i = 0; i < receiverList.namedChildCount; i++) {
			const param = receiverList.namedChild(i)!
			// find type_identifier or pointer_type > type_identifier
			const typeNode = findTypeIdentifier(param)
			if (typeNode) {
				receiverType = typeNode.text
				break
			}
		}
	}

	const parentQName = receiverType ? qname(filePath, receiverType) : null
	const qualName = receiverType ? `${filePath}::${receiverType}.${name}` : qname(filePath, name)

	const params = node.childForFieldName('parameters')
	const result = node.childForFieldName('result')
	let signature = params ? params.text : '()'
	if (result) signature += ` ${result.text}`

	const docComment = getDocComment(node)

	symbols.push({
		name,
		qualifiedName: qualName,
		kind: 'method',
		isExported: /^[A-Z]/.test(name),
		visibility: /^[A-Z]/.test(name) ? 'export' : null,
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		colStart: node.startPosition.column,
		colEnd: node.endPosition.column,
		byteStart: node.startIndex,
		byteEnd: node.endIndex,
		parentQualifiedName: parentQName,
		signature,
		docComment,
	})

	// contains edge from receiver type to method
	if (parentQName) {
		edges.push({
			sourceQualifiedName: parentQName,
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

function extractTypeDecl(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	for (let i = 0; i < node.namedChildCount; i++) {
		const spec = node.namedChild(i)!
		if (spec.type !== 'type_spec') continue

		const nameNode = spec.childForFieldName('name')
		if (!nameNode) continue

		const name = nameNode.text
		const typeNode = spec.childForFieldName('type')
		const isInterface = typeNode?.type === 'interface_type'
		const isStruct = typeNode?.type === 'struct_type'

		const kind: SymbolKind = isInterface ? 'interface' : isStruct ? 'class' : 'type'
		const qualName = qname(filePath, name)
		const docComment = getDocComment(node)

		symbols.push({
			name,
			qualifiedName: qualName,
			kind,
			isExported: /^[A-Z]/.test(name),
			visibility: /^[A-Z]/.test(name) ? 'export' : null,
			lineStart: node.startPosition.row + 1,
			lineEnd: node.endPosition.row + 1,
			colStart: node.startPosition.column,
			colEnd: node.endPosition.column,
			byteStart: node.startIndex,
			byteEnd: node.endIndex,
			parentQualifiedName: null,
			signature: null,
			docComment,
		})

		// extract interface method signatures
		if (isInterface && typeNode) {
			for (let j = 0; j < typeNode.namedChildCount; j++) {
				const member = typeNode.namedChild(j)!
				if (member.type === 'method_elem') {
					const methodName = member.childForFieldName('name')
					if (methodName) {
						const methodQName = `${filePath}::${name}.${methodName.text}`
						symbols.push({
							name: methodName.text,
							qualifiedName: methodQName,
							kind: 'method',
							isExported: /^[A-Z]/.test(methodName.text),
							visibility: /^[A-Z]/.test(methodName.text) ? 'export' : null,
							lineStart: member.startPosition.row + 1,
							lineEnd: member.endPosition.row + 1,
							colStart: member.startPosition.column,
							colEnd: member.endPosition.column,
							byteStart: member.startIndex,
							byteEnd: member.endIndex,
							parentQualifiedName: qualName,
							signature: member.text,
							docComment: null,
						})
						edges.push({
							sourceQualifiedName: qualName,
							targetName: methodQName,
							kind: 'contains',
							line: member.startPosition.row + 1,
							col: member.startPosition.column,
							confidence: 'resolved' as Confidence,
						})
					}
				}
			}
		}

		// extract struct field names (as properties)
		if (isStruct && typeNode) {
			const fieldList = typeNode.childForFieldName('body') ?? typeNode.namedChild(0)
			if (fieldList) {
				for (let j = 0; j < fieldList.namedChildCount; j++) {
					const field = fieldList.namedChild(j)!
					if (field.type === 'field_declaration') {
						const fieldName = field.childForFieldName('name')
						if (fieldName) {
							const fieldQName = `${filePath}::${name}.${fieldName.text}`
							symbols.push({
								name: fieldName.text,
								qualifiedName: fieldQName,
								kind: 'property',
								isExported: /^[A-Z]/.test(fieldName.text),
								visibility: /^[A-Z]/.test(fieldName.text) ? 'export' : null,
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
	}
}

function extractVarDecl(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
) {
	for (let i = 0; i < node.namedChildCount; i++) {
		const spec = node.namedChild(i)!
		if (spec.type !== 'var_spec' && spec.type !== 'const_spec') continue

		const nameNode = spec.childForFieldName('name')
		if (!nameNode) continue

		const name = nameNode.text
		symbols.push({
			name,
			qualifiedName: qname(filePath, name),
			kind: 'variable',
			isExported: /^[A-Z]/.test(name),
			visibility: /^[A-Z]/.test(name) ? 'export' : null,
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
}

function extractImport(node: SyntaxNode, imports: ExtractedImport[]) {
	for (let i = 0; i < node.namedChildCount; i++) {
		const spec = node.namedChild(i)!
		if (spec.type !== 'import_spec') continue

		const pathNode = spec.childForFieldName('path')
		if (!pathNode) continue

		// strip quotes from import path
		const importPath = pathNode.text.replace(/^["']|["']$/g, '')
		const alias = spec.childForFieldName('name')

		imports.push({
			importPath,
			isTypeOnly: false,
			importedNames: [importPath.split('/').pop() ?? importPath],
			line: spec.startPosition.row + 1,
			isDefault: false,
			isNamespace: !!alias && alias.text === '.',
			namespaceAlias: alias?.text ?? null,
		})
	}
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
				: func.type === 'selector_expression'
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

function findTypeIdentifier(node: SyntaxNode): SyntaxNode | null {
	if (node.type === 'type_identifier') return node
	for (let i = 0; i < node.namedChildCount; i++) {
		const found = findTypeIdentifier(node.namedChild(i)!)
		if (found) return found
	}
	return null
}

function getDocComment(node: SyntaxNode): string | null {
	const prev = node.previousNamedSibling
	if (prev?.type === 'comment') {
		return prev.text.replace(/^\/\/\s?/, '').trim()
	}
	return null
}
