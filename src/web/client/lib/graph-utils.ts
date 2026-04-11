import type { DependencyResult, DependencyNode, BlastRadiusResult } from '../../../shared/types.js'
import type { ElementDefinition } from 'cytoscape'

const KIND_COLORS: Record<string, string> = {
	function: '#818cf8',
	class: '#34d399',
	method: '#22d3ee',
	interface: '#a78bfa',
	type: '#fbbf24',
	variable: '#fb7185',
	module: '#38bdf8',
	enum: '#fb923c',
	property: '#9ca3af',
}

const EDGE_COLORS: Record<string, string> = {
	calls: '#818cf8',
	imports: '#6b7280',
	contains: '#374151',
	extends: '#34d399',
	type_ref: '#a78bfa',
}

const EDGE_STYLES: Record<string, string> = {
	calls: 'solid',
	imports: 'dashed',
	contains: 'dotted',
	extends: 'solid',
	type_ref: 'dashed',
}

function nodeId(qualifiedName: string): string {
	return qualifiedName.replace(/[^a-zA-Z0-9_]/g, '_')
}

function collectNodes(nodes: DependencyNode[], elements: ElementDefinition[], seen: Set<string>, rootId: string) {
	for (const node of nodes) {
		const id = nodeId(node.symbol.qualifiedName)
		if (seen.has(id)) continue
		seen.add(id)
		elements.push({
			data: {
				id,
				label: node.symbol.name,
				kind: node.symbol.kind,
				qualifiedName: node.symbol.qualifiedName,
				filePath: node.symbol.filePath,
				lineStart: node.symbol.lineStart,
				isExported: node.symbol.isExported,
				depth: node.depth,
				dependentCount: node.symbol.dependentCount,
			},
		})
		elements.push({
			data: {
				source: node.edgeKind === 'imports' || node.edgeKind === 'calls' ? rootId : id,
				target: node.edgeKind === 'imports' || node.edgeKind === 'calls' ? id : rootId,
				kind: node.edgeKind,
				label: node.edgeKind,
			},
		})
		if (node.children.length > 0) {
			collectNodes(node.children, elements, seen, id)
		}
	}
}

export function depsToElements(result: DependencyResult): ElementDefinition[] {
	const elements: ElementDefinition[] = []
	const seen = new Set<string>()

	const rootId = nodeId(result.symbol.qualifiedName)
	seen.add(rootId)
	elements.push({
		data: {
			id: rootId,
			label: result.symbol.name,
			kind: result.symbol.kind,
			qualifiedName: result.symbol.qualifiedName,
			filePath: result.symbol.filePath,
			lineStart: result.symbol.lineStart,
			isExported: result.symbol.isExported,
			depth: 0,
			isRoot: true,
		},
	})

	collectNodes(result.upstream, elements, seen, rootId)
	collectNodes(result.downstream, elements, seen, rootId)

	return elements
}

export function blastToElements(result: BlastRadiusResult): ElementDefinition[] {
	const elements: ElementDefinition[] = []
	const seen = new Set<string>()

	const rootId = nodeId(result.target.qualifiedName)
	seen.add(rootId)
	elements.push({
		data: {
			id: rootId,
			label: result.target.name,
			kind: result.target.kind,
			qualifiedName: result.target.qualifiedName,
			filePath: result.target.filePath,
			lineStart: result.target.lineStart,
			depth: 0,
			isRoot: true,
		},
	})

	for (const item of [...result.direct, ...result.transitive]) {
		const id = nodeId(item.symbol.qualifiedName)
		if (seen.has(id)) continue
		seen.add(id)
		elements.push({
			data: {
				id,
				label: item.symbol.name,
				kind: item.symbol.kind,
				qualifiedName: item.symbol.qualifiedName,
				filePath: item.symbol.filePath,
				lineStart: item.symbol.lineStart,
				depth: item.depth,
			},
		})
		elements.push({
			data: {
				source: rootId,
				target: id,
				kind: item.relationship,
				label: item.relationship,
			},
		})
	}

	return elements
}

export function getStylesheet(): any[] {
	return [
		{
			selector: 'node',
			style: {
				label: 'data(label)',
				'font-size': '10px',
				'text-valign': 'bottom',
				'text-margin-y': 4,
				color: '#e5e5e5',
				'background-color': (ele: any) => KIND_COLORS[ele.data('kind')] ?? '#6b7280',
				width: (ele: any) => Math.max(20, Math.min(40, 20 + (ele.data('dependentCount') ?? 0) * 2)),
				height: (ele: any) => Math.max(20, Math.min(40, 20 + (ele.data('dependentCount') ?? 0) * 2)),
				'border-width': (ele: any) => ele.data('isRoot') ? 3 : 1,
				'border-color': (ele: any) => ele.data('isRoot') ? '#6366f1' : '#333',
			} as any,
		},
		{
			selector: 'edge',
			style: {
				width: 1.5,
				'line-color': (ele: any) => EDGE_COLORS[ele.data('kind')] ?? '#6b7280',
				'target-arrow-color': (ele: any) => EDGE_COLORS[ele.data('kind')] ?? '#6b7280',
				'target-arrow-shape': 'triangle',
				'curve-style': 'bezier',
				'line-style': (ele: any) => EDGE_STYLES[ele.data('kind')] ?? 'solid',
				label: 'data(label)',
				'font-size': '8px',
				color: '#737373',
				'text-rotation': 'autorotate',
				'text-margin-y': -8,
			} as any,
		},
		{
			selector: 'node:selected',
			style: {
				'border-width': 3,
				'border-color': '#6366f1',
				'background-color': '#6366f1',
			},
		},
	]
}
