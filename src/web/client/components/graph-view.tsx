import { useEffect, useRef, useState } from 'react'
import cytoscape from 'cytoscape'
import type { ElementDefinition } from 'cytoscape'
import { getStylesheet } from '../lib/graph-utils.js'

export interface GraphNodeData {
	id: string
	label: string
	kind: string
	qualifiedName: string
	filePath: string
	lineStart: number
	isExported?: boolean
	dependentCount?: number
}

export function GraphView({
	elements,
	layout = 'cose',
	onNodeClick,
	onNodeDoubleClick,
	className = '',
}: {
	elements: ElementDefinition[]
	layout?: string
	onNodeClick?: (data: GraphNodeData) => void
	onNodeDoubleClick?: (data: GraphNodeData) => void
	className?: string
}) {
	const containerRef = useRef<HTMLDivElement>(null)
	const cyRef = useRef<cytoscape.Core | null>(null)
	const [hover, setHover] = useState<{ x: number; y: number; data: GraphNodeData } | null>(null)
	const onNodeClickRef = useRef(onNodeClick)
	const onNodeDoubleClickRef = useRef(onNodeDoubleClick)

	useEffect(() => { onNodeClickRef.current = onNodeClick }, [onNodeClick])
	useEffect(() => { onNodeDoubleClickRef.current = onNodeDoubleClick }, [onNodeDoubleClick])

	useEffect(() => {
		if (!containerRef.current || elements.length === 0) return

		const cy = cytoscape({
			container: containerRef.current,
			elements,
			style: getStylesheet(),
			layout: {
				name: layout,
				animate: false,
				...(layout === 'cose' ? { nodeOverlap: 20, idealEdgeLength: 90, gravity: 0.5 } : {}),
				...(layout === 'concentric'
					? {
							concentric: (node: any) => (node.data('depth') === 0 ? 100 : 100 - node.data('depth') * 20),
							levelWidth: () => 1,
							minNodeSpacing: 60,
						}
					: {}),
				...(layout === 'breadthfirst' ? { directed: true, spacingFactor: 1.4 } : {}),
			} as any,
			minZoom: 0.2,
			maxZoom: 3,
			wheelSensitivity: 0.2,
		})

		cyRef.current = cy

		// hover: highlight neighborhood + show tooltip
		cy.on('mouseover', 'node', (evt) => {
			const node = evt.target
			cy.elements().addClass('faded')
			node.removeClass('faded').addClass('highlighted')
			node.connectedEdges().removeClass('faded').addClass('highlighted')
			node.connectedEdges().connectedNodes().removeClass('faded')
			const rect = containerRef.current!.getBoundingClientRect()
			const pos = node.renderedPosition()
			setHover({ x: pos.x + rect.left + 18, y: pos.y + rect.top - 8, data: node.data() })
		})
		cy.on('mouseout', 'node', () => {
			cy.elements().removeClass('faded highlighted')
			setHover(null)
		})

		cy.on('tap', 'node', (evt) => {
			onNodeClickRef.current?.(evt.target.data())
		})
		cy.on('dbltap', 'node', (evt) => {
			onNodeDoubleClickRef.current?.(evt.target.data())
		})

		return () => {
			cy.destroy()
			cyRef.current = null
			setHover(null)
		}
	}, [elements, layout])

	if (elements.length === 0) {
		return (
			<div className={`flex items-center justify-center text-text-muted text-sm ${className}`}>
				select a symbol to visualize
			</div>
		)
	}

	return (
		<>
			<div ref={containerRef} className={className} />
			{hover && (
				<div
					className="fixed z-50 pointer-events-none rounded-[var(--radius-default)] border border-border bg-surface-raised px-3 py-2 shadow-lg text-xs"
					style={{ left: hover.x, top: hover.y, maxWidth: 360 }}
				>
					<div className="flex items-center gap-2 mb-0.5">
						<span className="text-text font-mono font-semibold">{hover.data.label}</span>
						<span className="text-text-faint">{hover.data.kind}</span>
					</div>
					<div className="text-text-muted font-mono truncate">{hover.data.filePath}:{hover.data.lineStart}</div>
				</div>
			)}
		</>
	)
}
