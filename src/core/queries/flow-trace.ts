import type { MultiDirectedGraph } from 'graphology'
import type { EdgeKind, FlowPath, FlowTraceResult, SubgraphBudget, SymbolResult } from '../../shared/types.js'
import type { GraphEdge } from '../graph/graph-index.js'
import { loadSubgraph } from '../graph/graph-index.js'
import type { AtlasStore } from '../storage/store.js'

export function traceFlow(
	store: AtlasStore,
	sourceStableId: string,
	targetStableId: string,
	opts?: { maxPaths?: number; maxDepth?: number; edgeKinds?: EdgeKind[] },
): FlowTraceResult {
	const maxPaths = opts?.maxPaths ?? 5
	const maxDepth = opts?.maxDepth ?? 10
	const edgeKinds = opts?.edgeKinds ?? (['calls', 'type_ref', 'extends'] as EdgeKind[])

	const sourceSym = store.getSymbolByStableId(sourceStableId)
	const targetSym = store.getSymbolByStableId(targetStableId)

	const emptySource = makeEmptySymbol(sourceStableId)
	const emptyTarget = makeEmptySymbol(targetStableId)

	const sourceResult = sourceSym ? store.symbolToResult(sourceSym) : emptySource
	const targetResult = targetSym ? store.symbolToResult(targetSym) : emptyTarget

	const budget: SubgraphBudget = {
		maxDepth,
		maxNodes: 5000,
		maxEdges: 20000,
		edgeKinds,
		timeoutMs: 5000,
	}

	// load outbound subgraph from source (target must be reachable via outbound edges)
	const { graph } = loadSubgraph(store, [sourceStableId], budget, 'outbound')

	if (!graph.hasNode(sourceStableId) || !graph.hasNode(targetStableId)) {
		return {
			source: sourceResult,
			target: targetResult,
			paths: [],
			stats: { totalPaths: 0, maxLength: 0, truncated: false },
		}
	}

	// collect all paths first, then batch-resolve symbols
	const rawPaths: string[][] = []
	for (const nodePath of findAllSimplePaths(graph, sourceStableId, targetStableId, maxDepth)) {
		if (rawPaths.length >= maxPaths) break
		rawPaths.push(nodePath)
	}

	// batch-fetch all unique node symbols
	const allNodeIds = [...new Set(rawPaths.flat())]
	const symMap = store.getSymbolsByStableIds(allNodeIds)
	const symResults = store.symbolsToResults([...symMap.values()])
	const resultByStableId = new Map<string, SymbolResult>()
	const symValues = [...symMap.values()]
	for (let i = 0; i < symValues.length; i++) {
		resultByStableId.set(symValues[i].stableId, symResults[i])
	}

	const paths: FlowPath[] = []
	for (const nodePath of rawPaths) {
		const nodes: SymbolResult[] = []
		const edges: FlowPath['edges'] = []

		for (let i = 0; i < nodePath.length; i++) {
			const nodeId = nodePath[i]
			nodes.push(resultByStableId.get(nodeId) ?? makeEmptySymbol(nodeId))

			if (i < nodePath.length - 1) {
				const nextId = nodePath[i + 1]
				let edgeKind: EdgeKind = 'calls'
				let line: number | null = null

				const outEdges = graph.outEdges(nodeId)
				for (const e of outEdges) {
					if (graph.target(e) === nextId) {
						const attrs = graph.getEdgeAttributes(e) as GraphEdge
						edgeKind = attrs.kind
						line = attrs.line
						break
					}
				}

				edges.push({ from: nodeId, to: nextId, kind: edgeKind, line })
			}
		}

		paths.push({ nodes, edges, length: nodePath.length - 1 })
	}

	// sort by length (shortest first)
	paths.sort((a, b) => a.length - b.length)

	return {
		source: sourceResult,
		target: targetResult,
		paths,
		stats: {
			totalPaths: paths.length,
			maxLength: paths.length > 0 ? Math.max(...paths.map((p) => p.length)) : 0,
			truncated: paths.length >= maxPaths,
		},
	}
}

// DFS-based all-simple-paths generator, cycle-safe via visited backtracking
function* findAllSimplePaths(
	graph: MultiDirectedGraph,
	source: string,
	target: string,
	maxDepth: number,
): Generator<string[]> {
	const visited = new Set<string>()
	const path: string[] = [source]

	function* dfs(current: string, depth: number): Generator<string[]> {
		if (current === target) {
			yield [...path]
			return
		}
		if (depth >= maxDepth) return

		visited.add(current)
		for (const neighbor of graph.outNeighbors(current)) {
			if (!visited.has(neighbor)) {
				path.push(neighbor)
				yield* dfs(neighbor, depth + 1)
				path.pop()
			}
		}
		visited.delete(current)
	}

	yield* dfs(source, 0)
}

function makeEmptySymbol(id: string): SymbolResult {
	return {
		name: '<unknown>',
		qualifiedName: id,
		kind: 'variable',
		signature: null,
		filePath: '<unknown>',
		lineStart: 0,
		lineEnd: 0,
		isExported: false,
		docComment: null,
		usageCount: 0,
		dependentCount: 0,
	}
}
