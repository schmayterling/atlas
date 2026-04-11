import { useState, useCallback } from 'react'
import type { FlowTraceResult, FlowPath } from '../../../shared/types.js'
import { api } from '../lib/api.js'
import { SearchInput } from '../components/search-input.js'
import { KindBadge } from '../components/symbol-card.js'

export function TracePage() {
	const [from, setFrom] = useState('')
	const [to, setTo] = useState('')
	const [maxPaths, setMaxPaths] = useState(5)
	const [result, setResult] = useState<FlowTraceResult | null>(null)
	const [selectedPath, setSelectedPath] = useState<number>(0)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState('')

	const doTrace = useCallback(async () => {
		if (!from.trim() || !to.trim()) return
		setLoading(true)
		setError('')
		try {
			const r = await api.trace(from, to, { maxPaths })
			setResult(r)
			setSelectedPath(0)
		} catch (e: any) {
			setError(e.message || 'error tracing')
			setResult(null)
		} finally {
			setLoading(false)
		}
	}, [from, to, maxPaths])

	return (
		<div>
			<h1 className="text-lg font-bold mb-4">trace</h1>

			<div className="flex gap-3 mb-4 items-end flex-wrap">
				<div className="flex-1 min-w-[150px]">
					<label className="text-xs text-text-muted mb-1 block">from</label>
					<SearchInput value={from} onChange={setFrom} placeholder="source symbol..." debounceMs={0} />
				</div>
				<span className="text-text-muted text-sm pb-2">→</span>
				<div className="flex-1 min-w-[150px]">
					<label className="text-xs text-text-muted mb-1 block">to</label>
					<SearchInput value={to} onChange={setTo} placeholder="target symbol..." debounceMs={0} />
				</div>
				<div className="flex items-center gap-2">
					<label className="text-xs text-text-muted">paths</label>
					<input type="range" min={1} max={10} value={maxPaths} onChange={(e) => setMaxPaths(Number(e.target.value))} className="w-16" />
					<span className="text-xs text-text-muted w-4">{maxPaths}</span>
				</div>
				<button
					onClick={doTrace}
					disabled={loading || !from.trim() || !to.trim()}
					className="px-4 py-2 text-xs bg-accent text-white rounded hover:bg-accent-hover transition-colors disabled:opacity-30 cursor-pointer"
				>
					{loading ? 'tracing...' : 'trace'}
				</button>
			</div>

			{error && <div className="text-error text-xs mb-4">{error}</div>}

			{result && (
				<div>
					<div className="text-xs text-text-muted mb-3">
						{result.stats.totalPaths} path{result.stats.totalPaths !== 1 ? 's' : ''} found
						{result.stats.truncated && ' (truncated)'}
					</div>

					{result.paths.length === 0 && (
						<div className="text-text-muted text-sm">no paths found between these symbols</div>
					)}

					{result.paths.length > 1 && (
						<div className="flex gap-1 mb-3">
							{result.paths.map((_, i) => (
								<button
									key={i}
									onClick={() => setSelectedPath(i)}
									className={`px-2 py-1 text-xs rounded cursor-pointer ${
										selectedPath === i ? 'bg-accent text-white' : 'bg-surface-raised text-text-muted hover:text-text border border-border'
									}`}
								>
									path {i + 1}
								</button>
							))}
						</div>
					)}

					{result.paths[selectedPath] && (
						<PathView path={result.paths[selectedPath]} />
					)}
				</div>
			)}
		</div>
	)
}

function PathView({ path }: { path: FlowPath }) {
	return (
		<div className="border border-border rounded bg-surface-raised p-4">
			<div className="text-xs text-text-muted mb-3">{path.length} hop{path.length !== 1 ? 's' : ''}</div>
			<div className="space-y-0">
				{path.nodes.map((node, i) => (
					<div key={node.qualifiedName}>
						<div className="flex items-center gap-2 py-2">
							<div className="w-6 text-center text-xs text-text-muted">{i + 1}</div>
							<KindBadge kind={node.kind} />
							<span className="text-sm font-bold">{node.name}</span>
							<span className="text-xs text-text-muted">{node.filePath}:{node.lineStart}</span>
						</div>
						{i < path.edges.length && (
							<div className="flex items-center gap-2 py-1 pl-8">
								<span className="text-text-muted text-xs">↓</span>
								<span className="text-xs text-accent">{path.edges[i].kind}</span>
								{path.edges[i].line && (
									<span className="text-xs text-text-muted">line {path.edges[i].line}</span>
								)}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	)
}
