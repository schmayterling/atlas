import { useEffect, useState } from 'react'
import type { DeadCodeResult } from '../../../shared/types.js'
import { api } from '../lib/api.js'
import { KindBadge } from '../components/symbol-card.js'

export function DeadCodePage() {
	const [result, setResult] = useState<DeadCodeResult | null>(null)
	const [kindFilter, setKindFilter] = useState('')
	const [pathFilter, setPathFilter] = useState('')
	const [loading, setLoading] = useState(true)

	useEffect(() => {
		setLoading(true)
		api.deadCode({
			kind: kindFilter || undefined,
			path: pathFilter || undefined,
		})
			.then(setResult)
			.finally(() => setLoading(false))
	}, [kindFilter, pathFilter])

	return (
		<div>
			<h1 className="text-lg font-bold mb-4">dead code</h1>

			<div className="flex gap-3 mb-4">
				<select
					value={kindFilter}
					onChange={(e) => setKindFilter(e.target.value)}
					className="bg-surface border border-border rounded px-3 py-2 text-xs text-text"
				>
					<option value="">all kinds</option>
					{['function', 'class', 'method', 'interface', 'type', 'enum'].map((k) => (
						<option key={k} value={k}>{k}</option>
					))}
				</select>
				<input
					type="text"
					value={pathFilter}
					onChange={(e) => setPathFilter(e.target.value)}
					placeholder="filter by path..."
					className="flex-1 bg-surface border border-border rounded px-3 py-2 text-xs text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
				/>
			</div>

			{loading && <div className="text-xs text-text-muted">loading...</div>}

			{result && (
				<>
					<div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
						<div className="border border-border rounded p-3 bg-surface-raised">
							<div className="text-xs text-text-muted">total</div>
							<div className="text-xl font-bold">{result.stats.total}</div>
						</div>
						{Object.entries(result.stats.byKind).map(([kind, count]) => (
							<div key={kind} className="border border-border rounded p-3 bg-surface-raised">
								<div className="text-xs text-text-muted">{kind}</div>
								<div className="text-lg font-bold">{count}</div>
							</div>
						))}
					</div>

					<div className="space-y-0.5">
						{result.symbols.map((sym) => (
							<div
								key={sym.qualifiedName}
								className="flex items-center gap-3 px-3 py-2 rounded hover:bg-surface-hover transition-colors"
							>
								<KindBadge kind={sym.kind} />
								<span className="text-sm font-bold">{sym.name}</span>
								<span className="text-xs text-text-muted ml-auto">{sym.filePath}:{sym.lineStart}-{sym.lineEnd}</span>
							</div>
						))}
					</div>

					{result.symbols.length === 0 && (
						<div className="text-text-muted text-sm">no dead code found</div>
					)}
				</>
			)}
		</div>
	)
}
