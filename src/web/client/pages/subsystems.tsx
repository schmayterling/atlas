import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import type { SubsystemDetail, SubsystemSummary } from '../../../shared/types.js'

export function SubsystemsPage() {
	const [subs, setSubs] = useState<SubsystemSummary[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [selected, setSelected] = useState<SubsystemDetail | null>(null)

	useEffect(() => {
		api.subsystems()
			.then(setSubs)
			.catch((e) => setError(e.message))
			.finally(() => setLoading(false))
	}, [])

	if (error) return <div className="text-error text-sm">{error}</div>
	if (loading) return <div className="text-text-muted text-sm">loading...</div>

	return (
		<div className="flex gap-4 h-full">
			<div className="flex-1 min-w-0">
				<h1 className="text-lg font-bold mb-4">subsystems</h1>

				{subs.length === 0 && (
					<div className="text-text-muted text-sm">
						no subsystems detected. run <code className="text-accent bg-surface px-1 rounded">atlas index</code> to cluster the file graph.
					</div>
				)}

				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
					{subs.map((s) => (
						<button
							key={s.id}
							onClick={() => api.subsystem(s.id).then(setSelected)}
							className={`text-left border border-border rounded p-3 bg-surface-raised hover:bg-surface-hover cursor-pointer ${
								selected?.id === s.id ? 'ring-1 ring-accent' : ''
							}`}
						>
							<div className="text-sm font-bold mb-1 break-all">{s.name}</div>
							<div className="text-xs text-text-muted">
								{s.fileCount} files · conductance {s.conductance.toFixed(2)}
							</div>
							{s.description && (
								<div className="text-xs text-text-muted mt-2 line-clamp-3">{s.description}</div>
							)}
						</button>
					))}
				</div>
			</div>

			{selected && (
				<div className="w-96 shrink-0 border-l border-border pl-4 overflow-auto">
					<div className="flex items-center justify-between mb-3">
						<span className="text-sm font-bold text-accent break-all">{selected.name}</span>
						<button
							className="text-xs text-text-muted hover:text-text cursor-pointer ml-2"
							onClick={() => setSelected(null)}
						>
							close
						</button>
					</div>
					{selected.description && (
						<div className="text-xs text-text-muted mb-3">{selected.description}</div>
					)}
					<div className="text-xs text-text-muted mb-3">
						conductance {selected.conductance.toFixed(2)} · {selected.files.length} files
					</div>
					<div className="text-xs font-bold mb-1">files</div>
					<div className="space-y-0.5 mb-4">
						{selected.files.map((f) => (
							<div key={f.id} className="text-[10px] font-mono text-text-muted">
								{f.path}
							</div>
						))}
					</div>
					{selected.topSymbols.length > 0 && (
						<>
							<div className="text-xs font-bold mb-1">top symbols</div>
							<div className="space-y-0.5">
								{selected.topSymbols.map((s, i) => (
									<div key={i} className="text-[10px]">
										<span className="text-text-muted">{s.kind}</span>{' '}
										<span className="font-bold">{s.name}</span>
									</div>
								))}
							</div>
						</>
					)}
				</div>
			)}
		</div>
	)
}
