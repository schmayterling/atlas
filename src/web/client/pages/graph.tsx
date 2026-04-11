import { useState, useCallback } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import type { ElementDefinition } from 'cytoscape'
import type { SymbolResult } from '../../../shared/types.js'
import { api } from '../lib/api.js'
import { depsToElements, blastToElements } from '../lib/graph-utils.js'
import { SearchInput } from '../components/search-input.js'
import { GraphView } from '../components/graph-view.js'
import { SymbolCard } from '../components/symbol-card.js'

type Mode = 'deps' | 'blast'
type Direction = 'upstream' | 'downstream' | 'both'

export function GraphPage() {
	const [query, setQuery] = useState('')
	const [mode, setMode] = useState<Mode>('deps')
	const [direction, setDirection] = useState<Direction>('both')
	const [depth, setDepth] = useState(3)
	const [elements, setElements] = useState<ElementDefinition[]>([])
	const [selected, setSelected] = useState<SymbolResult | null>(null)
	const [info, setInfo] = useState('')
	const [loading, setLoading] = useState(false)

	const loadGraph = useCallback(
		async (q: string) => {
			if (!q.trim()) return
			setLoading(true)
			setInfo('')
			try {
				if (mode === 'deps') {
					const result = await api.deps(q, { direction, depth })
					const els = depsToElements(result)
					setElements(els)
					setInfo(
						`${result.stats.totalNodes} nodes, ${result.stats.totalEdges} edges${result.truncated ? ' (truncated)' : ''}`,
					)
				} else {
					const result = await api.blast(q, { depth })
					const els = blastToElements(result)
					setElements(els)
					setInfo(
						`${result.summary.totalSymbols} affected symbols across ${result.summary.totalFiles} files${result.truncated ? ' (truncated)' : ''}`,
					)
				}
			} catch (e: any) {
				setInfo(e.message || 'error loading graph')
				setElements([])
			} finally {
				setLoading(false)
			}
		},
		[mode, direction, depth],
	)

	const handleNodeClick = (data: any) => {
		setSelected({
			name: data.label,
			qualifiedName: data.qualifiedName,
			kind: data.kind,
			signature: null,
			filePath: data.filePath,
			lineStart: data.lineStart,
			lineEnd: data.lineStart,
			isExported: data.isExported ?? false,
			docComment: null,
			usageCount: 0,
			dependentCount: data.dependentCount ?? 0,
		})
	}

	const handleNodeDoubleClick = (data: any) => {
		setQuery(data.qualifiedName)
		loadGraph(data.qualifiedName)
	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center gap-3 mb-4">
				<h1 className="text-lg font-bold">graph</h1>
				{info && <span className="text-xs text-text-muted">{info}</span>}
			</div>

			<div className="flex gap-3 mb-4 items-end flex-wrap">
				<div className="flex-1 min-w-[200px]">
					<label className="text-xs text-text-muted mb-1 block">symbol</label>
					<SearchInput
						value={query}
						onChange={setQuery}
						placeholder="enter symbol name..."
						debounceMs={0}
					/>
				</div>

				<Tabs.Root value={mode} onValueChange={(v) => setMode(v as Mode)}>
					<Tabs.List className="flex border border-border rounded overflow-hidden">
						<Tabs.Trigger
							value="deps"
							className="px-3 py-2 text-xs data-[state=active]:bg-accent/20 data-[state=active]:text-accent text-text-muted hover:text-text transition-colors"
						>
							dependencies
						</Tabs.Trigger>
						<Tabs.Trigger
							value="blast"
							className="px-3 py-2 text-xs data-[state=active]:bg-accent/20 data-[state=active]:text-accent text-text-muted hover:text-text transition-colors border-l border-border"
						>
							blast radius
						</Tabs.Trigger>
					</Tabs.List>
				</Tabs.Root>

				{mode === 'deps' && (
					<div className="flex border border-border rounded overflow-hidden">
						{(['upstream', 'downstream', 'both'] as Direction[]).map((d) => (
							<button
								key={d}
								onClick={() => setDirection(d)}
								className={`px-3 py-2 text-xs transition-colors cursor-pointer ${
									direction === d ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text'
								} ${d !== 'upstream' ? 'border-l border-border' : ''}`}
							>
								{d}
							</button>
						))}
					</div>
				)}

				<div className="flex items-center gap-2">
					<label className="text-xs text-text-muted">depth</label>
					<input
						type="range"
						min={1}
						max={5}
						value={depth}
						onChange={(e) => setDepth(Number(e.target.value))}
						className="w-20"
					/>
					<span className="text-xs text-text-muted w-4">{depth}</span>
				</div>

				<button
					onClick={() => loadGraph(query)}
					disabled={loading || !query.trim()}
					className="px-4 py-2 text-xs bg-accent text-white rounded hover:bg-accent-hover transition-colors disabled:opacity-30 cursor-pointer"
				>
					{loading ? 'loading...' : 'visualize'}
				</button>
			</div>

			<div className="flex flex-1 min-h-0 gap-4">
				<GraphView
					elements={elements}
					layout={mode === 'blast' ? 'concentric' : 'breadthfirst'}
					onNodeClick={handleNodeClick}
					onNodeDoubleClick={handleNodeDoubleClick}
					className="flex-1 border border-border rounded bg-surface-raised"
				/>
				{selected && (
					<div className="w-64 shrink-0 overflow-auto">
						<div className="flex items-center justify-between mb-2">
							<span className="text-xs text-text-muted">selected</span>
							<button
								className="text-xs text-text-muted hover:text-text cursor-pointer"
								onClick={() => setSelected(null)}
							>
								close
							</button>
						</div>
						<SymbolCard symbol={selected} />
					</div>
				)}
			</div>
		</div>
	)
}
