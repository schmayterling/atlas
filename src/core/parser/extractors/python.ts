import type Parser from 'tree-sitter'
import type { ExtractionResult, ExtractedSymbol, ExtractedEdge, ExtractedImport } from './typescript.js'
import type { SymbolKind, Confidence } from '../../../shared/types.js'

type SyntaxNode = Parser.SyntaxNode

export function extractPython(
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
		processNode(child, filePath, null, symbols, edges, imports)
	}

	return { symbols, edges, imports }
}

function processNode(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
	imports: ExtractedImport[],
) {
	switch (node.type) {
		case 'function_definition':
			extractFunction(node, filePath, parentQName, symbols, edges)
			break
		case 'class_definition':
			extractClass(node, filePath, parentQName, symbols, edges, imports)
			break
		case 'expression_statement':
			extractAssignment(node, filePath, parentQName, symbols)
			break
		case 'import_statement':
			extractImport(node, imports)
			break
		case 'import_from_statement':
			extractFromImport(node, imports)
			break
		case 'decorated_definition': {
			// unwrap decorator to get the actual definition
			const def = node.namedChildren.find(
				(c) => c.type === 'function_definition' || c.type === 'class_definition',
			)
			if (def) processNode(def, filePath, parentQName, symbols, edges, imports)
			break
		}
	}
}

function qname(filePath: string, parentQName: string | null, name: string): string {
	if (parentQName) return `${parentQName}.${name}`
	return `${filePath}::${name}`
}

function extractFunction(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const qualName = qname(filePath, parentQName, name)

	// determine kind: method if inside a class, function otherwise
	const kind: SymbolKind = parentQName ? 'method' : 'function'

	// build signature from parameters and return type
	const params = node.childForFieldName('parameters')
	const returnType = node.childForFieldName('return_type')
	let signature = params ? params.text : '()'
	if (returnType) signature += ` -> ${returnType.text}`

	// check for docstring
	const body = node.childForFieldName('body')
	let docComment: string | null = null
	if (body) {
		const firstStmt = body.namedChild(0)
		if (firstStmt?.type === 'expression_statement') {
			const expr = firstStmt.namedChild(0)
			if (expr?.type === 'string' || expr?.type === 'concatenated_string') {
				docComment = expr.text.replace(/^['\"]{1,3}|['\"]{1,3}$/g, '').trim()
			}
		}
	}

	symbols.push({
		name,
		qualifiedName: qualName,
		kind,
		isExported: !name.startsWith('_'),
		visibility: name.startsWith('__') && !name.endsWith('__') ? 'private' : name.startsWith('_') ? 'protected' : 'public',
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

	// add contains edge from parent
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

	// extract intra-file calls from function body
	if (body) extractCalls(body, filePath, qualName, edges)
}

function extractClass(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	symbols: ExtractedSymbol[],
	edges: ExtractedEdge[],
	imports: ExtractedImport[],
) {
	const nameNode = node.childForFieldName('name')
	if (!nameNode) return

	const name = nameNode.text
	const qualName = qname(filePath, parentQName, name)

	// check for base classes (heritage)
	const argList = node.childForFieldName('superclasses')
	let signature: string | null = null
	if (argList && argList.namedChildCount > 0) {
		const bases = []
		for (let i = 0; i < argList.namedChildCount; i++) {
			bases.push(argList.namedChild(i)!.text)
		}
		signature = `(${bases.join(', ')})`
	}

	// check for docstring
	const body = node.childForFieldName('body')
	let docComment: string | null = null
	if (body) {
		const firstStmt = body.namedChild(0)
		if (firstStmt?.type === 'expression_statement') {
			const expr = firstStmt.namedChild(0)
			if (expr?.type === 'string' || expr?.type === 'concatenated_string') {
				docComment = expr.text.replace(/^['\"]{1,3}|['\"]{1,3}$/g, '').trim()
			}
		}
	}

	symbols.push({
		name,
		qualifiedName: qualName,
		kind: 'class',
		isExported: !name.startsWith('_'),
		visibility: 'public',
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

	// process class body
	if (body) {
		for (let i = 0; i < body.namedChildCount; i++) {
			const child = body.namedChild(i)!
			processNode(child, filePath, qualName, symbols, edges, imports)
		}
	}
}

function extractAssignment(
	node: SyntaxNode,
	filePath: string,
	parentQName: string | null,
	symbols: ExtractedSymbol[],
) {
	// expression_statement > assignment > identifier
	const assignment = node.namedChild(0)
	if (!assignment || assignment.type !== 'assignment') return

	const left = assignment.childForFieldName('left')
	if (!left || left.type !== 'identifier') return

	const name = left.text
	// skip lowercase module-level vars that look like local variables
	// only extract UPPER_CASE constants and typed annotations at module level
	if (!parentQName && name !== name.toUpperCase() && !assignment.childForFieldName('type')) return

	const qualName = qname(filePath, parentQName, name)

	symbols.push({
		name,
		qualifiedName: qualName,
		kind: 'variable',
		isExported: !name.startsWith('_'),
		visibility: 'public',
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		colStart: node.startPosition.column,
		colEnd: node.endPosition.column,
		byteStart: node.startIndex,
		byteEnd: node.endIndex,
		parentQualifiedName: parentQName,
		signature: null,
		docComment: null,
	})
}

function extractImport(node: SyntaxNode, imports: ExtractedImport[]) {
	// import os / import os.path
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i)!
		if (child.type === 'dotted_name') {
			imports.push({
				importPath: child.text,
				isTypeOnly: false,
				importedNames: [child.text],
				line: node.startPosition.row + 1,
				isDefault: false,
				isNamespace: true,
				namespaceAlias: null,
			})
		} else if (child.type === 'aliased_import') {
			const nameNode = child.childForFieldName('name')
			const alias = child.childForFieldName('alias')
			if (nameNode) {
				imports.push({
					importPath: nameNode.text,
					isTypeOnly: false,
					importedNames: [nameNode.text],
					line: node.startPosition.row + 1,
					isDefault: false,
					isNamespace: true,
					namespaceAlias: alias?.text ?? null,
				})
			}
		}
	}
}

function extractFromImport(node: SyntaxNode, imports: ExtractedImport[]) {
	// from X import Y, Z
	const moduleNode = node.childForFieldName('module_name')
	if (!moduleNode) return

	const modulePath = moduleNode.text
	const names: string[] = []

	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i)!
		if (child.type === 'dotted_name' && child !== moduleNode) {
			names.push(child.text)
		} else if (child.type === 'aliased_import') {
			const nameNode = child.childForFieldName('name')
			if (nameNode) names.push(nameNode.text)
		} else if (child.type === 'wildcard_import') {
			names.push('*')
		}
	}

	imports.push({
		importPath: modulePath,
		isTypeOnly: false,
		importedNames: names,
		line: node.startPosition.row + 1,
		isDefault: false,
		isNamespace: names.includes('*'),
		namespaceAlias: null,
	})
}

function extractCalls(
	node: SyntaxNode,
	filePath: string,
	sourceQName: string,
	edges: ExtractedEdge[],
) {
	if (node.type === 'call') {
		const func = node.childForFieldName('function')
		if (func) {
			const callName = func.type === 'identifier' ? func.text : func.type === 'attribute' ? func.text : null
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

	// recurse into children
	for (let i = 0; i < node.namedChildCount; i++) {
		extractCalls(node.namedChild(i)!, filePath, sourceQName, edges)
	}
}
