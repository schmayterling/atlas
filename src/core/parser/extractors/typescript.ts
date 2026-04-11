import type Parser from 'tree-sitter'
import type { Confidence, EdgeKind, SymbolKind } from '../../../shared/types.js'

// extraction result from a single file
export interface ExtractionResult {
	symbols: ExtractedSymbol[]
	edges: ExtractedEdge[]
	imports: ExtractedImport[]
}

export interface ExtractedSymbol {
	name: string
	qualifiedName: string
	kind: SymbolKind
	isExported: boolean
	visibility: string | null
	lineStart: number
	lineEnd: number
	colStart: number
	colEnd: number
	byteStart: number
	byteEnd: number
	parentQualifiedName: string | null
	signature: string | null
	docComment: string | null
}

export interface ExtractedEdge {
	sourceQualifiedName: string
	targetName: string
	kind: EdgeKind
	line: number
	col: number
	confidence: Confidence
}

export interface ExtractedImport {
	importPath: string
	isTypeOnly: boolean
	importedNames: string[]
	line: number
	isDefault: boolean
	isNamespace: boolean
	namespaceAlias: string | null
}

type SyntaxNode = Parser.SyntaxNode

// extract symbols, edges, and imports from a TypeScript/TSX file
export function extractTypeScript(
	tree: Parser.Tree,
	filePath: string,
	_source: string,
): ExtractionResult {
	const symbols: ExtractedSymbol[] = []
	const edges: ExtractedEdge[] = []
	const imports: ExtractedImport[] = []

	const root = tree.rootNode

	// walk top-level statements
	for (const child of root.namedChildren) {
		processNode(child, filePath, null, false, symbols, edges, imports)
	}

	return { symbols, edges, imports }
}

function processNode(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	parentExported: boolean,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
	imports: ExtractedImport[],
) {
	switch (node.type) {
		case 'function_declaration':
		case 'generator_function_declaration':
			extractFunctionDeclaration(node, filePath, parentQName, parentExported, symbols)
			break

		case 'class_declaration':
			extractClassDeclaration(node, filePath, parentQName, parentExported, symbols, edges)
			break

		case 'interface_declaration':
			extractInterfaceDeclaration(node, filePath, parentQName, parentExported, symbols, edges)
			break

		case 'type_alias_declaration':
			extractTypeAlias(node, filePath, parentQName, parentExported, symbols)
			break

		case 'enum_declaration':
			extractEnum(node, filePath, parentQName, parentExported, symbols)
			break

		case 'lexical_declaration':
		case 'variable_declaration':
			extractVariableDeclaration(node, filePath, parentQName, parentExported, symbols)
			break

		case 'export_statement':
			extractExportStatement(node, filePath, parentQName, symbols, edges, imports)
			break

		case 'import_statement':
			extractImport(node, imports)
			break
	}
}

// --- symbol extractors ---

function extractFunctionDeclaration(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	isExported: boolean,
	symbols: ExtractedSymbol[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const qname = qualifiedName(filePath, parentQName, name)

	symbols.push({
		name,
		qualifiedName: qname,
		kind: 'function',
		isExported,
		visibility: isExported ? 'export' : null,
		...nodeSpan(node),
		parentQualifiedName: parentQName,
		signature: extractFunctionSignature(node),
		docComment: getDocComment(node),
	})
}

function extractClassDeclaration(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	isExported: boolean,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const classQName = qualifiedName(filePath, parentQName, name)

	symbols.push({
		name,
		qualifiedName: classQName,
		kind: 'class',
		isExported,
		visibility: isExported ? 'export' : null,
		...nodeSpan(node),
		parentQualifiedName: parentQName,
		signature: extractClassSignature(node),
		docComment: getDocComment(node),
	})

	// extract class body members
	const body = node.childForFieldName('body')
	if (!body) return

	for (const member of body.namedChildren) {
		extractClassMember(member, filePath, classQName, symbols, edges)
	}
}

function extractClassMember(
	node: SyntaxNode,
	filePath: string,
	classQName: string,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	if (node.type === 'method_definition') {
		const nameNode = node.childForFieldName('name')
		if (!nameNode) return

		const name = nameNode.text
		const kind: SymbolKind = name === 'constructor' ? 'method' : 'method'
		const memberQName = `${classQName}.${name}`

		symbols.push({
			name,
			qualifiedName: memberQName,
			kind,
			isExported: false,
			visibility: getAccessModifier(node),
			...nodeSpan(node),
			parentQualifiedName: classQName,
			signature: extractFunctionSignature(node),
			docComment: getDocComment(node),
		})

		edges.push({
			sourceQualifiedName: classQName,
			targetName: memberQName,
			kind: 'contains',
			line: node.startPosition.row + 1,
			col: node.startPosition.column,
			confidence: 'resolved',
		})
	} else if (
		node.type === 'public_field_definition' ||
		node.type === 'property_definition'
	) {
		const nameNode = node.childForFieldName('name')
		if (!nameNode) return

		const name = nameNode.text
		const memberQName = `${classQName}.${name}`

		symbols.push({
			name,
			qualifiedName: memberQName,
			kind: 'property',
			isExported: false,
			visibility: getAccessModifier(node),
			...nodeSpan(node),
			parentQualifiedName: classQName,
			signature: extractPropertySignature(node),
			docComment: getDocComment(node),
		})

		edges.push({
			sourceQualifiedName: classQName,
			targetName: memberQName,
			kind: 'contains',
			line: node.startPosition.row + 1,
			col: node.startPosition.column,
			confidence: 'resolved',
		})
	}
}

function extractInterfaceDeclaration(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	isExported: boolean,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const ifaceQName = qualifiedName(filePath, parentQName, name)

	symbols.push({
		name,
		qualifiedName: ifaceQName,
		kind: 'interface',
		isExported,
		visibility: isExported ? 'export' : null,
		...nodeSpan(node),
		parentQualifiedName: parentQName,
		signature: null,
		docComment: getDocComment(node),
	})

	// extract interface members
	const body = node.childForFieldName('body')
	if (!body) return

	for (const member of body.namedChildren) {
		if (member.type === 'property_signature' || member.type === 'method_signature') {
			const memberNameNode = member.childForFieldName('name')
			if (!memberNameNode) continue

			const memberName = memberNameNode.text
			const memberQName = `${ifaceQName}.${memberName}`
			const isMethod = member.type === 'method_signature'

			symbols.push({
				name: memberName,
				qualifiedName: memberQName,
				kind: isMethod ? 'method' : 'property',
				isExported: false,
				visibility: null,
				...nodeSpan(member),
				parentQualifiedName: ifaceQName,
				signature: isMethod ? extractFunctionSignature(member) : extractPropertySignature(member),
				docComment: getDocComment(member),
			})

			edges.push({
				sourceQualifiedName: ifaceQName,
				targetName: memberQName,
				kind: 'contains',
				line: member.startPosition.row + 1,
				col: member.startPosition.column,
				confidence: 'resolved',
			})
		}
	}
}

function extractTypeAlias(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	isExported: boolean,
	symbols: ExtractedSymbol[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const qname = qualifiedName(filePath, parentQName, name)

	// get the type value for signature
	const valueNode = node.childForFieldName('value')
	const signature = valueNode ? truncate(valueNode.text, 200) : null

	symbols.push({
		name,
		qualifiedName: qname,
		kind: 'type',
		isExported,
		visibility: isExported ? 'export' : null,
		...nodeSpan(node),
		parentQualifiedName: parentQName,
		signature,
		docComment: getDocComment(node),
	})
}

function extractEnum(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	isExported: boolean,
	symbols: ExtractedSymbol[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const qname = qualifiedName(filePath, parentQName, name)

	symbols.push({
		name,
		qualifiedName: qname,
		kind: 'enum',
		isExported,
		visibility: isExported ? 'export' : null,
		...nodeSpan(node),
		parentQualifiedName: parentQName,
		signature: null,
		docComment: getDocComment(node),
	})
}

function extractVariableDeclaration(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	isExported: boolean,
	symbols: ExtractedSymbol[],
) {
	// lexical_declaration contains one or more variable_declarators
	for (const child of node.namedChildren) {
		if (child.type !== 'variable_declarator') continue

		const nameNode = child.childForFieldName('name')
		if (!nameNode) continue

		// skip destructuring patterns for now
		if (nameNode.type !== 'identifier') continue

		const name = nameNode.text
		const qname = qualifiedName(filePath, parentQName, name)

		// check if the value is an arrow function or function expression
		const valueNode = child.childForFieldName('value')
		const isArrowFn =
			valueNode?.type === 'arrow_function' || valueNode?.type === 'function'
		const kind: SymbolKind = isArrowFn ? 'function' : 'variable'

		const signature = isArrowFn
			? extractFunctionSignature(valueNode!)
			: extractVariableSignature(child)

		symbols.push({
			name,
			qualifiedName: qname,
			kind,
			isExported,
			visibility: isExported ? 'export' : null,
			...nodeSpan(node),
			parentQualifiedName: parentQName,
			signature,
			docComment: getDocComment(node),
		})
	}
}

function extractExportStatement(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
	imports: ExtractedImport[],
) {
	// `export default` or `export` wraps a declaration
	const isDefault = node.namedChildren.some(
		(c) => c.type === 'default',
	) || node.text.startsWith('export default')

	// check for re-export: `export { foo } from './bar'`
	const source = node.childForFieldName('source')
	if (source) {
		// this is a re-export, treat as import
		const importPath = stripQuotes(source.text)
		const names: string[] = []

		for (const child of node.namedChildren) {
			if (child.type === 'export_clause') {
				for (const spec of child.namedChildren) {
					if (spec.type === 'export_specifier') {
						const nameNode = spec.childForFieldName('name')
						if (nameNode) names.push(nameNode.text)
					}
				}
			}
		}

		imports.push({
			importPath,
			isTypeOnly: node.text.includes('export type'),
			importedNames: names,
			line: node.startPosition.row + 1,
			isDefault: false,
			isNamespace: node.text.includes('* as'),
			namespaceAlias: null,
		})
		return
	}

	// process the declaration inside the export
	for (const child of node.namedChildren) {
		if (child.type === 'export_clause') {
			// `export { foo, bar }` - named re-exports from current module
			// these reference existing symbols, no new symbols to create
			continue
		}

		// delegate to normal processors with isExported=true
		processNode(child, filePath, parentQName, true, symbols, edges, imports)
	}

	// handle `export default expression` (not a declaration)
	if (isDefault && symbols.length === 0) {
		const decl = node.namedChildren.find(
			(c) =>
				c.type !== 'export_clause' &&
				c.type !== 'comment' &&
				!c.type.includes('declaration'),
		)
		if (decl) {
			symbols.push({
				name: '<default>',
				qualifiedName: qualifiedName(filePath, parentQName, '<default>'),
				kind: 'variable',
				isExported: true,
				visibility: 'export',
				...nodeSpan(node),
				parentQualifiedName: parentQName,
				signature: null,
				docComment: getDocComment(node),
			})
		}
	}
}

function extractImport(node: SyntaxNode, imports: ExtractedImport[]) {
	const sourceNode = node.childForFieldName('source')
	if (!sourceNode) return

	const importPath = stripQuotes(sourceNode.text)
	const isTypeOnly = node.text.startsWith('import type')
	const importedNames: string[] = []
	let isDefault = false
	let isNamespace = false
	let namespaceAlias: string | null = null

	for (const child of node.namedChildren) {
		if (child.type === 'import_clause') {
			for (const spec of child.namedChildren) {
				if (spec.type === 'identifier') {
					// default import
					isDefault = true
					importedNames.push(spec.text)
				} else if (spec.type === 'named_imports') {
					for (const named of spec.namedChildren) {
						if (named.type === 'import_specifier') {
							const nameNode =
								named.childForFieldName('alias') ?? named.childForFieldName('name')
							if (nameNode) importedNames.push(nameNode.text)
						}
					}
				} else if (spec.type === 'namespace_import') {
					isNamespace = true
					const alias = spec.namedChildren.find((c) => c.type === 'identifier')
					namespaceAlias = alias?.text ?? null
				}
			}
		}
	}

	imports.push({
		importPath,
		isTypeOnly,
		importedNames,
		line: node.startPosition.row + 1,
		isDefault,
		isNamespace,
		namespaceAlias,
	})
}

// --- helpers ---

function qualifiedName(filePath: string, parentQName: string | null, name: string): string {
	if (parentQName) return `${parentQName}.${name}`
	return `${filePath}::${name}`
}

function nodeSpan(node: SyntaxNode) {
	return {
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		colStart: node.startPosition.column,
		colEnd: node.endPosition.column,
		byteStart: node.startIndex,
		byteEnd: node.endIndex,
	}
}

function getDocComment(node: SyntaxNode): string | null {
	// look for JSDoc comment in the previous sibling
	let prev = node.previousNamedSibling
	if (!prev && node.parent) {
		prev = node.parent.previousNamedSibling
	}
	if (!prev) return null

	if (prev.type === 'comment' && prev.text.startsWith('/**')) {
		return prev.text
	}
	return null
}

function getAccessModifier(node: SyntaxNode): string | null {
	for (const child of node.children) {
		if (child.type === 'accessibility_modifier') {
			return child.text
		}
	}
	return null
}

function extractFunctionSignature(node: SyntaxNode): string | null {
	const params = node.childForFieldName('parameters')
	const returnType = node.childForFieldName('return_type')

	if (!params) return null

	let sig = params.text
	if (returnType) {
		sig += `: ${returnType.text}`
	}
	return truncate(sig, 300)
}

function extractClassSignature(node: SyntaxNode): string | null {
	// capture extends/implements clauses
	const parts: string[] = []

	for (const child of node.namedChildren) {
		if (child.type === 'class_heritage') {
			parts.push(child.text)
		}
		// handle extends_clause, implements_clause directly
		if (child.type === 'extends_clause' || child.type === 'implements_clause') {
			parts.push(child.text)
		}
	}

	// also check type_parameters
	const typeParams = node.childForFieldName('type_parameters')
	if (typeParams) {
		parts.unshift(typeParams.text)
	}

	return parts.length > 0 ? truncate(parts.join(' '), 200) : null
}

function extractPropertySignature(node: SyntaxNode): string | null {
	const typeNode = node.childForFieldName('type')
	if (typeNode) return truncate(typeNode.text, 200)
	return null
}

function extractVariableSignature(node: SyntaxNode): string | null {
	const typeNode = node.childForFieldName('type')
	if (typeNode) return truncate(typeNode.text, 200)

	// try to get the value type from the initializer
	const valueNode = node.childForFieldName('value')
	if (valueNode) return truncate(valueNode.text, 100)
	return null
}

function stripQuotes(s: string): string {
	if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
		return s.slice(1, -1)
	}
	return s
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return `${s.slice(0, max)}...`
}
