import { useEffect, useRef } from 'react'
import cytoscape from 'cytoscape'
import type { ElementDefinition } from 'cytoscape'
import { getStylesheet } from '../lib/graph-utils.js'

export function GraphView({
	elements,
	layout = 'cose',
	onNodeClick,
	onNodeDoubleClick,
	className = '',
}: {
	elements: ElementDefinition[]
	layout?: string
	onNodeClick?: (data: any) => void
	onNodeDoubleClick?: (data: any) => void
	className?: string
}) {
	const containerRef = useRef<HTMLDivElement>(null)
	const cyRef = useRef<cytoscape.Core | null>(null)
	const onNodeClickRef = useRef(onNodeClick)
	const onNodeDoubleClickRef = useRef(onNodeDoubleClick)

	useEffect(() => {
		onNodeClickRef.current = onNodeClick
	}, [onNodeClick])
	useEffect(() => {
		onNodeDoubleClickRef.current = onNodeDoubleClick
	}, [onNodeDoubleClick])

	useEffect(() => {
		if (!containerRef.current || elements.length === 0) return

		const cy = cytoscape({
			container: containerRef.current,
			elements,
			style: getStylesheet(),
			layout: {
				name: layout,
				animate: false,
				...(layout === 'cose' ? { nodeOverlap: 20, idealEdgeLength: 80, gravity: 0.5 } : {}),
				...(layout === 'concentric'
					? {
							concentric: (node: any) => {
								const depth = node.data('depth') ?? 0
								return depth === 0 ? 100 : 100 - depth * 20
							},
							levelWidth: () => 1,
							minNodeSpacing: 50,
						}
					: {}),
				...(layout === 'breadthfirst' ? { directed: true, spacingFactor: 1.2 } : {}),
			} as any,
			minZoom: 0.2,
			maxZoom: 3,
		})

		cyRef.current = cy

		cy.on('tap', 'node', (evt) => {
			onNodeClickRef.current?.(evt.target.data())
		})

		cy.on('dbltap', 'node', (evt) => {
			onNodeDoubleClickRef.current?.(evt.target.data())
		})

		return () => {
			cy.destroy()
			cyRef.current = null
		}
	}, [elements, layout])

	if (elements.length === 0) {
		return (
			<div className={`flex items-center justify-center text-text-muted text-sm ${className}`}>
				select a symbol to visualize
			</div>
		)
	}

	return <div ref={containerRef} className={`${className}`} />
}
