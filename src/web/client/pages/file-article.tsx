import { useLocation, Link } from 'wouter'
import { Clock, Users, GitMerge, ArrowRight, ArrowLeft } from 'lucide-react'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { ArticleShell, ArticleHeader, FactList } from '../components/article-shell.js'
import { Section, Badge, SymbolLink, FileLink, Spinner, EmptyState } from '../ui/index.js'

function timeAgo(ts: number | null | undefined): string {
	if (!ts) return ''
	const d = Date.now() - ts
	if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`
	return `${Math.floor(d / 86400_000)}d ago`
}

function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
	return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export function FileArticle() {
	const [location] = useLocation()
	const path = location.startsWith('/f/')
		? location.slice(3).split('/').map(decodeURIComponent).join('/')
		: null

	const article = useQuery(path ? `file:${path}` : null, () => api.fileArticle(path!))

	if (!path) return <EmptyState title="no file" />
	if (article.error) return <EmptyState title="file not found" description={article.error.message} />
	if (!article.data) return <Spinner lines={6} />

	const a = article.data
	const exported = a.symbols.filter((s) => s.isExported)
	const internal = a.symbols.filter((s) => !s.isExported)
	const dir = path.split('/').slice(0, -1).join('/')
	const name = path.split('/').pop() ?? path

	return (
		<ArticleShell
			header={
				<ArticleHeader
					eyebrow={
						<>
							<Badge>file</Badge>
							{a.isTest && <Badge tone="warning">test</Badge>}
							<span className="text-text-muted font-mono">{a.language}</span>
							{dir && <Link href="/browse" className="hover:text-text">{dir}/</Link>}
						</>
					}
					title={<span className="font-mono">{name}</span>}
					subtitle={a.summary ? <span className="text-text-secondary">{a.summary}</span> : <FileSummaryPrompt path={path} />}
					meta={
						<>
							<span>{a.symbols.length} symbols</span>
							{exported.length > 0 && <span>{exported.length} exported</span>}
							<span>{formatBytes(a.sizeBytes)}</span>
						</>
					}
				/>
			}
			aside={
				<FactList
					items={[
						{ label: 'path', value: <span className="font-mono text-xs break-all">{path}</span> },
						{ label: 'language', value: a.language },
						{ label: 'symbols', value: a.symbols.length },
						{ label: 'exported', value: exported.length },
						{ label: 'imports', value: a.imports.length },
						{ label: 'imported by', value: a.importers.length },
						{ label: 'contributors', value: a.contributors.length || '—' },
						{ label: 'size', value: formatBytes(a.sizeBytes) },
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

			{a.imports.length > 0 && (
				<Section id="imports" title="imports" right={`${a.imports.length}`} defaultOpen={false}>
					<ul className="space-y-1">
						{a.imports.map((imp, i) => (
							<li key={i} className="flex items-center gap-2 py-1 text-sm">
								<ArrowRight size={12} className="text-text-faint" />
								<FileLink path={imp.targetPath} />
								<span className="text-xs text-text-muted font-mono truncate">"{imp.importPath}"</span>
								{imp.isTypeOnly && <Badge>type</Badge>}
								<span className="text-xs text-text-faint ml-auto tabular-nums">L{imp.line}</span>
							</li>
						))}
					</ul>
				</Section>
			)}

			{a.importers.length > 0 && (
				<Section id="importers" title="imported by" right={`${a.importers.length}`} defaultOpen={false}>
					<ul className="space-y-1">
						{a.importers.map((imp, i) => (
							<li key={i} className="flex items-center gap-2 py-1 text-sm">
								<ArrowLeft size={12} className="text-text-faint" />
								<FileLink path={imp.sourcePath} />
								<span className="text-xs text-text-muted font-mono truncate">"{imp.importPath}"</span>
								<span className="text-xs text-text-faint ml-auto tabular-nums">L{imp.line}</span>
							</li>
						))}
					</ul>
				</Section>
			)}

			{a.monthlyChurn.some((m) => m.count > 0) && (
				<Section id="churn" title="churn" right="last 12 months">
					<ChurnBars data={a.monthlyChurn} />
				</Section>
			)}

			{a.coChanged.length > 0 && (
				<Section id="co-changed" title="frequently co-changed">
					<ul className="space-y-1">
						{a.coChanged.map((c) => (
							<li key={c.otherPath} className="flex items-center gap-3 py-1">
								<GitMerge size={12} className="text-text-muted" />
								<FileLink path={c.otherPath} />
								<span className="ml-auto text-xs text-text-muted tabular-nums">{c.count} co-commits</span>
							</li>
						))}
					</ul>
				</Section>
			)}

			{(a.contributors.length > 0 || a.recentCommits.length > 0) && (
				<Section id="history" title="history">
					{a.lastChanged && (
						<div className="flex items-center gap-2 mb-3 text-sm">
							<Clock size={13} className="text-text-muted" />
							<span className="text-text-secondary">{a.lastChanged.subject}</span>
							<span className="text-text-muted text-xs">— {a.lastChanged.authorName}, {timeAgo(a.lastChanged.authoredAt)}</span>
							<span className="text-text-faint text-xs font-mono ml-auto">{a.lastChanged.hash.slice(0, 7)}</span>
						</div>
					)}
					{a.contributors.length > 0 && (
						<div className="mb-4">
							<div className="flex items-center gap-1.5 text-xs text-text-muted mb-2">
								<Users size={12} /> contributors
							</div>
							<ul className="space-y-1">
								{a.contributors.map((c) => (
									<li key={c.authorName} className="flex items-center justify-between text-sm py-1">
										<span className="text-text">{c.authorName}</span>
										<span className="text-xs text-text-muted tabular-nums">{c.commits} commits</span>
									</li>
								))}
							</ul>
						</div>
					)}
					{a.recentCommits.length > 0 && (
						<>
							<div className="text-xs text-text-muted mb-2">recent commits</div>
							<ul className="space-y-2">
								{a.recentCommits.map((h) => (
									<li key={h.hash} className="flex items-baseline gap-3 text-sm border-b border-border pb-2 last:border-b-0">
										<span className="font-mono text-xs text-text-faint">{h.hash.slice(0, 7)}</span>
										<span className="flex-1 text-text-secondary truncate">{h.subject}</span>
										<span className="text-xs text-text-muted">{h.authorName}</span>
									</li>
								))}
							</ul>
						</>
					)}
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

function ChurnBars({ data }: { data: { month: string; count: number }[] }) {
	const max = Math.max(1, ...data.map((d) => d.count))
	return (
		<div className="flex items-end gap-1 h-24">
			{data.map((d) => {
				const h = (d.count / max) * 100
				return (
					<div key={d.month} className="flex-1 flex flex-col items-center justify-end group" title={`${d.month}: ${d.count} commits`}>
						<div
							className="w-full rounded-t bg-accent/30 hover:bg-accent transition-colors"
							style={{ height: `${Math.max(h, 2)}%` }}
						/>
						<div className="text-[9px] text-text-faint mt-1 font-mono">{d.month.slice(5)}</div>
					</div>
				)
			})}
		</div>
	)
}

function FileSummaryPrompt({ path }: { path: string }) {
	void path
	return (
		<span className="text-text-muted text-sm">
			no file summary available. file summaries are generated during indexing when an LLM model is configured.
		</span>
	)
}
