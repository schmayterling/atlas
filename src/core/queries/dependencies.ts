import type {
	DependencyNode,
	DependencyResult,
	EdgeKind,
	SubgraphBudget,
	SymbolResult,
} from '../../shared/types.js'
import { loadSubgraph, reachableNodes } from '../graph/graph-index.js'
import type { AtlasStore } from '../storage/store.js'

export function getDependencies(
	store: AtlasStore,
	symbolStableId: string,
	opts?: {
		direction?: 'upstream' | 'downstream' | 'both'
		depth?: number
		edgeKinds?: EdgeKind[]
	},
): DependencyResult {
	const symbol = store.getSymbolByStableId(symbolStableId)
	if (!symbol) {
		return {
			symbol: {
				name: '<unknown>',
				qualifiedName: '<unknown>',
				kind: 'variable',
				signature: null,
				filePath: '<unknown>',
				lineStart: 0,
				lineEnd: 0,
				isExported: false,
				docComment: null,
				usageCount: 0,
				dependentCount: 0,
			},
			upstream: [],
			downstream: [],
			stats: { totalNodes: 0, totalEdges: 0, maxDepthReached: 0 },
			truncated: false,
		}
	}

	const symbolResult = store.symbolToResult(symbol)
	const direction = opts?.direction ?? 'both'
	const maxDepth = opts?.depth ?? 3
	const edgeKinds = opts?.edgeKinds ?? (['imports', 'calls', 'type_ref', 'extends'] as EdgeKind[])

	const budget: SubgraphBudget = {
		maxDepth,
		maxNodes: 5000,
		maxEdges: 20000,
		edgeKinds,
		timeoutMs: 5000,
	}

	let upstream: DependencyNode[] = []
	let downstream: DependencyNode[] = []
	let totalNodes = 0
	let totalEdges = 0
	let maxDepthReached = 0
	let truncated = false
	let truncationReason: string | undefined

	if (direction === 'upstream' || direction === 'both') {
		const { graph, truncated: t, reason } = loadSubgraph(store, [symbolStableId], budget, 'inbound')
		if (t) { truncated = true; truncationReason = reason }
		const distances = reachableNodes(graph, symbolStableId, 'inbound', maxDepth)
		upstream = buildDependencyTree(store, graph, symbolStableId, distances, 'inbound')
		totalNodes += distances.size
		totalEdges += graph.size
		for (const d of distances.values()) {
			if (d > maxDepthReached) maxDepthReached = d
		}
	}

	if (direction === 'downstream' || direction === 'both') {
		const { graph, truncated: t, reason } = loadSubgraph(store, [symbolStableId], budget, 'outbound')
		if (t) { truncated = true; truncationReason = reason }
		const distances = reachableNodes(graph, symbolStableId, 'outbound', maxDepth)
		downstream = buildDependencyTree(store, graph, symbolStableId, distances, 'outbound')
		totalNodes += distances.size
		totalEdges += graph.size
		for (const d of distances.values()) {
			if (d > maxDepthReached) maxDepthReached = d
		}
	}

	return {
		symbol: symbolResult,
		upstream,
		downstream,
		stats: { totalNodes, totalEdges, maxDepthReached },
		truncated,
		truncationReason,
	}
}

function buildDependencyTree(
	store: AtlasStore,
	graph: import('graphology').MultiDirectedGraph,
	rootId: string,
	distances: Map<string, number>,
	direction: 'inbound' | 'outbound',
): DependencyNode[] {
	const directIds = [...distances.entries()]
		.filter(([_, d]) => d === 1)
		.map(([id]) => id)

	// batch-fetch all symbols
	const symMap = store.getSymbolsByStableIds(directIds)
	const symResults = store.symbolsToResults([...symMap.values()])
	const resultByStableId = new Map<string, SymbolResult>()
	const symValues = [...symMap.values()]
	for (let i = 0; i < symValues.length; i++) {
		resultByStableId.set(symValues[i].stableId, symResults[i])
	}

	return directIds.map((id) => {
		const symResult: SymbolResult = resultByStableId.get(id) ?? {
			name: id.slice(0, 8),
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

		// determine edge kind from graph
		let edgeKind: EdgeKind = 'calls'
		if (graph.hasNode(rootId) && graph.hasNode(id)) {
			const edges = direction === 'outbound'
				? graph.outEdges(rootId).filter((e) => graph.target(e) === id)
				: graph.inEdges(rootId).filter((e) => graph.source(e) === id)

			if (edges.length > 0) {
				const attrs = graph.getEdgeAttributes(edges[0])
				edgeKind = attrs.kind as EdgeKind
			}
		}

		return {
			symbol: symResult,
			edgeKind,
			confidence: 'resolved' as const,
			depth: distances.get(id) ?? 1,
			children: [], // flatten for now, tree construction is expensive
		}
	})
}
