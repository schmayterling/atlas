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
		edgeKinds: ['calls', 'type_ref', 'extends'],
		timeoutMs: 5000,
	}

	const { graph, truncated, reason } = loadSubgraph(
		store,
		[symbolStableId],
		budget,
		'inbound',
	)

	const distances = reachableNodes(graph, symbolStableId, 'inbound', maxDepth)

	// batch-fetch all symbols and convert to results in 2 bulk queries
	const nodeIds = [...distances.keys()]
	const symMap = store.getSymbolsByStableIds(nodeIds)
	const symResults = store.symbolsToResults([...symMap.values()])
	const resultByStableId = new Map<string, import('../../shared/types.js').SymbolResult>()
	const symValues = [...symMap.values()]
	for (let i = 0; i < symValues.length; i++) {
		resultByStableId.set(symValues[i].stableId, symResults[i])
	}

	const direct: AffectedItem[] = []
	const transitive: AffectedItem[] = []
	const affectedFiles = new Set<string>()
	const affectedTestFiles = new Map<string, number>()

	for (const [nodeId, depth] of distances.entries()) {
		const result = resultByStableId.get(nodeId)
		if (!result) continue
		affectedFiles.add(result.filePath)

		// determine the relationship by finding the edge that connects this node
		// for direct items: look at edges from nodeId to the target
		// for transitive items: look at any edge from nodeId to any visited node
		let relationship: EdgeKind = 'calls'
		if (graph.hasNode(nodeId)) {
			const outEdges = graph.outEdges(nodeId)
			for (const e of outEdges) {
				const target = graph.target(e)
				if (distances.has(target) || target === symbolStableId) {
					relationship = graph.getEdgeAttributes(e).kind as EdgeKind
					break
				}
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
