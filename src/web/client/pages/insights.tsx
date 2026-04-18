import { useMemo, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { Trash2, Copy, Flame, Crosshair } from 'lucide-react'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { SymbolLink, FileLink, Badge, Spinner, EmptyState } from '../ui/index.js'

const TABS = [
	{ id: 'dead', label: 'dead code', icon: Trash2 },
	{ id: 'duplicates', label: 'duplicates', icon: Copy },
	{ id: 'hotfragile', label: 'hot & fragile', icon: Flame },
	{ id: 'hotspots', label: 'hotspots', icon: Crosshair },
]

function topDirs(paths: string[], max = 8): string[] {
	const counts = new Map<string, number>()
	for (const p of paths) {
		const parts = p.split('/')
		const top = parts.length > 1 ? parts[0] : '.'
		counts.set(top, (counts.get(top) ?? 0) + 1)
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map((x) => x[0])
}

export function InsightsPage() {
	const [tab, setTab] = useState('dead')
	const [dirFilter, setDirFilter] = useState<string | null>(null)

	return (
		<div>
			<header className="mb-6">
				<h1 className="text-xl font-bold tracking-tight">insights</h1>
				<p className="text-sm text-text-muted mt-1">
					things worth your attention: unused exports, near-duplicates, fragile hotspots, and risk-scored entry points.
				</p>
			</header>

			<Tabs.Root value={tab} onValueChange={setTab}>
				<Tabs.List className="flex border-b border-border mb-6">
					{TABS.map((t) => {
						const I = t.icon
						return (
							<Tabs.Trigger
								key={t.id}
								value={t.id}
								className="flex items-center gap-2 px-4 py-2.5 text-sm text-text-muted hover:text-text data-[state=active]:text-accent data-[state=active]:border-b-2 data-[state=active]:border-accent -mb-px cursor-pointer"
							>
								<I size={13} />
								{t.label}
							</Tabs.Trigger>
						)
					})}
				</Tabs.List>

				<Tabs.Content value="dead"><DeadCodeTab dirFilter={dirFilter} onDirs={setDirFilter} dirFilterValue={dirFilter} /></Tabs.Content>
				<Tabs.Content value="duplicates"><DuplicatesTab dirFilter={dirFilter} onDirs={setDirFilter} dirFilterValue={dirFilter} /></Tabs.Content>
				<Tabs.Content value="hotfragile"><HotFragileTab dirFilter={dirFilter} onDirs={setDirFilter} dirFilterValue={dirFilter} /></Tabs.Content>
				<Tabs.Content value="hotspots"><HotspotsTab dirFilter={dirFilter} onDirs={setDirFilter} dirFilterValue={dirFilter} /></Tabs.Content>
			</Tabs.Root>
		</div>
	)
}

function FilterChips({
	dirs,
	value,
	onChange,
}: { dirs: string[]; value: string | null; onChange: (v: string | null) => void }) {
	if (dirs.length <= 1) return null
	return (
		<div className="flex items-center gap-1.5 mb-4 flex-wrap">
			<span className="text-xs text-text-faint mr-1">filter:</span>
			<button
				onClick={() => onChange(null)}
				className={`text-xs px-2 py-1 rounded-full border cursor-pointer ${value === null ? 'bg-accent-soft text-accent border-accent/30' : 'border-border text-text-muted hover:text-text'}`}
			>
				all
			</button>
			{dirs.map((d) => (
				<button
					key={d}
					onClick={() => onChange(d)}
					className={`text-xs px-2 py-1 rounded-full border cursor-pointer font-mono ${value === d ? 'bg-accent-soft text-accent border-accent/30' : 'border-border text-text-muted hover:text-text'}`}
				>
					{d}/
				</button>
			))}
		</div>
	)
}

type TabProps = { dirFilter: string | null; onDirs: (v: string | null) => void; dirFilterValue: string | null }

function DeadCodeTab({ dirFilter, onDirs }: TabProps) {
	const q = useQuery('insights:dead', () => api.deadCode())
	const dirs = useMemo(() => (q.data ? topDirs(q.data.symbols.map((s) => s.filePath)) : []), [q.data])
	const filtered = useMemo(
		() => (q.data ? q.data.symbols.filter((s) => !dirFilter || s.filePath.startsWith(`${dirFilter}/`)) : []),
		[q.data, dirFilter],
	)

	if (q.error) return <EmptyState title="failed" description={q.error.message} />
	if (!q.data) return <Spinner lines={5} />
	if (q.data.symbols.length === 0) return <EmptyState title="no dead code detected" />

	return (
		<div>
			<FilterChips dirs={dirs} value={dirFilter} onChange={onDirs} />
			<div className="border border-border rounded-[var(--radius-default)] bg-surface-raised divide-y divide-border">
				{filtered.slice(0, 100).map((s) => (
					<div key={s.qualifiedName} className="flex items-center gap-3 px-4 py-2.5">
						<SymbolLink name={s.name} qualifiedName={s.qualifiedName} kind={s.kind} />
						{s.isExported && <Badge tone="warning">exported</Badge>}
						<FileLink path={s.filePath} line={s.lineStart} muted />
					</div>
				))}
			</div>
		</div>
	)
}

function DuplicatesTab({ dirFilter, onDirs }: TabProps) {
	const q = useQuery('insights:dups', () => api.duplicates())
	const dirs = useMemo(
		() => (q.data ? topDirs(q.data.flatMap((p) => [p.symbolA.filePath, p.symbolB.filePath])) : []),
		[q.data],
	)
	const filtered = useMemo(
		() => (q.data ? q.data.filter((p) => !dirFilter || p.symbolA.filePath.startsWith(`${dirFilter}/`) || p.symbolB.filePath.startsWith(`${dirFilter}/`)) : []),
		[q.data, dirFilter],
	)

	if (q.error) return <EmptyState title="failed" description={q.error.message} />
	if (!q.data) return <Spinner lines={5} />
	if (q.data.length === 0) return <EmptyState title="no near-duplicates detected" />

	return (
		<div>
			<FilterChips dirs={dirs} value={dirFilter} onChange={onDirs} />
			<div className="space-y-3">
				{filtered.slice(0, 50).map((p, i) => (
					<div key={i} className="border border-border rounded-[var(--radius-default)] bg-surface-raised p-4">
						<div className="text-xs text-text-muted mb-2 tabular-nums">similarity {(p.similarity * 100).toFixed(0)}%</div>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							<div className="space-y-1">
								<SymbolLink name={p.symbolA.name} qualifiedName={p.symbolA.qualifiedName} kind={p.symbolA.kind} />
								<FileLink path={p.symbolA.filePath} line={p.symbolA.lineStart} muted />
							</div>
							<div className="space-y-1">
								<SymbolLink name={p.symbolB.name} qualifiedName={p.symbolB.qualifiedName} kind={p.symbolB.kind} />
								<FileLink path={p.symbolB.filePath} line={p.symbolB.lineStart} muted />
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	)
}

function HotFragileTab({ dirFilter, onDirs }: TabProps) {
	const q = useQuery('insights:hotfragile', () => api.hotFragile(60))
	const dirs = useMemo(() => (q.data ? topDirs(q.data.map((r) => r.filePath)) : []), [q.data])
	const filtered = useMemo(
		() => (q.data ? q.data.filter((r) => !dirFilter || r.filePath.startsWith(`${dirFilter}/`)) : []),
		[q.data, dirFilter],
	)

	if (q.error) return <EmptyState title="hot-fragile not available" description={q.error.message} />
	if (!q.data) return <Spinner lines={5} />
	if (q.data.length === 0) return <EmptyState title="no fragile hotspots" />

	return (
		<div>
			<FilterChips dirs={dirs} value={dirFilter} onChange={onDirs} />
			<div className="border border-border rounded-[var(--radius-default)] bg-surface-raised divide-y divide-border">
				{filtered.map((row) => (
					<div key={row.filePath} className="flex items-center gap-3 px-4 py-2.5">
						<FileLink path={row.filePath} />
						<div className="flex-1" />
						<span className="text-xs text-text-muted tabular-nums">{row.commits} × {row.untestedCount} untested</span>
						<Badge tone={row.fragilityScore > 50 ? 'error' : row.fragilityScore > 20 ? 'warning' : 'neutral'}>{row.fragilityScore.toFixed(0)}</Badge>
					</div>
				))}
			</div>
		</div>
	)
}

function HotspotsTab({ dirFilter, onDirs }: TabProps) {
	const q = useQuery('insights:hotspots', () => api.hotspots(50))
	const dirs = useMemo(() => (q.data ? topDirs(q.data.map((r) => r.filePath)) : []), [q.data])
	const filtered = useMemo(
		() => (q.data ? q.data.filter((r) => !dirFilter || r.filePath.startsWith(`${dirFilter}/`)) : []),
		[q.data, dirFilter],
	)

	if (q.error) return <EmptyState title="hotspots not available" description={q.error.message} />
	if (!q.data) return <Spinner lines={5} />
	if (q.data.length === 0) return <EmptyState title="no hotspots scored" description="hotspots require git history. run atlas index --git." />

	return (
		<div>
			<p className="text-sm text-text-muted mb-3">
				exported functions/methods scored by <span className="font-mono">fanin × churn × (1 - coverage)</span>. high score = expensive to break.
			</p>
			<FilterChips dirs={dirs} value={dirFilter} onChange={onDirs} />
			<div className="border border-border rounded-[var(--radius-default)] bg-surface-raised divide-y divide-border">
				{filtered.map((row) => (
					<div key={row.qualifiedName} className="flex items-center gap-3 px-4 py-2.5">
						<SymbolLink name={row.name} qualifiedName={row.qualifiedName} kind={row.kind} />
						<FileLink path={row.filePath} line={row.lineStart} muted basename />
						<div className="flex-1" />
						<span className="text-xs text-text-muted tabular-nums">{row.fanin} fanin · {row.commits} commits</span>
						<Badge tone={row.coverage === 'called' ? 'success' : row.coverage === 'imported' ? 'warning' : 'error'}>{row.coverage}</Badge>
						<Badge tone={row.score > 100 ? 'error' : row.score > 30 ? 'warning' : 'neutral'}>{row.score.toFixed(0)}</Badge>
					</div>
				))}
			</div>
		</div>
	)
}
