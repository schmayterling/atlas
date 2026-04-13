import type Parser from 'tree-sitter'
import type {
	ExtractedApiEndpoint,
	ExtractedEdge,
	ExtractedImport,
	ExtractedSymbol,
	ExtractionResult,
} from './typescript.js'
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
	const apiEndpoints: ExtractedApiEndpoint[] = []
	let packageName: string | null = null

	const root = tree.rootNode

	for (let i = 0; i < root.namedChildCount; i++) {
		const child = root.namedChild(i)!
		switch (child.type) {
			case 'package_clause': {
				// `package foo` — the identifier immediately following the
				// keyword is the package name. used by the go-resolver to
				// map import paths back to directories.
				const ident = child.descendantsOfType('package_identifier')[0]
				if (ident) packageName = ident.text
				break
			}
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

	// api endpoints live inside function bodies, so walk the whole tree
	// once more looking for the common routing call shapes. covers
	// net/http, gorilla/mux, chi, gin, echo via a single detector that
	// matches call expressions by callee name + argument shape.
	extractGoApiEndpoints(root, filePath, apiEndpoints)

	return { symbols, edges, imports, apiEndpoints, packageName }
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
			// use the inner type_spec position so grouped `type ( Foo; Bar )`
			// blocks give each symbol its own span instead of the entire
			// block span.
			lineStart: spec.startPosition.row + 1,
			lineEnd: spec.endPosition.row + 1,
			colStart: spec.startPosition.column,
			colEnd: spec.endPosition.column,
			byteStart: spec.startIndex,
			byteEnd: spec.endIndex,
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

		// extract struct field names (as properties). multi-name
		// declarations like `X, Y float64` produce one symbol per name,
		// so we iterate every `name`-field child of the declaration
		// instead of only consulting childForFieldName which returns
		// the first match.
		if (isStruct && typeNode) {
			const fieldList = typeNode.childForFieldName('body') ?? typeNode.namedChild(0)
			if (fieldList) {
				for (let j = 0; j < fieldList.namedChildCount; j++) {
					const field = fieldList.namedChild(j)!
					if (field.type !== 'field_declaration') continue
					const fieldNames = collectFieldChildren(field, 'name')
					for (const fieldName of fieldNames) {
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

// tree-sitter's childForFieldName returns only the first name of a
// multi-name declaration. walk the immediate children and collect
// every node that occupies the named field slot so `var a, b int`,
// `X, Y float64`, and friends all produce one symbol per identifier.
function collectFieldChildren(parent: SyntaxNode, fieldName: string): SyntaxNode[] {
	const out: SyntaxNode[] = []
	for (let i = 0; i < parent.childCount; i++) {
		if (parent.fieldNameForChild(i) === fieldName) {
			const child = parent.child(i)
			if (child) out.push(child)
		}
	}
	return out
}

function extractVarDecl(
	node: SyntaxNode,
	filePath: string,
	symbols: ExtractedSymbol[],
) {
	// walk the children of var_declaration / const_declaration looking
	// for var_spec / const_spec entries. for each spec, extract every
	// name (multi-name: `var a, b, c int`) and tag its span with the
	// spec's own position so grouped `var ( x = 1; y = 2 )` blocks
	// don't give both symbols the whole-block span.
	for (let i = 0; i < node.namedChildCount; i++) {
		const spec = node.namedChild(i)!
		if (spec.type !== 'var_spec' && spec.type !== 'const_spec') continue

		const nameNodes = collectFieldChildren(spec, 'name')
		for (const nameNode of nameNodes) {
			const name = nameNode.text
			symbols.push({
				name,
				qualifiedName: qname(filePath, name),
				kind: 'variable',
				isExported: /^[A-Z]/.test(name),
				visibility: /^[A-Z]/.test(name) ? 'export' : null,
				lineStart: spec.startPosition.row + 1,
				lineEnd: spec.endPosition.row + 1,
				colStart: spec.startPosition.column,
				colEnd: spec.endPosition.column,
				byteStart: spec.startIndex,
				byteEnd: spec.endIndex,
				parentQualifiedName: null,
				signature: null,
				docComment: null,
			})
		}
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

// --- go api endpoint extraction ---
//
// matches the routing call shapes that every common go http framework
// uses. examples:
//   http.HandleFunc("/path", myHandler)
//   http.Handle("/path", wrapped)
//   mux.HandleFunc("/path", myHandler)
//   r.HandleFunc("/path", h).Methods("GET")      // gorilla/mux
//   r.Get("/path", h)  /  r.Post / r.Put / r.Delete / r.Patch   // chi
//   r.GET("/path", h) / r.POST / etc.                            // gin
//   e.GET("/path", h)                                            // echo
//
// for each match we emit one ExtractedApiEndpoint. the handler symbol
// qname is derived by finding the containing top-level function the
// call sits inside; when the handler is a same-file function reference
// (\`myHandler\` as the second arg), we upgrade to that function's qname
// so api tracing resolves the edge. struct-receiver methods and
// cross-file handlers need the go resolver (deferred) to resolve;
// they currently fall back to the containing-function qname, which
// still lets api tracing surface the route even if the exact handler
// lookup misses.

// chi's single-method helpers
const CHI_METHODS = new Set(['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options'])
// gin + echo use upper-case verbs
const UPPER_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
// net/http + gorilla/mux generic helpers (method discovered via .Methods(...) call)
const GENERIC_ROUTE_CALLS = new Set(['HandleFunc', 'Handle'])

function extractGoApiEndpoints(
	node: SyntaxNode,
	filePath: string,
	endpoints: ExtractedApiEndpoint[],
): void {
	if (node.type === 'call_expression') {
		tryExtractRouteCall(node, filePath, endpoints)
	}
	for (let i = 0; i < node.namedChildCount; i++) {
		extractGoApiEndpoints(node.namedChild(i)!, filePath, endpoints)
	}
}

// receiver-name allowlist for router-method calls. only selector
// expressions whose operand looks like a router (`r`, `mux`, `router`,
// `app`, `e`, `http`) are considered. this stops cache.Get("/key"),
// db.Handle("/path", ...), etc. from being misclassified as http routes.
const ROUTER_RECEIVERS = new Set([
	'r',
	'router',
	'mux',
	'app',
	'e',
	'engine',
	'http',
	's',
	'srv',
	'server',
	'api',
])

function tryExtractRouteCall(
	call: SyntaxNode,
	filePath: string,
	endpoints: ExtractedApiEndpoint[],
): void {
	const funcNode = call.childForFieldName('function')
	if (!funcNode) return

	const methodName = extractCalleeMethodName(funcNode)
	if (!methodName) return

	// receiver guard: method calls on non-router receivers (cache.Get,
	// db.Handle, etc.) get rejected here before any verb/path inspection.
	// identifier callees (bare HandleFunc) are only allowed for the
	// generic http package helpers.
	if (funcNode.type === 'selector_expression') {
		const operand = funcNode.childForFieldName('operand')
		const operandName = operand?.type === 'identifier' ? operand.text.toLowerCase() : null
		if (!operandName || !ROUTER_RECEIVERS.has(operandName)) return
	} else if (funcNode.type !== 'identifier') {
		return
	}

	let framework: string | null = null
	let httpMethod: string | null = null

	if (CHI_METHODS.has(methodName)) {
		framework = 'chi'
		httpMethod = methodName.toUpperCase()
	} else if (UPPER_METHODS.has(methodName)) {
		framework = 'gin' // gin + echo share the same surface; framework is a guess
		httpMethod = methodName
	} else if (GENERIC_ROUTE_CALLS.has(methodName)) {
		framework = 'net/http'
		// method for HandleFunc is discovered via a trailing .Methods("GET")
		// call on the parent chain; for now we leave it null and let the
		// client-side matcher treat null as "any".
		httpMethod = null
	} else {
		return
	}

	const args = call.childForFieldName('arguments')
	if (!args || args.namedChildCount < 2) return

	const pathArg = args.namedChild(0)!
	const handlerArg = args.namedChild(1)!

	const pathPattern = extractStringLiteral(pathArg)
	if (!pathPattern || !pathPattern.startsWith('/')) return

	// handler qname: if the second arg is a plain identifier (same-file
	// function reference) we can point straight at it via the
	// containing-file qname. otherwise fall back to the enclosing
	// function's qname so api tracing at least surfaces the route.
	let handlerQName: string
	if (handlerArg.type === 'identifier') {
		handlerQName = `${filePath}::${handlerArg.text}`
	} else {
		handlerQName = findEnclosingFunctionQName(call, filePath)
	}

	endpoints.push({
		pathPattern,
		httpMethod,
		symbolQualifiedName: handlerQName,
		role: 'server',
		framework,
		line: call.startPosition.row + 1,
	})
}

function extractCalleeMethodName(funcNode: SyntaxNode): string | null {
	if (funcNode.type === 'identifier') return funcNode.text
	if (funcNode.type === 'selector_expression') {
		const field = funcNode.childForFieldName('field')
		return field?.text ?? null
	}
	return null
}

function extractStringLiteral(node: SyntaxNode): string | null {
	// go string literals can be interpreted_string_literal ("...") or
	// raw_string_literal (`...`). strip the surrounding quotes/backticks.
	if (node.type === 'interpreted_string_literal') {
		const raw = node.text
		if (raw.length >= 2) return raw.slice(1, -1)
	}
	if (node.type === 'raw_string_literal') {
		const raw = node.text
		if (raw.length >= 2) return raw.slice(1, -1)
	}
	return null
}

function findEnclosingFunctionQName(node: SyntaxNode, filePath: string): string {
	let cursor: SyntaxNode | null = node.parent
	while (cursor) {
		if (cursor.type === 'function_declaration') {
			const name = cursor.childForFieldName('name')
			if (name) return `${filePath}::${name.text}`
		}
		if (cursor.type === 'method_declaration') {
			const name = cursor.childForFieldName('name')
			if (name) return `${filePath}::${name.text}`
		}
		cursor = cursor.parent
	}
	return `${filePath}::module`
}
