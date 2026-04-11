import { useEffect, useState } from 'react'
import type { StatusResult } from '../../../shared/types.js'
import { api } from '../lib/api.js'
import { Activity, File, Box, GitBranch, Database, Clock, GitCommit, Layers } from 'lucide-react'

function StatCard({ label, value, icon: Icon }: { label: string; value: string | number; icon: any }) {
	return (
		<div className="border border-border rounded-[var(--radius-default)] p-3.5 bg-surface-raised">
			<div className="flex items-center gap-2 mb-1.5">
				<Icon size={13} className="text-text-muted" strokeWidth={1.8} />
				<span className="text-[11px] text-text-muted">{label}</span>
			</div>
			<div className="text-xl font-semibold">{value}</div>
		</div>
	)
}

function HealthBadge({ health }: { health: string }) {
	const styles: Record<string, string> = {
		good: 'text-success bg-success/8',
		stale: 'text-warning bg-warning/8',
		outdated: 'text-error bg-error/8',
		missing: 'text-error bg-error/8',
	}
	return (
		<span className={`inline-flex items-center gap-1 px-2 py-[2px] rounded-full text-[11px] font-medium ${styles[health] ?? 'text-text-muted bg-surface-hover'}`}>
			<span className="w-1.5 h-1.5 rounded-full bg-current" />
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
	const ago = Date.now() - ts
	if (ago < 60_000) return 'just now'
	if (ago < 3600_000) return `${Math.floor(ago / 60_000)}m ago`
	if (ago < 86400_000) return `${Math.floor(ago / 3600_000)}h ago`
	return new Date(ts).toLocaleDateString()
}

export function DashboardPage() {
	const [status, setStatus] = useState<StatusResult | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		api.status().then(setStatus).catch((e) => setError(e.message))
	}, [])

	if (error) return <div className="text-error text-[13px]">{error}</div>
	if (!status) return <div className="text-text-muted text-[13px]">loading...</div>

	return (
		<div>
			<div className="flex items-center gap-3 mb-5">
				<h1 className="text-base font-semibold">dashboard</h1>
				<HealthBadge health={status.health} />
			</div>

			{status.stats.files === 0 && (
				<div className="border border-border rounded-[var(--radius-default)] p-4 bg-surface-raised mb-5 text-[13px] text-text-secondary">
					no files indexed yet. run <code className="text-accent bg-surface px-1 rounded-[4px] font-mono text-[12px]">atlas index</code> to get started.
				</div>
			)}

			<div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-5">
				<StatCard label="files" value={status.stats.files} icon={File} />
				<StatCard label="symbols" value={status.stats.symbols} icon={Box} />
				<StatCard label="edges" value={status.stats.edges} icon={GitBranch} />
				<StatCard label="db size" value={formatBytes(status.dbSizeBytes)} icon={Database} />
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
				<div className="border border-border rounded-[var(--radius-default)] p-3.5 bg-surface-raised">
					<div className="text-[11px] text-text-muted mb-2.5 flex items-center gap-1.5">
						<Layers size={13} strokeWidth={1.8} />
						languages
					</div>
					{Object.entries(status.languages).map(([lang, count]) => (
						<div key={lang} className="flex justify-between text-[13px] mb-1">
							<span className="text-text-secondary">{lang}</span>
							<span className="text-text-muted">{count}</span>
						</div>
					))}
				</div>

				<div className="border border-border rounded-[var(--radius-default)] p-3.5 bg-surface-raised">
					<div className="text-[11px] text-text-muted mb-2.5 flex items-center gap-1.5">
						<Activity size={13} strokeWidth={1.8} />
						index info
					</div>
					<div className="space-y-1.5 text-[13px]">
						<div className="flex justify-between">
							<span className="text-text-muted flex items-center gap-1.5"><Clock size={12} /> indexed</span>
							<span className="text-text-secondary">{status.lastIndexedAt ? formatTime(status.lastIndexedAt) : 'never'}</span>
						</div>
						<div className="flex justify-between">
							<span className="text-text-muted flex items-center gap-1.5"><GitBranch size={12} /> branch</span>
							<span className="text-text-secondary">{status.lastBranch ?? 'unknown'}</span>
						</div>
						<div className="flex justify-between">
							<span className="text-text-muted flex items-center gap-1.5"><GitCommit size={12} /> commit</span>
							<span className="font-mono text-[11px] text-text-secondary">{status.lastCommit?.substring(0, 8) ?? 'unknown'}</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}
