import { useEffect, useState } from 'react'
import { KindBadge } from '../components/symbol-card.js'

interface DuplicatePair {
	symbolA: any
	symbolB: any
	similarity: number
	confirmed: boolean
	description: string | null
}

export function DuplicatesPage() {
	const [duplicates, setDuplicates] = useState<DuplicatePair[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		fetch('/api/duplicates')
			.then((r) => r.json())
			.then(setDuplicates)
			.catch((e) => setError(e.message))
			.finally(() => setLoading(false))
	}, [])

	if (error) return <div className="text-error text-sm">{error}</div>
	if (loading) return <div className="text-text-muted text-sm">loading...</div>

	return (
		<div>
			<h1 className="text-lg font-bold mb-4">duplicates</h1>

			{duplicates.length === 0 && (
				<div className="text-text-muted text-sm">
					no duplicates detected. run <code className="text-accent bg-surface px-1 rounded">atlas index</code> with embeddings enabled to detect semantically similar code.
				</div>
			)}

			<div className="space-y-3">
				{duplicates.map((d, i) => (
					<div key={i} className="border border-border rounded p-4 bg-surface-raised">
						<div className="flex items-center gap-2 mb-3">
							<span className={`text-sm font-bold ${d.similarity > 0.95 ? 'text-error' : 'text-warning'}`}>
								{(d.similarity * 100).toFixed(0)}% similar
							</span>
							{d.confirmed && <span className="text-[10px] text-success border border-success/30 px-1 rounded">confirmed</span>}
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="border border-border rounded p-2 bg-surface">
								<div className="flex items-center gap-1.5 mb-1">
									<KindBadge kind={d.symbolA.kind} />
									<span className="text-xs font-bold">{d.symbolA.name}</span>
								</div>
								<div className="text-[10px] text-text-muted">{d.symbolA.filePath}:{d.symbolA.lineStart}</div>
							</div>
							<div className="border border-border rounded p-2 bg-surface">
								<div className="flex items-center gap-1.5 mb-1">
									<KindBadge kind={d.symbolB.kind} />
									<span className="text-xs font-bold">{d.symbolB.name}</span>
								</div>
								<div className="text-[10px] text-text-muted">{d.symbolB.filePath}:{d.symbolB.lineStart}</div>
							</div>
						</div>
						{d.description && <div className="text-xs text-text-muted mt-2">{d.description}</div>}
					</div>
				))}
			</div>
		</div>
	)
}
