import { useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { Trash2, Copy, Flame } from 'lucide-react'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { SymbolLink, FileLink, Badge, Spinner, EmptyState } from '../ui/index.js'

const TABS = [
	{ id: 'dead', label: 'dead code', icon: Trash2 },
	{ id: 'duplicates', label: 'duplicates', icon: Copy },
	{ id: 'hotfragile', label: 'hot & fragile', icon: Flame },
]

export function InsightsPage() {
	const [tab, setTab] = useState('dead')

	return (
		<div>
			<header className="mb-6">
				<h1 className="text-xl font-bold tracking-tight">insights</h1>
				<p className="text-sm text-text-muted mt-1">
					things worth your attention: unused exports, near-duplicates, and high-churn files with low test coverage.
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

				<Tabs.Content value="dead"><DeadCodeTab /></Tabs.Content>
				<Tabs.Content value="duplicates"><DuplicatesTab /></Tabs.Content>
				<Tabs.Content value="hotfragile"><HotFragileTab /></Tabs.Content>
			</Tabs.Root>
		</div>
	)
}

function DeadCodeTab() {
	const q = useQuery('insights:dead', () => api.deadCode())
	if (q.error) return <EmptyState title="failed" description={q.error.message} />
	if (!q.data) return <Spinner lines={5} />
	if (q.data.symbols.length === 0) return <EmptyState title="no dead code detected" />

	return (
		<div className="border border-border rounded-[var(--radius-default)] bg-surface-raised divide-y divide-border">
			{q.data.symbols.slice(0, 100).map((s) => (
				<div key={s.qualifiedName} className="flex items-center gap-3 px-4 py-2.5">
					<SymbolLink name={s.name} qualifiedName={s.qualifiedName} kind={s.kind} />
					{s.isExported && <Badge tone="warning">exported</Badge>}
					<FileLink path={s.filePath} line={s.lineStart} muted />
				</div>
			))}
		</div>
	)
}

function DuplicatesTab() {
	const q = useQuery('insights:dups', () => api.duplicates())
	if (q.error) return <EmptyState title="failed" description={q.error.message} />
	if (!q.data) return <Spinner lines={5} />
	if (q.data.length === 0) return <EmptyState title="no near-duplicates detected" />

	return (
		<div className="space-y-3">
			{q.data.slice(0, 50).map((p, i) => (
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
	)
}

function HotFragileTab() {
	const q = useQuery('insights:hotfragile', async () => {
		const r = await fetch('/api/hot-fragile?limit=30')
		if (!r.ok) throw new Error('hot-fragile not available')
		return r.json() as Promise<any[]>
	})
	if (q.error) return <EmptyState title="hot-fragile not available" description={q.error.message} />
	if (!q.data) return <Spinner lines={5} />
	if (q.data.length === 0) return <EmptyState title="no fragile hotspots" />

	return (
		<div className="border border-border rounded-[var(--radius-default)] bg-surface-raised divide-y divide-border">
			{q.data.map((row, i) => (
				<div key={i} className="flex items-center gap-3 px-4 py-2.5">
					<FileLink path={row.filePath ?? row.file ?? row.path} />
					<div className="flex-1" />
					<span className="text-xs text-text-muted tabular-nums">{row.commits ?? '—'} commits</span>
					<span className="text-xs text-text-muted tabular-nums">{row.untested ?? row.untestedSymbols ?? '—'} untested</span>
				</div>
			))}
		</div>
	)
}
