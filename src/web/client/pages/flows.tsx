import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { KindBadge } from '../components/symbol-card.js'

interface Flow {
	id: number
	name: string
	description: string | null
	rootSymbol: any | null
	symbols: any[]
	generatedAt: number
}

export function FlowsPage() {
	const [flows, setFlows] = useState<Flow[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [selected, setSelected] = useState<Flow | null>(null)

	useEffect(() => {
		fetch('/api/flows')
			.then((r) => r.json())
			.then(setFlows)
			.catch((e) => setError(e.message))
			.finally(() => setLoading(false))
	}, [])

	if (error) return <div className="text-error text-sm">{error}</div>
	if (loading) return <div className="text-text-muted text-sm">loading...</div>

	return (
		<div className="flex gap-4 h-full">
			<div className="flex-1 min-w-0">
				<h1 className="text-lg font-bold mb-4">flows</h1>

				{flows.length === 0 && (
					<div className="text-text-muted text-sm">
						no flows detected. run <code className="text-accent bg-surface px-1 rounded">atlas index</code> to detect execution flows.
					</div>
				)}

				<div className="space-y-1">
					{flows.map((f) => (
						<button
							key={f.id}
							onClick={() => setSelected(f)}
							className={`w-full text-left px-3 py-2 rounded transition-colors cursor-pointer flex items-center gap-3 ${
								selected?.id === f.id ? 'bg-accent/10 text-accent' : 'hover:bg-surface-hover'
							}`}
						>
							<span className="text-sm font-bold">{f.name}</span>
							<span className="text-xs text-text-muted">{f.symbols.length} symbols</span>
							{f.description && <span className="text-xs text-text-muted truncate ml-auto">{f.description}</span>}
						</button>
					))}
				</div>
			</div>

			{selected && (
				<div className="w-80 shrink-0 border-l border-border pl-4 overflow-auto">
					<div className="flex items-center justify-between mb-3">
						<span className="text-sm font-bold text-accent">{selected.name}</span>
						<button className="text-xs text-text-muted hover:text-text cursor-pointer" onClick={() => setSelected(null)}>close</button>
					</div>
					{selected.description && (
						<div className="text-xs text-text-muted mb-3">{selected.description}</div>
					)}
					<div className="text-xs text-text-muted mb-2">{selected.symbols.length} symbols in flow</div>
					<div className="space-y-0">
						{selected.symbols.map((sym, i) => (
							<div key={sym.qualifiedName}>
								<div className="flex items-center gap-2 py-1.5">
									<div className="w-5 text-center text-[10px] text-text-muted">{i + 1}</div>
									<KindBadge kind={sym.kind} />
									<span className="text-xs font-bold">{sym.name}</span>
								</div>
								<div className="text-[10px] text-text-muted pl-7">{sym.filePath}:{sym.lineStart}</div>
								{i < selected.symbols.length - 1 && (
									<div className="pl-7 py-0.5 text-text-muted text-[10px]">↓</div>
								)}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	)
}
