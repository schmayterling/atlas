import type Parser from 'tree-sitter'
import type { Confidence, EdgeKind, SymbolKind } from '../../../shared/types.js'

// extraction result from a single file
export interface ExtractionResult {
	symbols: ExtractedSymbol[]
	edges: ExtractedEdge[]
	imports: ExtractedImport[]
	apiEndpoints?: ExtractedApiEndpoint[]
}

export interface ExtractedApiEndpoint {
	pathPattern: string
	httpMethod: string | null
	symbolQualifiedName: string
	role: 'client' | 'server'
	framework: string | null
	line: number
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

	// extract API endpoints (fetch calls, route registrations)
	const apiEndpoints: ExtractedApiEndpoint[] = []
	extractApiEndpoints(root, filePath, apiEndpoints)

	return { symbols, edges, imports, apiEndpoints }
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
		const kind: SymbolKind = 'method'
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
	const countBefore = symbols.length
	for (const child of node.namedChildren) {
		if (child.type === 'export_clause') {
			continue
		}

		processNode(child, filePath, parentQName, true, symbols, edges, imports)
	}

	// handle `export default expression` (not a declaration)
	if (isDefault && symbols.length === countBefore) {
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

// detect fetch('/api/...') calls (client) and app.get('/api/...', handler) (server)
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all'])
const FETCH_NAMES = new Set(['fetch', 'axios'])

function extractApiEndpoints(
	node: SyntaxNode,
	filePath: string,
	endpoints: ExtractedApiEndpoint[],
) {
	if (node.type === 'call_expression') {
		const func = node.childForFieldName('function')
		const args = node.childForFieldName('arguments')
		if (func && args) {
			// detect fetch('/api/...'). when the second arg is an object
			// yet, so default the method to GET. previously we emitted
			// null which fanned one client call out to every server verb
			// at the same path in the cross-language linker.
			if (func.type === 'identifier' && FETCH_NAMES.has(func.text)) {
				const firstArg = args.namedChild(0)
				if (firstArg?.type === 'string' || firstArg?.type === 'template_string') {
					const url = extractStringValue(firstArg)
					if (url && url.startsWith('/')) {
						endpoints.push({
							pathPattern: url,
							httpMethod: inferFetchMethod(args),
							symbolQualifiedName: `${filePath}::${findContainingFunctionName(node) ?? 'module'}`,
							role: 'client',
							framework: 'fetch',
							line: node.startPosition.row + 1,
						})
					}
				}
			}

			// detect app.get('/api/...', handler) or router.post('/api/...')
			if (func.type === 'member_expression') {
				const method = func.childForFieldName('property')
				if (method && HTTP_METHODS.has(method.text)) {
					const firstArg = args.namedChild(0)
					if (firstArg?.type === 'string' || firstArg?.type === 'template_string') {
						const url = extractStringValue(firstArg)
						if (url && url.startsWith('/')) {
							endpoints.push({
								pathPattern: url,
								httpMethod: method.text === 'all' ? null : method.text.toUpperCase(),
								symbolQualifiedName: `${filePath}::${findContainingFunctionName(node) ?? 'module'}`,
								role: 'server',
								framework: null,
								line: node.startPosition.row + 1,
							})
						}
					}
				}
			}
		}
	}

	for (let i = 0; i < node.namedChildCount; i++) {
		extractApiEndpoints(node.namedChild(i)!, filePath, endpoints)
	}
}

function extractStringValue(node: SyntaxNode): string | null {
	if (node.type === 'string') {
		// strip quotes
		const text = node.text
		if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
			return text.slice(1, -1)
		}
		return text
	}
	if (node.type === 'template_string') {
		// simple template with no interpolation: literal content only.
		if (node.namedChildCount === 0) {
			return node.text.slice(1, -1) // strip backticks
		}
		// template with `${…}` placeholders: walk the underlying text and
		// substitute each template_substitution with a single `{param}`
		// segment so the downstream linker can normalise it against
		// server-side `:param` / `{param}` routes.
		//
		// tree-sitter exposes the substitutions as named children. the
		// text between them is the raw literal. we reconstruct the final
		// path by slicing the original source around each substitution's
		// byte range.
		const raw = node.text // includes the surrounding backticks
		const startByte = node.startIndex
		let out = ''
		let cursorByte = startByte + 1 // skip leading backtick
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i)!
			if (child.type !== 'template_substitution') continue
			const before = raw.slice(cursorByte - startByte, child.startIndex - startByte)
			out += before + '{param}'
			cursorByte = child.endIndex
		}
		// trailing literal between the last substitution and the closing backtick.
		out += raw.slice(cursorByte - startByte, node.endIndex - startByte - 1)
		return out
	}
	return null
}

// inspects the second argument of a fetch(url, init) call to see if
// it's an object literal with a `method:` property. returns the
// uppercased verb when found, falls back to GET otherwise (which is
// the fetch() default per the spec).
function inferFetchMethod(args: SyntaxNode): string {
	if (args.namedChildCount < 2) return 'GET'
	const init = args.namedChild(1)
	if (!init) return 'GET'
	if (init.type !== 'object') return 'GET'
	for (let i = 0; i < init.namedChildCount; i++) {
		const prop = init.namedChild(i)!
		if (prop.type !== 'pair') continue
		const key = prop.childForFieldName('key')
		if (!key) continue
		const keyText =
			key.type === 'string' || key.type === 'property_identifier'
				? key.text.replace(/^["']|["']$/g, '')
				: null
		if (keyText !== 'method') continue
		const value = prop.childForFieldName('value')
		if (!value) continue
		if (value.type === 'string') {
			return value.text.replace(/^["']|["']$/g, '').toUpperCase()
		}
	}
	return 'GET'
}

function findContainingFunctionName(node: SyntaxNode): string | null {
	let current = node.parent
	while (current) {
		if (current.type === 'function_declaration' || current.type === 'method_definition') {
			const name = current.childForFieldName('name')
			if (name) return name.text
		}
		if (current.type === 'variable_declarator') {
			const name = current.childForFieldName('name')
			if (name) return name.text
		}
		current = current.parent
	}
	return null
}
