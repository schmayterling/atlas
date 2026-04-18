import type {
	BlastRadiusResult,
	DeadCodeResult,
	DependencyResult,
	FlowTraceResult,
	SearchResult,
	StatusResult,
	SymbolOverview,
} from '../shared/types.js'

export function formatStatus(r: StatusResult): string {
	const lines = [
		`health: ${r.health}`,
		`files: ${r.stats.files}, symbols: ${r.stats.symbols}, edges: ${r.stats.edges}`,
		`last indexed: ${r.lastIndexedAt ? new Date(r.lastIndexedAt).toISOString() : 'never'}`,
	]
	if (r.lastCommit) lines.push(`commit: ${r.lastCommit.slice(0, 8)}`)
	if (r.lastBranch) lines.push(`branch: ${r.lastBranch}`)
	const langs = Object.entries(r.languages)
		.map(([l, c]) => `${l}: ${c}`)
		.join(', ')
	if (langs) lines.push(`languages: ${langs}`)
	return lines.join('\n')
}

export function formatSearch(r: SearchResult): string {
	if (r.total === 0) return `no results for "${r.query}"`
	const lines = [`${r.total} results for "${r.query}"`, '']
	for (const sym of r.results) {
		lines.push(`${sym.kind} ${sym.name}  ${sym.filePath}:${sym.lineStart}`)
		if (sym.signature) lines.push(`  signature: ${sym.signature}`)
	}
	return lines.join('\n')
}

export function formatDeps(r: DependencyResult): string {
	const lines = [`${r.symbol.name} (${r.symbol.filePath}:${r.symbol.lineStart})`]
	if (r.upstream.length > 0) {
		lines.push('', 'depended on by:')
		for (const dep of r.upstream) {
			lines.push(`  ${dep.symbol.kind} ${dep.symbol.name}  ${dep.symbol.filePath}:${dep.symbol.lineStart}  [${dep.edgeKind}]`)
		}
	}
	if (r.downstream.length > 0) {
		lines.push('', 'depends on:')
		for (const dep of r.downstream) {
			lines.push(`  ${dep.symbol.kind} ${dep.symbol.name}  ${dep.symbol.filePath}:${dep.symbol.lineStart}  [${dep.edgeKind}]`)
		}
	}
	lines.push('', `${r.stats.totalNodes} nodes, ${r.stats.totalEdges} edges`)
	return lines.join('\n')
}

export function formatBlast(r: BlastRadiusResult): string {
	const lines = [`blast radius for ${r.target.name} (${r.target.filePath}:${r.target.lineStart})`]
	if (r.direct.length > 0) {
		lines.push('', `direct (${r.direct.length}):`)
		for (const item of r.direct) {
			lines.push(`  ${item.symbol.kind} ${item.symbol.name}  ${item.symbol.filePath}:${item.symbol.lineStart}  [${item.relationship}]`)
		}
	}
	if (r.transitive.length > 0) {
		lines.push('', `transitive (${r.transitive.length}):`)
		for (const item of r.transitive.slice(0, 20)) {
			lines.push(`  ${item.symbol.kind} ${item.symbol.name}  ${item.symbol.filePath}:${item.symbol.lineStart}  depth ${item.depth}`)
		}
		if (r.transitive.length > 20) lines.push(`  ...and ${r.transitive.length - 20} more`)
	}
	lines.push('', `summary: ${r.summary.totalSymbols} symbols, ${r.summary.totalFiles} files`)
	return lines.join('\n')
}

export function formatTrace(r: FlowTraceResult): string {
	if (r.paths.length === 0) {
		return `no paths from ${r.source.name} to ${r.target.name}`
	}
	const lines = [`${r.stats.totalPaths} paths from ${r.source.name} to ${r.target.name}`]
	for (let i = 0; i < r.paths.length; i++) {
		const path = r.paths[i]
		lines.push('', `path ${i + 1} (${path.length} hops):`)
		for (let j = 0; j < path.nodes.length; j++) {
			const node = path.nodes[j]
			const prefix = j === 0 ? '  ' : '  -> '
			lines.push(`${prefix}${node.name} (${node.filePath}:${node.lineStart})`)
		}
	}
	return lines.join('\n')
}

export function formatDeadCode(r: DeadCodeResult): string {
	if (r.stats.total === 0) return 'no dead code found'
	const lines = [`${r.stats.total} unreferenced symbols:`]
	for (const sym of r.symbols) {
		lines.push(`  ${sym.kind} ${sym.name}  ${sym.filePath}:${sym.lineStart}`)
	}
	return lines.join('\n')
}

// one-shot overview for atlas_overview. a single text block with
// sections keeps the agent from chaining resolve + deps + blast +
// testCoverage + subsystem. counts are included so the agent can
// decide whether to drill into atlas_deps / atlas_blast_radius for
// the full list.
export function formatOverview(r: SymbolOverview): string {
	const s = r.symbol
	const lines: string[] = []
	lines.push(`${s.kind} ${s.name}`)
	lines.push(`  file: ${s.filePath}:${s.lineStart}`)
	if (s.signature) lines.push(`  signature: ${s.signature}`)
	lines.push(`  exported: ${s.isExported}`)
	if (r.subsystem) lines.push(`  subsystem: ${r.subsystem.name} (${r.subsystem.id})`)

	lines.push('', `upstream callers (${r.upstream.length}):`)
	if (r.upstream.length === 0) {
		lines.push('  (none)')
	} else {
		for (const n of r.upstream) {
			lines.push(`  ${n.symbol.kind.padEnd(9)} ${n.symbol.name}  ${n.symbol.filePath}:${n.symbol.lineStart}  [${n.edgeKind}]`)
		}
	}

	lines.push('', `downstream callees (${r.downstream.length}):`)
	if (r.downstream.length === 0) {
		lines.push('  (none)')
	} else {
		for (const n of r.downstream) {
			lines.push(`  ${n.symbol.kind.padEnd(9)} ${n.symbol.name}  ${n.symbol.filePath}:${n.symbol.lineStart}  [${n.edgeKind}]`)
		}
	}

	lines.push('', `blast radius: ${r.blastRadius.total} affected symbol${r.blastRadius.total === 1 ? '' : 's'}`)
	if (r.blastRadius.sample.length > 0 && r.blastRadius.total > r.downstream.length) {
		lines.push(`  sample (first ${r.blastRadius.sample.length}):`)
		for (const n of r.blastRadius.sample) {
			lines.push(`    ${n.symbol.kind.padEnd(9)} ${n.symbol.name}  ${n.symbol.filePath}:${n.symbol.lineStart}  depth=${n.depth}`)
		}
	}

	lines.push('', `test coverage:`)
	if (!r.testCoverage || r.testCoverage.tests.length === 0) {
		lines.push('  (no tests)')
	} else {
		lines.push(`  covered by ${r.testCoverage.tests.length} test file${r.testCoverage.tests.length === 1 ? '' : 's'} (${r.testCoverage.coveredBy}):`)
		for (const t of r.testCoverage.tests) {
			lines.push(`    ${t.confidence.padEnd(8)} ${t.testFilePath}`)
		}
	}

	return lines.join('\n')
}
