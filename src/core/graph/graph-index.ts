import { MultiDirectedGraph } from 'graphology'
import type { EdgeKind, SubgraphBudget } from '../../shared/types.js'
import type { AtlasStore } from '../storage/store.js'

export interface GraphNode {
	stableId: string
	name: string
	qualifiedName: string
	kind: string
	fileId: number
}

export interface GraphEdge {
	kind: EdgeKind
	line: number | null
	confidence: string
}

// load a subgraph from SQLite into graphology for traversal.
// uses edge-type filtering and budget caps to prevent blowup.
export function loadSubgraph(
	store: AtlasStore,
	rootIds: string[],
	budget: SubgraphBudget,
	direction: 'outbound' | 'inbound' | 'both' = 'both',
): { graph: MultiDirectedGraph; truncated: boolean; reason?: string } {
	const graph = new MultiDirectedGraph()
	const visited = new Set<string>()
	const queue: { id: string; depth: number }[] = []
	let queueHead = 0
	let truncated = false
	let reason: string | undefined

	const startTime = Date.now()

	for (const id of rootIds) {
		queue.push({ id, depth: 0 })
	}

	// BFS expansion from SQLite
	while (queueHead < queue.length) {
		if (Date.now() - startTime > budget.timeoutMs) {
			truncated = true
			reason = `timeout (${budget.timeoutMs}ms)`
			break
		}
		if (graph.order >= budget.maxNodes) {
			truncated = true
			reason = `max nodes (${budget.maxNodes})`
			break
		}
		if (graph.size >= budget.maxEdges) {
			truncated = true
			reason = `max edges (${budget.maxEdges})`
			break
		}

		const { id, depth } = queue[queueHead++]
		if (visited.has(id)) continue
		if (depth > budget.maxDepth) continue
		visited.add(id)

		// add node if not already present
		if (!graph.hasNode(id)) {
			const sym = store.getSymbolByStableId(id)
			if (sym) {
				graph.addNode(id, {
					stableId: sym.stableId,
					name: sym.name,
					qualifiedName: sym.qualifiedName,
					kind: sym.kind,
					fileId: sym.fileId,
				} satisfies GraphNode)
			} else {
				// symbol not in index (external or deleted), add as placeholder
				graph.addNode(id, {
					stableId: id,
					name: '<unknown>',
					qualifiedName: '<unknown>',
					kind: 'variable',
					fileId: 0,
				} satisfies GraphNode)
			}
		}

		// expand edges (check budget inside loop to prevent overshoot on high-degree nodes)
		if (direction === 'outbound' || direction === 'both') {
			for (const kind of budget.edgeKinds) {
				if (graph.size >= budget.maxEdges) break
				const edges = store.getDirectEdgesFrom(id, kind)
				for (const edge of edges) {
					if (graph.size >= budget.maxEdges || graph.order >= budget.maxNodes) {
						truncated = true
						reason = reason ?? `budget exceeded during expansion`
						break
					}
					ensureNode(graph, store, edge.targetId)
					if (!visited.has(edge.targetId)) {
						queue.push({ id: edge.targetId, depth: depth + 1 })
					}
					graph.addEdge(id, edge.targetId, {
						kind: edge.kind,
						line: edge.line,
						confidence: edge.confidence,
					} satisfies GraphEdge)
				}
			}
		}

		if (direction === 'inbound' || direction === 'both') {
			for (const kind of budget.edgeKinds) {
				if (graph.size >= budget.maxEdges) break
				const edges = store.getDirectEdgesTo(id, kind)
				for (const edge of edges) {
					if (graph.size >= budget.maxEdges || graph.order >= budget.maxNodes) {
						truncated = true
						reason = reason ?? `budget exceeded during expansion`
						break
					}
					ensureNode(graph, store, edge.sourceId)
					if (!visited.has(edge.sourceId)) {
						queue.push({ id: edge.sourceId, depth: depth + 1 })
					}
					graph.addEdge(edge.sourceId, id, {
						kind: edge.kind,
						line: edge.line,
						confidence: edge.confidence,
					} satisfies GraphEdge)
				}
			}
		}
	}

	return { graph, truncated, reason }
}

function ensureNode(
	graph: MultiDirectedGraph,
	store: AtlasStore,
	id: string,
) {
	if (graph.hasNode(id)) return

	const sym = store.getSymbolByStableId(id)
	if (sym) {
		graph.addNode(id, {
			stableId: sym.stableId,
			name: sym.name,
			qualifiedName: sym.qualifiedName,
			kind: sym.kind,
			fileId: sym.fileId,
		} satisfies GraphNode)
	} else {
		graph.addNode(id, {
			stableId: id,
			name: '<unknown>',
			qualifiedName: '<unknown>',
			kind: 'variable',
			fileId: 0,
		} satisfies GraphNode)
	}
}

// find all nodes reachable from a root following edges in a given direction.
// returns nodes grouped by distance from root.
export function reachableNodes(
	graph: MultiDirectedGraph,
	rootId: string,
	direction: 'outbound' | 'inbound',
	maxDepth: number,
	// #85: secondary seeds that should count as one hop from the
	// primary root. used by blast-radius on interface/class targets
	// where member symbols are seeded and structural consumers are
	// reached via inbound walks from each member.
	secondarySeeds?: string[],
): Map<string, number> {
	const distances = new Map<string, number>()

	if (!graph.hasNode(rootId)) return distances

	const queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }]
	if (secondarySeeds) {
		for (const id of secondarySeeds) {
			if (graph.hasNode(id)) queue.push({ id, depth: 1 })
		}
	}
	let head = 0
	const visited = new Set<string>()

	while (head < queue.length) {
		const { id, depth } = queue[head++]
		if (visited.has(id)) continue
		if (depth > maxDepth) continue
		visited.add(id)

		if (id !== rootId) {
			distances.set(id, depth)
		}

		const neighbors =
			direction === 'outbound'
				? graph.outNeighbors(id)
				: graph.inNeighbors(id)

		for (const neighbor of neighbors) {
			if (!visited.has(neighbor)) {
				queue.push({ id: neighbor, depth: depth + 1 })
			}
		}
	}

	return distances
}
