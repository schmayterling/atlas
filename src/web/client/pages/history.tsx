import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import type { ChurnEntry, FileHistoryEntry } from '../lib/api.js'

export function HistoryPage() {
	const [churn, setChurn] = useState<ChurnEntry[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [selected, setSelected] = useState<string | null>(null)
	const [history, setHistory] = useState<FileHistoryEntry[]>([])

	useEffect(() => {
		api.churn({ limit: 100 })
			.then(setChurn)
			.catch((e) => setError(e.message))
			.finally(() => setLoading(false))
	}, [])

	useEffect(() => {
		if (!selected) return
		api.fileHistory(selected).then(setHistory).catch(() => setHistory([]))
	}, [selected])

	if (error) return <div className="text-error text-sm">{error}</div>
	if (loading) return <div className="text-text-muted text-sm">loading...</div>

	return (
		<div className="flex gap-4 h-full">
			<div className="flex-1 min-w-0">
				<h1 className="text-lg font-bold mb-4">git history — hot files</h1>

				{churn.length === 0 && (
					<div className="text-text-muted text-sm">
						no git history ingested. run <code className="text-accent bg-surface px-1 rounded">atlas index</code> in a git repo.
					</div>
				)}

				<table className="w-full text-xs">
					<thead className="text-text-muted border-b border-border">
						<tr>
							<th className="text-left py-2 px-2">commits</th>
							<th className="text-left py-2 px-2">contributors</th>
							<th className="text-left py-2 px-2">last touched</th>
							<th className="text-left py-2 px-2">top author</th>
							<th className="text-left py-2 px-2">file</th>
						</tr>
					</thead>
					<tbody>
						{churn.map((c) => (
							<tr
								key={c.filePath}
								onClick={() => setSelected(c.filePath)}
								className={`cursor-pointer border-b border-border/30 hover:bg-surface-hover ${
									selected === c.filePath ? 'bg-accent/10' : ''
								}`}
							>
								<td className="py-1.5 px-2 font-bold">{c.commits}</td>
								<td className="py-1.5 px-2 text-text-muted">{c.contributors}</td>
								<td className="py-1.5 px-2 text-text-muted">
									{new Date(c.lastTouchedAt).toISOString().slice(0, 10)}
								</td>
								<td className="py-1.5 px-2 text-text-muted">{c.topAuthor}</td>
								<td className="py-1.5 px-2 font-mono">{c.filePath}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{selected && (
				<div className="w-96 shrink-0 border-l border-border pl-4 overflow-auto">
					<div className="flex items-center justify-between mb-3">
						<span className="text-sm font-bold text-accent break-all">{selected}</span>
						<button
							className="text-xs text-text-muted hover:text-text cursor-pointer ml-2"
							onClick={() => setSelected(null)}
						>
							close
						</button>
					</div>
					<div className="text-xs text-text-muted mb-2">{history.length} commits</div>
					<div className="space-y-2">
						{history.map((h) => (
							<div key={h.hash} className="border-l-2 border-border pl-2">
								<div className="text-xs text-text-muted">
									{new Date(h.authoredAt).toISOString().slice(0, 10)} · {h.authorName} ·{' '}
									<span className="font-mono">{h.hash.slice(0, 7)}</span> · {h.status}
								</div>
								<div className="text-xs">{h.subject}</div>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	)
}
