import type { MultiDirectedGraph } from 'graphology'
import type {
	EdgeKind,
	FlowPath,
	FlowTraceResult,
	SubgraphBudget,
	SymbolResult,
} from '../../shared/types.js'
import type { GraphEdge } from '../graph/graph-index.js'
import { loadSubgraph } from '../graph/graph-index.js'
import type { AtlasStore } from '../storage/store.js'

const FAST_TRACE_EDGE_KINDS: EdgeKind[] = ['calls', 'passed_as', 'dispatches_to', 'instantiates']
const FULL_TRACE_EDGE_KINDS: EdgeKind[] = [
	'calls',
	'type_ref',
	'extends',
	'passed_as',
	'dispatches_to',
	'instantiates',
	'field_access',
	'contains',
]

// TRAVERSAL surface. test files are NOT filtered. tracing a flow between
// two named symbols may legitimately walk through test scaffolding when the
// caller is asking about test execution paths.
export function traceFlow(
	store: AtlasStore,
	sourceStableId: string,
	targetStableId: string,
	opts?: { maxPaths?: number; maxDepth?: number; edgeKinds?: EdgeKind[] },
): FlowTraceResult {
	const maxPaths = opts?.maxPaths ?? 5
	const maxDepth = opts?.maxDepth ?? 10
	if (opts?.edgeKinds) {
		return traceFlowWithEdgeKinds(
			store,
			sourceStableId,
			targetStableId,
			maxPaths,
			maxDepth,
			opts.edgeKinds,
		)
	}

	// cheap execution edges cover calls, function references passed into
	// registrars, go interface dispatch, and constructor boundaries. if
	// that pass finds no path, retry with structural type/property/class
	// edges so factory patterns still resolve. see #49, #50, #85, #87,
	// and BENCHMARK.md section 5.1 call-tracing weakness.
	const fast = traceFlowWithEdgeKinds(
		store,
		sourceStableId,
		targetStableId,
		maxPaths,
		maxDepth,
		FAST_TRACE_EDGE_KINDS,
	)
	if (fast.paths.length > 0) return fast

	return traceFlowWithEdgeKinds(
		store,
		sourceStableId,
		targetStableId,
		maxPaths,
		maxDepth,
		FULL_TRACE_EDGE_KINDS,
	)
}

function traceFlowWithEdgeKinds(
	store: AtlasStore,
	sourceStableId: string,
	targetStableId: string,
	maxPaths: number,
	maxDepth: number,
	edgeKinds: EdgeKind[],
): FlowTraceResult {
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

	// collect paths first, then batch-resolve symbols. the path
	// enumeration has a wall-clock budget independent of the subgraph
	// load budget. use bounded shortest-path search instead of dfs so
	// high-fanout `contains` edges do not force atlas to enumerate deep
	// unrelated paths before returning the nearest useful trace.
	const pathSearchDeadline = performance.now() + 2000
	const { paths: rawPaths, truncated: truncatedBySearch } = findShortestSimplePaths(
		graph,
		sourceStableId,
		targetStableId,
		maxDepth,
		pathSearchDeadline,
		maxPaths,
	)

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
			// truncated when either we hit the maxPaths cap or the path-search
			// deadline expired before exhausting the graph. callers that show
			// "more paths exist" benefit from both signals being collapsed
			// here; the deadline case is also worth surfacing in CLI output
			// so a query that returns 0 paths under timeout doesn't look
			// indistinguishable from a query that found zero genuine paths.
			truncated: paths.length >= maxPaths || truncatedBySearch,
		},
	}
}

// breadth-first simple-path search returns nearest paths first and
// stops as soon as the caller's maxPaths budget is satisfied. the queue
// cap is a second guard for dense graphs where no path exists.
function findShortestSimplePaths(
	graph: MultiDirectedGraph,
	source: string,
	target: string,
	maxDepth: number,
	deadline: number,
	maxPaths: number,
): { paths: string[][]; truncated: boolean } {
	const paths: string[][] = []
	const queue: string[][] = [[source]]
	let index = 0
	let truncated = false
	const maxQueuedPaths = 50_000

	while (index < queue.length) {
		if (performance.now() > deadline) return { paths, truncated: true }
		const path = queue[index++]
		const current = path[path.length - 1]
		if (current === target) {
			paths.push(path)
			if (paths.length >= maxPaths) {
				truncated = true
				break
			}
			continue
		}
		if (path.length - 1 >= maxDepth) continue

		for (const neighbor of graph.outNeighbors(current)) {
			if (path.includes(neighbor)) continue
			queue.push([...path, neighbor])
			if (queue.length - index > maxQueuedPaths) {
				truncated = true
				break
			}
		}
		if (truncated) break
	}

	return { paths, truncated }
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
