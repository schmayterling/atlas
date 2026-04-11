import type {
	AffectedItem,
	BlastRadiusResult,
	EdgeKind,
	SubgraphBudget,
} from '../../shared/types.js'
import { loadSubgraph, reachableNodes } from '../graph/graph-index.js'
import type { AtlasStore } from '../storage/store.js'

export function getBlastRadius(
	store: AtlasStore,
	symbolStableId: string,
	opts?: { depth?: number; includeTests?: boolean },
): BlastRadiusResult {
	const symbol = store.getSymbolByStableId(symbolStableId)
	if (!symbol) {
		return emptyResult()
	}

	const symbolResult = store.symbolToResult(symbol)
	const maxDepth = opts?.depth ?? 5
	const includeTests = opts?.includeTests ?? true

	// blast radius = everything that depends on this symbol (inbound edges)
	const budget: SubgraphBudget = {
		maxDepth,
		maxNodes: 5000,
		maxEdges: 20000,
		edgeKinds: ['calls', 'imports', 'type_ref', 'extends'],
		timeoutMs: 5000,
	}

	const { graph, truncated, reason } = loadSubgraph(
		store,
		[symbolStableId],
		budget,
		'inbound',
	)

	const distances = reachableNodes(graph, symbolStableId, 'inbound', maxDepth)

	const direct: AffectedItem[] = []
	const transitive: AffectedItem[] = []
	const affectedFiles = new Set<string>()
	const affectedTestFiles = new Map<string, number>()

	for (const [nodeId, depth] of distances.entries()) {
		const sym = store.getSymbolByStableId(nodeId)
		if (!sym) continue

		const result = store.symbolToResult(sym)
		affectedFiles.add(result.filePath)

		// determine the relationship (edge kind from the graph)
		let relationship: EdgeKind = 'calls'
		if (graph.hasNode(symbolStableId) && graph.hasNode(nodeId)) {
			const edges = graph.inEdges(symbolStableId).filter(
				(e) => graph.source(e) === nodeId,
			)
			if (edges.length > 0) {
				relationship = graph.getEdgeAttributes(edges[0]).kind as EdgeKind
			}
		}

		const item: AffectedItem = { symbol: result, relationship, depth }

		if (depth === 1) {
			direct.push(item)
		} else {
			transitive.push(item)
		}

		// check for test files
		if (includeTests && isTestFile(result.filePath)) {
			const current = affectedTestFiles.get(result.filePath) ?? 0
			affectedTestFiles.set(result.filePath, current + 1)
		}
	}

	return {
		target: symbolResult,
		direct,
		transitive,
		affectedTests: [...affectedTestFiles.entries()].map(([file, count]) => ({
			file,
			testCount: count,
		})),
		summary: {
			totalSymbols: direct.length + transitive.length,
			totalFiles: affectedFiles.size,
			totalTestFiles: affectedTestFiles.size,
			maxDepthReached: Math.max(0, ...distances.values()),
		},
		truncated,
		truncationReason: reason,
	}
}

function isTestFile(path: string): boolean {
	return (
		path.includes('.test.') ||
		path.includes('.spec.') ||
		path.includes('__tests__') ||
		path.startsWith('test/')
	)
}

function emptyResult(): BlastRadiusResult {
	return {
		target: {
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
		direct: [],
		transitive: [],
		affectedTests: [],
		summary: { totalSymbols: 0, totalFiles: 0, totalTestFiles: 0, maxDepthReached: 0 },
		truncated: false,
	}
}
