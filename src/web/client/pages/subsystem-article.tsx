import { useLocation, Link } from 'wouter'
import { useMemo } from 'react'
import { GitMerge, Sparkles } from 'lucide-react'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { ArticleShell, ArticleHeader, FactList } from '../components/article-shell.js'
import { Section, Badge, FileLink, KindBadge, SymbolLink, Spinner, EmptyState } from '../ui/index.js'

export function SubsystemArticle() {
	const [location] = useLocation()
	const id = location.startsWith('/sub/') ? decodeURIComponent(location.slice(5)) : null

	const list = useQuery('subsystems', () => api.subsystems())
	const detail = useQuery(id ? `sub:${id}` : null, () => api.subsystem(id!))

	if (!id) return <SubsystemIndex list={list} />
	if (detail.error) return <EmptyState title="subsystem not found" description={detail.error.message} />
	if (!detail.data) return <Spinner lines={6} />

	const s = detail.data

	return (
		<ArticleShell
			header={
				<ArticleHeader
					eyebrow={<Badge>subsystem</Badge>}
					title={s.name}
					subtitle={s.description}
					meta={
						<>
							<span>{s.files.length} files</span>
							<span>conductance {s.conductance.toFixed(2)}</span>
						</>
					}
				/>
			}
			aside={
				<FactList
					items={[
						{ label: 'files', value: s.files.length },
						{ label: 'conductance', value: s.conductance.toFixed(3) },
						{ label: 'entry points', value: s.topExports?.length ?? '—' },
						{ label: 'cross-edges', value: s.crossEdges?.length ?? '—' },
					]}
				/>
			}
		>
			{s.topExports && s.topExports.length > 0 && (
				<Section id="entry-points" title="entry points" right={<span className="flex items-center gap-1"><Sparkles size={11} /> top exports</span>}>
					<ul className="space-y-1">
						{s.topExports.map((sym) => (
							<li key={sym.qualifiedName} className="flex items-center gap-3 py-1.5">
								<SymbolLink name={sym.name} qualifiedName={sym.qualifiedName} kind={sym.kind} />
								<FileLink path={sym.filePath} muted basename />
								<span className="ml-auto text-xs text-text-muted tabular-nums">{sym.dependentCount} dep</span>
							</li>
						))}
					</ul>
				</Section>
			)}

			{s.crossEdges && s.crossEdges.length > 0 && (
				<Section id="cross-edges" title="connects to" right={`${s.crossEdges.length} subsystems`}>
					<ul className="space-y-1">
						{s.crossEdges.map((c) => (
							<li key={c.otherSubsystemId} className="flex items-center gap-3 py-1.5">
								<GitMerge size={12} className="text-text-faint" />
								<Link href={`/sub/${encodeURIComponent(c.otherSubsystemId)}`} className="text-text hover:text-accent text-sm">
									{c.otherSubsystemName}
								</Link>
								<span className="ml-auto text-xs text-text-muted tabular-nums">{c.edgeCount} imports across {c.fileCount} files</span>
							</li>
						))}
					</ul>
				</Section>
			)}

			<Section id="files" title="files" right={`${s.files.length}`} defaultOpen={!(s.topExports && s.topExports.length > 0)}>
				<FilesByDir files={s.files} />
			</Section>

			{s.topSymbols.length > 0 && (
				<Section id="all-exports" title="all exports" right={`${s.topSymbols.length}`} defaultOpen={false}>
					<ul className="space-y-1">
						{s.topSymbols.map((sym, i) => (
							<li key={i} className="flex items-center gap-2 py-1">
								<KindBadge kind={sym.kind} />
								<span className="text-sm font-mono">{sym.name}</span>
								<FileLink path={sym.filePath} muted basename />
							</li>
						))}
					</ul>
				</Section>
			)}
		</ArticleShell>
	)
}

function FilesByDir({ files }: { files: { id: number; path: string }[] }) {
	const grouped = useMemo(() => {
		const m = new Map<string, { path: string }[]>()
		for (const f of files) {
			const parts = f.path.split('/')
			const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.'
			if (!m.has(dir)) m.set(dir, [])
			m.get(dir)!.push(f)
		}
		return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)))
	}, [files])

	return (
		<div className="space-y-4">
			{[...grouped.entries()].map(([dir, ff]) => (
				<div key={dir}>
					<div className="text-[11px] uppercase tracking-wider text-text-faint mb-1.5">{dir}/</div>
					<ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
						{ff.sort((a, b) => a.path.localeCompare(b.path)).map((f) => (
							<li key={f.path} className="py-1">
								<FileLink path={f.path} basename />
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	)
}

function SubsystemIndex({ list }: { list: ReturnType<typeof useQuery<any>> }) {
	if (list.error) return <EmptyState title="failed to load subsystems" description={list.error.message} />
	if (!list.data) return <Spinner lines={4} />
	if (list.data.length === 0) {
		return (
			<EmptyState
				title="no subsystems detected"
				description={<>run <code className="bg-surface-sunken px-1 rounded text-accent font-mono">atlas index</code> to cluster the file graph.</>}
			/>
		)
	}

	return (
		<div>
			<header className="mb-6">
				<h1 className="text-xl font-bold tracking-tight">subsystems</h1>
				<p className="text-sm text-text-muted mt-1">
					louvain clusters of the file graph. each subsystem groups files that depend on each other heavily.
				</p>
			</header>
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
				{list.data.map((s: any) => (
					<Link
						key={s.id}
						href={`/sub/${encodeURIComponent(s.id)}`}
						className="group block border border-border rounded-[var(--radius-default)] p-4 bg-surface-raised hover:bg-surface-hover hover:border-border-strong"
					>
						<div className="text-sm font-semibold text-text group-hover:text-accent mb-1 break-words">{s.name}</div>
						<div className="text-xs text-text-muted mb-2 tabular-nums">
							{s.fileCount} files · conductance {s.conductance.toFixed(2)}
						</div>
						{s.description && <div className="text-xs text-text-muted line-clamp-3">{s.description}</div>}
					</Link>
				))}
			</div>
		</div>
	)
}
