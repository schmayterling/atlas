import { useLocation, Link } from 'wouter'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { ArticleShell, ArticleHeader, FactList } from '../components/article-shell.js'
import { Section, Badge, SymbolLink, Spinner, EmptyState } from '../ui/index.js'

export function FileArticle() {
	const [location] = useLocation()
	const path = location.startsWith('/f/')
		? location.slice(3).split('/').map(decodeURIComponent).join('/')
		: null

	const symbols = useQuery(path ? `file:${path}` : null, () => api.fileSymbols(path!))
	const meta = useQuery(path ? `file-meta:${path}` : null, async () => {
		const r = await fetch(`/api/wiki?file=${encodeURIComponent(path!)}`)
		if (!r.ok) throw new Error('failed to load file metadata')
		return r.json() as Promise<{ summary: string | null }>
	})
	const contributors = useQuery(path ? `file-contribs:${path}` : null, () => api.contributors(path!))
	const history = useQuery(path ? `file-hist:${path}` : null, () => api.fileHistory(path!))

	if (!path) return <EmptyState title="no file" />
	if (symbols.error) return <EmptyState title="file not found" description={symbols.error.message} />
	if (!symbols.data) return <Spinner lines={6} />

	const exported = symbols.data.filter((s) => s.isExported)
	const internal = symbols.data.filter((s) => !s.isExported)
	const dir = path.split('/').slice(0, -1).join('/')
	const name = path.split('/').pop() ?? path

	return (
		<ArticleShell
			header={
				<ArticleHeader
					eyebrow={
						<>
							<Badge>file</Badge>
							{dir && <Link href="/browse" className="hover:text-text">{dir}/</Link>}
						</>
					}
					title={<span className="font-mono">{name}</span>}
					subtitle={meta.data?.summary ? <span className="text-text-secondary">{meta.data.summary}</span> : undefined}
					meta={
						<>
							<span>{symbols.data.length} symbols</span>
							{exported.length > 0 && <span>{exported.length} exported</span>}
						</>
					}
				/>
			}
			aside={
				<FactList
					items={[
						{ label: 'path', value: <span className="font-mono text-xs break-all">{path}</span> },
						{ label: 'symbols', value: symbols.data.length },
						{ label: 'exported', value: exported.length },
						{
							label: 'contributors',
							value: contributors.data?.length ?? '—',
						},
						{
							label: 'commits (recorded)',
							value: history.data?.length ?? '—',
						},
					]}
				/>
			}
		>
			{exported.length > 0 && (
				<Section id="exports" title="exports" right={`${exported.length}`}>
					<SymbolList symbols={exported} />
				</Section>
			)}

			{internal.length > 0 && (
				<Section id="internal" title="internal" right={`${internal.length}`} defaultOpen={exported.length === 0}>
					<SymbolList symbols={internal} muted />
				</Section>
			)}

			{contributors.data && contributors.data.length > 0 && (
				<Section id="contributors" title="contributors" right={`${contributors.data.length}`}>
					<ul className="space-y-1">
						{contributors.data.slice(0, 10).map((c) => (
							<li key={c.authorEmail} className="flex items-center justify-between text-sm py-1">
								<span className="text-text">{c.authorName}</span>
								<span className="text-xs text-text-muted tabular-nums">{c.commits} commits</span>
							</li>
						))}
					</ul>
				</Section>
			)}

			{history.data && history.data.length > 0 && (
				<Section id="history" title="recent commits">
					<ul className="space-y-2">
						{history.data.slice(0, 10).map((h) => (
							<li key={h.hash} className="flex items-baseline gap-3 text-sm border-b border-border pb-2 last:border-b-0">
								<span className="font-mono text-xs text-text-faint">{h.hash.slice(0, 7)}</span>
								<span className="flex-1 text-text-secondary truncate">{h.subject}</span>
								<span className="text-xs text-text-muted">{h.authorName}</span>
							</li>
						))}
					</ul>
				</Section>
			)}
		</ArticleShell>
	)
}

function SymbolList({ symbols, muted = false }: { symbols: any[]; muted?: boolean }) {
	return (
		<ul className="space-y-1">
			{symbols.map((s) => (
				<li key={s.qualifiedName} className="flex items-center gap-3 py-1.5 px-2 -mx-2 rounded-[var(--radius-sm)] hover:bg-surface-hover">
					<SymbolLink name={s.name} qualifiedName={s.qualifiedName} kind={s.kind} muted={muted} />
					{s.signature && <span className="text-xs text-text-muted truncate font-mono">{s.signature}</span>}
					<span className="text-xs text-text-faint ml-auto tabular-nums">L{s.lineStart}</span>
				</li>
			))}
		</ul>
	)
}
