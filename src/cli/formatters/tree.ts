import pc from 'picocolors'
import type { DependencyNode } from '../../shared/types.js'
import { badge, fileRef } from './common.js'

export function renderDependencyTree(
	nodes: DependencyNode[],
	prefix = '',
	isLast = true,
) {
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]
		const last = i === nodes.length - 1
		const connector = last ? '└── ' : '├── '
		const childPrefix = last ? '    ' : '│   '

		const kindBadge = badge(node.symbol.kind)
		const name = pc.bold(node.symbol.name)
		const sig = node.symbol.signature ? pc.dim(` ${node.symbol.signature}`) : ''
		const ref = fileRef(node.symbol.filePath, node.symbol.lineStart)
		const edge = pc.dim(` [${node.edgeKind}]`)

		console.log(`${prefix}${connector}${kindBadge} ${name}${sig}${edge}`)
		console.log(`${prefix}${childPrefix}${ref}`)

		if (node.children.length > 0) {
			renderDependencyTree(node.children, prefix + childPrefix, last)
		}
	}
}
