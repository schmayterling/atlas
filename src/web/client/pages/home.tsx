import { Link } from 'wouter'
import { Library, Sparkles, Boxes, GitBranch, Activity, FileText } from 'lucide-react'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { Spinner, EmptyState, Badge } from '../ui/index.js'

function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
	return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function timeAgo(ts: number | null | undefined): string {
	if (!ts) return 'never'
	const d = Date.now() - ts
	if (d < 60_000) return 'just now'
	if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`
	if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`
	return `${Math.floor(d / 86400_000)}d ago`
}

const HEALTH_TONES: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
	good: 'success', stale: 'warning', outdated: 'error', missing: 'error',
}

function Stat({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="border border-border rounded-[var(--radius-default)] p-4 bg-surface-raised">
			<div className="text-xs text-text-muted mb-1">{label}</div>
			<div className="text-lg font-semibold text-text tabular-nums">{value}</div>
		</div>
	)
}

function QuickLink({ href, icon: Icon, title, desc }: { href: string; icon: any; title: string; desc: string }) {
	return (
		<Link
			href={href}
			className="block group border border-border rounded-[var(--radius-default)] p-4 bg-surface-raised hover:bg-surface-hover hover:border-border-strong"
		>
			<div className="flex items-center gap-2 mb-1">
				<Icon size={15} className="text-accent" strokeWidth={2} />
				<div className="text-sm font-semibold text-text group-hover:text-accent">{title}</div>
			</div>
			<div className="text-xs text-text-muted">{desc}</div>
		</Link>
	)
}

export function HomePage() {
	const status = useQuery('status', () => api.status())
	const subsystems = useQuery('subsystems', () => api.subsystems())

	if (status.error) return <div className="text-error">{status.error.message}</div>
	if (!status.data) return <Spinner lines={5} />

	const s = status.data

	if (s.stats.files === 0) {
		return (
			<EmptyState
				icon={<FileText size={32} />}
				title="no files indexed yet"
				description={<>run <code className="bg-surface-sunken px-1 py-[1px] rounded text-accent font-mono">atlas index</code> in your project root to get started.</>}
			/>
		)
	}

	return (
		<div className="space-y-10">
			<section>
				<div className="flex items-end justify-between flex-wrap gap-3 mb-4">
					<div>
						<h1 className="text-xl font-bold tracking-tight">overview</h1>
						<p className="text-sm text-text-muted mt-1">
							a structural map of your codebase, indexed and searchable.
						</p>
					</div>
					<div className="flex items-center gap-2 text-xs text-text-muted">
						<Badge tone={HEALTH_TONES[s.health] ?? 'neutral'}>{s.health}</Badge>
						<span>indexed {timeAgo(s.lastIndexedAt)}</span>
						{s.lastBranch && <span>· {s.lastBranch}</span>}
					</div>
				</div>

				<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
					<Stat label="files" value={s.stats.files.toLocaleString()} />
					<Stat label="symbols" value={s.stats.symbols.toLocaleString()} />
					<Stat label="edges" value={s.stats.edges.toLocaleString()} />
					<Stat label="db size" value={formatBytes(s.dbSizeBytes)} />
				</div>
			</section>

			<section>
				<h2 className="text-md font-semibold mb-3">jump in</h2>
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
					<QuickLink href="/browse" icon={Library} title="browse" desc="files and symbols by directory" />
					<QuickLink href="/sub" icon={Boxes} title="subsystems" desc={`${subsystems.data?.length ?? '...'} clusters detected`} />
					<QuickLink href="/insights" icon={Sparkles} title="insights" desc="dead code, duplicates, hotspots" />
					<QuickLink href="/graph" icon={GitBranch} title="graph" desc="visualize dependencies" />
				</div>
			</section>

			<section>
				<h2 className="text-md font-semibold mb-3 flex items-center gap-2">
					<Activity size={15} className="text-text-muted" />
					languages
				</h2>
				<div className="grid grid-cols-2 md:grid-cols-3 gap-2">
					{Object.entries(s.languages).map(([lang, count]) => (
						<div key={lang} className="flex justify-between items-baseline border border-border rounded-[var(--radius-default)] px-3 py-2 bg-surface-raised">
							<span className="text-sm text-text capitalize">{lang}</span>
							<span className="text-xs text-text-muted tabular-nums">{count.toLocaleString()}</span>
						</div>
					))}
				</div>
			</section>
		</div>
	)
}
