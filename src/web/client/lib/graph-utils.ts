import type { DependencyResult, DependencyNode, BlastRadiusResult } from '../../../shared/types.js'
import type { ElementDefinition } from 'cytoscape'

// kind colors are sourced live from css vars so the graph follows the
// active theme. read at style application time, not at module load.
const KIND_VAR: Record<string, string> = {
	function: '--color-kind-function',
	class: '--color-kind-class',
	method: '--color-kind-method',
	interface: '--color-kind-interface',
	type: '--color-kind-type',
	variable: '--color-kind-variable',
	module: '--color-kind-module',
	enum: '--color-kind-enum',
	property: '--color-kind-property',
}

function cssVar(name: string, fallback = '#888'): string {
	if (typeof document === 'undefined') return fallback
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
	return v || fallback
}

function nodeColor(kind: string): string {
	return cssVar(KIND_VAR[kind] ?? '--color-text-muted', '#888')
}

const EDGE_COLORS: Record<string, string> = {
	calls: '--color-accent',
	imports: '--color-text-muted',
	contains: '--color-text-faint',
	extends: '--color-success',
	type_ref: '--color-warning',
	passed_as: '--color-accent',
	dispatches_to: '--color-success',
	instantiates: '--color-accent',
	field_access: '--color-warning',
}

const EDGE_STYLES: Record<string, string> = {
	calls: 'solid',
	imports: 'dashed',
	contains: 'dotted',
	extends: 'solid',
	type_ref: 'dashed',
	passed_as: 'dashed',
	dispatches_to: 'dashed',
	instantiates: 'solid',
	field_access: 'dotted',
}

function nodeId(qualifiedName: string): string {
	return qualifiedName.replace(/[^a-zA-Z0-9_]/g, '_')
}

function collectNodes(
	nodes: DependencyNode[],
	elements: ElementDefinition[],
	seen: Set<string>,
	rootId: string,
	isUpstream: boolean,
) {
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
				source: isUpstream ? id : rootId,
				target: isUpstream ? rootId : id,
				kind: node.edgeKind,
				label: node.edgeKind,
			},
		})
		if (node.children.length > 0) {
			collectNodes(node.children, elements, seen, id, isUpstream)
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

	collectNodes(result.upstream, elements, seen, rootId, true)
	collectNodes(result.downstream, elements, seen, rootId, false)

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
	const text = cssVar('--color-text', '#111')
	const textFaint = cssVar('--color-text-faint', '#aaa')
	const accent = cssVar('--color-accent', '#2563eb')
	const surface = cssVar('--color-surface', '#fff')

	return [
		{
			selector: 'node',
			style: {
				label: 'data(label)',
				'font-family': 'var(--font-mono), monospace',
				'font-size': '11px',
				'text-valign': 'bottom',
				'text-margin-y': 6,
				color: text,
				'text-background-color': surface,
				'text-background-opacity': 0.85,
				'text-background-padding': 2,
				'text-background-shape': 'roundrectangle',
				'background-color': (ele: any) => nodeColor(ele.data('kind')),
				width: (ele: any) => Math.max(22, Math.min(56, 22 + (ele.data('dependentCount') ?? 0) * 2.5)),
				height: (ele: any) => Math.max(22, Math.min(56, 22 + (ele.data('dependentCount') ?? 0) * 2.5)),
				'border-width': (ele: any) => (ele.data('isRoot') ? 3 : 1.5),
				'border-color': (ele: any) => (ele.data('isRoot') ? accent : surface),
				'border-opacity': 0.9,
			} as any,
		},
		{
			selector: 'edge',
			style: {
				width: 1.4,
				'line-color': (ele: any) => cssVar(EDGE_COLORS[ele.data('kind')] ?? '--color-text-muted', '#888'),
				'target-arrow-color': (ele: any) => cssVar(EDGE_COLORS[ele.data('kind')] ?? '--color-text-muted', '#888'),
				'target-arrow-shape': 'triangle',
				'arrow-scale': 0.8,
				'curve-style': 'bezier',
				'line-style': (ele: any) => EDGE_STYLES[ele.data('kind')] ?? 'solid',
				opacity: 0.65,
			} as any,
		},
		{
			selector: 'edge:selected',
			style: { opacity: 1, width: 2 },
		},
		{
			selector: 'node:selected',
			style: {
				'border-width': 3,
				'border-color': accent,
			},
		},
		{
			selector: 'node.faded, edge.faded',
			style: { opacity: 0.18 },
		},
		{
			selector: 'node.highlighted',
			style: { 'border-width': 3, 'border-color': accent, color: accent },
		},
		{
			selector: 'edge.highlighted',
			style: { opacity: 1, width: 2.5 },
		},
		{
			selector: 'node[label].small',
			style: { color: textFaint },
		},
	]
}
