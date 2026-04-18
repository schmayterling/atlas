import { useLocation, Link } from 'wouter'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { ArticleShell, ArticleHeader, FactList } from '../components/article-shell.js'
import { Section, Badge, FileLink, KindBadge, Spinner, EmptyState } from '../ui/index.js'

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
						{ label: 'top symbols', value: s.topSymbols.length },
					]}
				/>
			}
		>
			<Section id="files" title="files" right={`${s.files.length}`}>
				<ul className="space-y-1">
					{s.files.map((f) => (
						<li key={f.id} className="py-1">
							<FileLink path={f.path} />
						</li>
					))}
				</ul>
			</Section>

			{s.topSymbols.length > 0 && (
				<Section id="top-symbols" title="top symbols" right={`${s.topSymbols.length}`}>
					<ul className="space-y-1">
						{s.topSymbols.map((sym, i) => (
							<li key={i} className="flex items-center gap-2 py-1">
								<KindBadge kind={sym.kind} />
								<span className="text-sm font-mono">{sym.name}</span>
							</li>
						))}
					</ul>
				</Section>
			)}
		</ArticleShell>
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
