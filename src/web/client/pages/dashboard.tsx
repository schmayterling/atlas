import { useEffect, useState } from 'react'
import type { StatusResult } from '../../../shared/types.js'
import { api } from '../lib/api.js'

function StatCard({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="border border-border rounded p-4 bg-surface-raised">
			<div className="text-xs text-text-muted mb-1">{label}</div>
			<div className="text-xl font-bold">{value}</div>
		</div>
	)
}

function HealthBadge({ health }: { health: string }) {
	const colors: Record<string, string> = {
		good: 'text-success border-success/30 bg-success/10',
		stale: 'text-warning border-warning/30 bg-warning/10',
		outdated: 'text-error border-error/30 bg-error/10',
		missing: 'text-error border-error/30 bg-error/10',
	}
	return (
		<span className={`inline-flex px-2 py-0.5 rounded text-xs border ${colors[health] ?? 'text-text-muted border-border'}`}>
			{health}
		</span>
	)
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(ts: number): string {
	const d = new Date(ts)
	const ago = Date.now() - ts
	if (ago < 60_000) return 'just now'
	if (ago < 3600_000) return `${Math.floor(ago / 60_000)}m ago`
	if (ago < 86400_000) return `${Math.floor(ago / 3600_000)}h ago`
	return d.toLocaleDateString()
}

export function DashboardPage() {
	const [status, setStatus] = useState<StatusResult | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		api.status().then(setStatus).catch((e) => setError(e.message))
	}, [])

	if (error) return <div className="text-error text-sm">{error}</div>
	if (!status) return <div className="text-text-muted text-sm">loading...</div>

	return (
		<div>
			<div className="flex items-center gap-3 mb-6">
				<h1 className="text-lg font-bold">dashboard</h1>
				<HealthBadge health={status.health} />
			</div>

			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
				<StatCard label="files" value={status.stats.files} />
				<StatCard label="symbols" value={status.stats.symbols} />
				<StatCard label="edges" value={status.stats.edges} />
				<StatCard label="db size" value={formatBytes(status.dbSizeBytes)} />
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
				<div className="border border-border rounded p-4 bg-surface-raised">
					<div className="text-xs text-text-muted mb-3">languages</div>
					{Object.entries(status.languages).map(([lang, count]) => (
						<div key={lang} className="flex justify-between text-sm mb-1">
							<span>{lang}</span>
							<span className="text-text-muted">{count} files</span>
						</div>
					))}
				</div>

				<div className="border border-border rounded p-4 bg-surface-raised">
					<div className="text-xs text-text-muted mb-3">index info</div>
					<div className="space-y-2 text-sm">
						<div className="flex justify-between">
							<span className="text-text-muted">last indexed</span>
							<span>{status.lastIndexedAt ? formatTime(status.lastIndexedAt) : 'never'}</span>
						</div>
						<div className="flex justify-between">
							<span className="text-text-muted">branch</span>
							<span>{status.lastBranch ?? 'unknown'}</span>
						</div>
						<div className="flex justify-between">
							<span className="text-text-muted">commit</span>
							<span className="font-mono text-xs">{status.lastCommit?.substring(0, 8) ?? 'unknown'}</span>
						</div>
						<div className="flex justify-between">
							<span className="text-text-muted">references</span>
							<span>{status.stats.references}</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}
