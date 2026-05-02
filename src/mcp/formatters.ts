import type { HotspotEntry } from '../core/queries/hotspots.js'
import type {
	BlastRadiusResult,
	CallSite,
	DeadCodeResult,
	DependencyResult,
	FileArticleResult,
	FileInfo,
	FlowTraceResult,
	SearchResult,
	StatusResult,
	SymbolOverview,
} from '../shared/types.js'

function compactInline(value: string, maxChars: number): string {
	const text = value.replace(/\s+/g, ' ').trim()
	if (text.length <= maxChars) return text
	return `${text.slice(0, maxChars - 3)}...`
}

export function formatSignature(value: string, maxChars: number): string {
	return compactInline(value, maxChars).replace(/\):\s*:\s*/g, '): ')
}

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
		if (sym.signature) lines.push(`  signature: ${formatSignature(sym.signature, 180)}`)
	}
	return lines.join('\n')
}

export function formatFiles(
	files: FileInfo[],
	opts: { total: number; limit: number; pathPrefix?: string; language?: string },
): string {
	if (files.length === 0) return 'no files found'
	const filters = [
		opts.pathPrefix ? `pathPrefix=${opts.pathPrefix}` : '',
		opts.language ? `language=${opts.language}` : '',
	].filter(Boolean)
	const header = filters.length > 0 ? `files (${filters.join(', ')})` : 'files'
	const lines = [`${header}: ${files.length}/${opts.total}`]
	for (const f of files) {
		lines.push(
			`  ${String(f.symbolCount).padStart(4)} symbols  ${f.language.padEnd(10)} ${String(f.sizeBytes).padStart(7)}b  ${f.path}`,
		)
	}
	if (files.length < opts.total) lines.push(`  ... (+${opts.total - files.length} more files)`)
	return lines.join('\n')
}

export function formatFileOutline(
	r: FileArticleResult,
	opts: {
		symbolLimit: number
		importLimit: number
		includeHistory: boolean
		totalSymbols?: number
		filters?: string[]
	},
): string {
	const exported = r.symbols.filter((s) => s.isExported)
	const internal = r.symbols.filter((s) => !s.isExported)
	const totalSymbols = opts.totalSymbols ?? r.symbols.length
	const visibleSymbols = r.symbols.slice(0, opts.symbolLimit)
	const visibleImports = r.imports.slice(0, opts.importLimit)
	const visibleImporters = r.importers.slice(0, opts.importLimit)
	const lines = [
		`file ${r.path}`,
		`  language: ${r.language}${r.isTest ? ' test' : ''}`,
		`  size: ${r.sizeBytes} bytes`,
		`  symbols: ${r.symbols.length}${totalSymbols === r.symbols.length ? '' : `/${totalSymbols}`} (${exported.length} exported, ${internal.length} internal)`,
		`  imports=${r.imports.length} importedBy=${r.importers.length}`,
	]
	if (opts.filters && opts.filters.length > 0) lines.push(`  filters: ${opts.filters.join(', ')}`)
	if (r.summary) lines.push(`  summary: ${r.summary}`)

	if (visibleSymbols.length > 0) {
		const total =
			totalSymbols === r.symbols.length ? r.symbols.length : `${r.symbols.length}/${totalSymbols}`
		lines.push('', `symbols (${visibleSymbols.length}/${total}):`)
		for (const sym of visibleSymbols) {
			const exportedMarker = sym.isExported ? 'exported' : 'internal'
			lines.push(
				`  ${sym.kind.padEnd(9)} ${exportedMarker.padEnd(8)} ${sym.name}  L${sym.lineStart}-${sym.lineEnd}`,
			)
			if (sym.signature) lines.push(`    ${formatSignature(sym.signature, 140)}`)
		}
		if (visibleSymbols.length < r.symbols.length) {
			lines.push(`  ... (+${r.symbols.length - visibleSymbols.length} more symbols)`)
		}
	}

	if (visibleImports.length > 0) {
		lines.push('', `imports (${visibleImports.length}/${r.imports.length}):`)
		for (const imp of visibleImports) {
			const target = imp.targetPath || '(unresolved)'
			const typeOnly = imp.isTypeOnly ? ' type' : ''
			lines.push(`  L${imp.line}${typeOnly} ${imp.importPath} -> ${target}`)
		}
		if (visibleImports.length < r.imports.length) {
			lines.push(`  ... (+${r.imports.length - visibleImports.length} more imports)`)
		}
	}

	if (visibleImporters.length > 0) {
		lines.push('', `imported by (${visibleImporters.length}/${r.importers.length}):`)
		for (const imp of visibleImporters) {
			lines.push(`  ${imp.sourcePath}:L${imp.line}  ${imp.importPath}`)
		}
		if (visibleImporters.length < r.importers.length) {
			lines.push(`  ... (+${r.importers.length - visibleImporters.length} more importers)`)
		}
	}

	if (opts.includeHistory) {
		if (r.lastChanged) {
			const date = new Date(r.lastChanged.authoredAt).toISOString().slice(0, 10)
			lines.push(
				'',
				`last changed: ${date} ${r.lastChanged.hash.slice(0, 7)} ${r.lastChanged.subject}`,
			)
		}
		if (r.contributors.length > 0) {
			lines.push(
				`contributors: ${r.contributors.map((c) => `${c.authorName} (${c.commits})`).join(', ')}`,
			)
		}
		if (r.coChanged.length > 0) {
			lines.push('co-changed:')
			for (const c of r.coChanged) lines.push(`  ${c.count}  ${c.otherPath}`)
		}
	}

	return lines.join('\n')
}

export function formatDeps(r: DependencyResult): string {
	const lines = [`${r.symbol.name} (${r.symbol.filePath}:${r.symbol.lineStart})`]
	if (r.upstream.length > 0) {
		lines.push('', 'depended on by:')
		for (const dep of r.upstream) {
			lines.push(
				`  ${dep.symbol.kind} ${dep.symbol.name}  ${dep.symbol.filePath}:${dep.symbol.lineStart}  [${dep.edgeKind}]`,
			)
		}
	}
	if (r.downstream.length > 0) {
		lines.push('', 'depends on:')
		for (const dep of r.downstream) {
			lines.push(
				`  ${dep.symbol.kind} ${dep.symbol.name}  ${dep.symbol.filePath}:${dep.symbol.lineStart}  [${dep.edgeKind}]`,
			)
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
			lines.push(
				`  ${item.symbol.kind} ${item.symbol.name}  ${item.symbol.filePath}:${item.symbol.lineStart}  [${item.relationship}]`,
			)
		}
	}
	if (r.transitive.length > 0) {
		lines.push('', `transitive (${r.transitive.length}):`)
		for (const item of r.transitive.slice(0, 20)) {
			lines.push(
				`  ${item.symbol.kind} ${item.symbol.name}  ${item.symbol.filePath}:${item.symbol.lineStart}  depth ${item.depth}`,
			)
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

export function formatHotspots(rows: HotspotEntry[]): string {
	if (rows.length === 0) return 'no hotspots found. run `atlas index` first.'
	const lines = ['score  fanin  commits  coverage  symbol']
	for (const r of rows) {
		lines.push(
			`${String(Math.round(r.score)).padStart(5)}  ${String(r.fanin).padStart(5)}  ${String(r.commits).padStart(7)}  ${r.coverage.padEnd(8)}  ${r.name}  ${r.filePath}:${r.lineStart}`,
		)
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
	if (s.signature) lines.push(`  signature: ${formatSignature(s.signature, 180)}`)
	lines.push(`  exported: ${s.isExported}`)
	if (r.subsystem) lines.push(`  subsystem: ${r.subsystem.name} (${r.subsystem.id})`)

	lines.push('', `upstream callers (${r.upstream.length}):`)
	if (r.upstream.length === 0) {
		lines.push('  (none)')
	} else {
		for (const n of r.upstream) {
			lines.push(
				`  ${n.symbol.kind.padEnd(9)} ${n.symbol.name}  ${n.symbol.filePath}:${n.symbol.lineStart}  [${n.edgeKind}]`,
			)
		}
	}

	lines.push('', `downstream callees (${r.downstream.length}):`)
	if (r.downstream.length === 0) {
		lines.push('  (none)')
	} else {
		for (const n of r.downstream) {
			lines.push(
				`  ${n.symbol.kind.padEnd(9)} ${n.symbol.name}  ${n.symbol.filePath}:${n.symbol.lineStart}  [${n.edgeKind}]`,
			)
		}
	}

	lines.push(
		'',
		`blast radius: ${r.blastRadius.total} affected symbol${r.blastRadius.total === 1 ? '' : 's'}`,
	)
	if (r.blastRadius.sample.length > 0 && r.blastRadius.total > r.downstream.length) {
		lines.push(`  sample (first ${r.blastRadius.sample.length}):`)
		for (const n of r.blastRadius.sample) {
			lines.push(
				`    ${n.symbol.kind.padEnd(9)} ${n.symbol.name}  ${n.symbol.filePath}:${n.symbol.lineStart}  depth=${n.depth}`,
			)
		}
	}

	lines.push('', 'test coverage:')
	if (!r.testCoverage || r.testCoverage.tests.length === 0) {
		lines.push('  (no tests)')
	} else {
		lines.push(
			`  covered by ${r.testCoverage.tests.length} test file${r.testCoverage.tests.length === 1 ? '' : 's'} (${r.testCoverage.coveredBy}):`,
		)
		for (const t of r.testCoverage.tests) {
			lines.push(`    ${t.confidence.padEnd(8)} ${t.testFilePath}`)
		}
	}

	return lines.join('\n')
}

// per-call-site list. one line per edge row so the output maps 1:1
// to `grep -n`. source symbol is included with file:line of its
// definition so the agent can jump to either the call site or the
// containing function. grouped by source file to keep related calls
// adjacent without sacrificing the stable sort.
export function formatCallSites(
	target: string,
	direction: 'inbound' | 'outbound',
	sites: CallSite[],
): string {
	if (sites.length === 0) {
		const verb = direction === 'inbound' ? 'callers of' : 'callees of'
		return `no ${verb} ${target}`
	}
	const header =
		direction === 'inbound'
			? `${sites.length} call site${sites.length === 1 ? '' : 's'} calling ${target}:`
			: `${sites.length} call site${sites.length === 1 ? '' : 's'} called from ${target}:`
	const lines = [header]
	for (const s of sites) {
		const line = s.callSiteLine ?? s.sourceLineStart
		lines.push(
			`  ${s.sourceFilePath}:${line}  ${s.sourceKind.padEnd(9)} ${s.sourceName}  [${s.edgeKind}]`,
		)
	}
	return lines.join('\n')
}
