import { Link } from 'wouter'
import { Library, Sparkles, Boxes, GitBranch, Activity, FileText, Clock, Flame, AlertTriangle } from 'lucide-react'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { Spinner, EmptyState, Badge, SymbolLink, FileLink } from '../ui/index.js'

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

function Panel({ icon: Icon, title, action, children }: { icon: any; title: string; action?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section>
			<div className="flex items-center justify-between mb-3">
				<h2 className="text-md font-semibold flex items-center gap-2">
					<Icon size={15} className="text-text-muted" />
					{title}
				</h2>
				{action}
			</div>
			<div className="border border-border rounded-[var(--radius-default)] bg-surface-raised divide-y divide-border">
				{children}
			</div>
		</section>
	)
}

export function HomePage() {
	const status = useQuery('status', () => api.status())
	const subsystems = useQuery('subsystems', () => api.subsystems())
	const entryPoints = useQuery('entry-points', () => api.entryPoints(8))
	const churn = useQuery('home-churn', () => api.churn({ limit: 8, sinceDays: 30 }))
	const dead = useQuery('home-dead', () => api.deadCode())
	const hotFragile = useQuery('home-hotfragile', () => api.hotFragile(5))

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

	const deadExports = dead.data?.symbols.filter((x) => x.isExported).slice(0, 5) ?? []
	const hasAttention = (hotFragile.data && hotFragile.data.length > 0) || deadExports.length > 0

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

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<Panel icon={Sparkles} title="entry points" action={<Link href="/browse" className="text-xs text-text-muted hover:text-accent">browse all →</Link>}>
					{!entryPoints.data ? (
						<div className="p-4"><Spinner lines={4} /></div>
					) : entryPoints.data.length === 0 ? (
						<div className="p-4 text-sm text-text-muted">no exported symbols yet.</div>
					) : (
						entryPoints.data.map((s) => (
							<div key={s.qualifiedName} className="flex items-center gap-3 px-4 py-2.5">
								<SymbolLink name={s.name} qualifiedName={s.qualifiedName} kind={s.kind} />
								<FileLink path={s.filePath} muted basename />
								<span className="ml-auto text-xs text-text-muted tabular-nums">{s.dependentCount} dep</span>
							</div>
						))
					)}
				</Panel>

				<Panel icon={Clock} title="recently changed" action={<span className="text-xs text-text-muted">last 30d</span>}>
					{!churn.data ? (
						<div className="p-4"><Spinner lines={4} /></div>
					) : churn.data.length === 0 ? (
						<div className="p-4 text-sm text-text-muted">no recorded git activity. run <code className="bg-surface-sunken px-1 rounded text-accent font-mono text-xs">atlas index --git</code>.</div>
					) : (
						churn.data.map((c) => (
							<div key={c.filePath} className="flex items-center gap-3 px-4 py-2.5">
								<FileLink path={c.filePath} basename />
								<span className="text-xs text-text-faint truncate">{c.topAuthor}</span>
								<span className="ml-auto text-xs text-text-muted tabular-nums">{c.commits} commits</span>
							</div>
						))
					)}
				</Panel>
			</div>

			{hasAttention && (
				<section>
					<h2 className="text-md font-semibold mb-3 flex items-center gap-2">
						<AlertTriangle size={15} className="text-warning" />
						needs attention
					</h2>
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
						{hotFragile.data && hotFragile.data.length > 0 && (
							<div className="border border-border rounded-[var(--radius-default)] bg-surface-raised">
								<div className="px-4 py-2 border-b border-border flex items-center gap-2 text-xs text-text-muted">
									<Flame size={12} />
									hot &amp; fragile
								</div>
								<div className="divide-y divide-border">
									{hotFragile.data.map((row) => (
										<div key={row.filePath} className="flex items-center gap-3 px-4 py-2.5">
											<FileLink path={row.filePath} basename />
											<span className="ml-auto text-xs text-text-muted tabular-nums">{row.commits} × {row.untestedCount} untested</span>
										</div>
									))}
								</div>
							</div>
						)}
						{deadExports.length > 0 && (
							<div className="border border-border rounded-[var(--radius-default)] bg-surface-raised">
								<div className="px-4 py-2 border-b border-border flex items-center gap-2 text-xs text-text-muted">
									<Sparkles size={12} />
									unused exports
								</div>
								<div className="divide-y divide-border">
									{deadExports.map((s) => (
										<div key={s.qualifiedName} className="flex items-center gap-3 px-4 py-2.5">
											<SymbolLink name={s.name} qualifiedName={s.qualifiedName} kind={s.kind} />
											<FileLink path={s.filePath} muted basename />
										</div>
									))}
								</div>
							</div>
						)}
					</div>
				</section>
			)}

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
