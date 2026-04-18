import { useLocation, Link } from 'wouter'
import { ExternalLink, Sparkles, Beaker, Clock, Users, Boxes } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { ArticleShell, ArticleHeader, FactList } from '../components/article-shell.js'
import {
	Section, KindBadge, Badge, SymbolLink, FileLink, CodeBlock, Spinner, EmptyState, Button,
} from '../ui/index.js'

function timeAgo(ts: number | null | undefined): string {
	if (!ts) return ''
	const d = Date.now() - ts
	if (d < 60_000) return 'just now'
	if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`
	if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`
	return `${Math.floor(d / 86400_000)}d ago`
}

export function SymbolArticle() {
	const [location] = useLocation()
	const qn = location.startsWith('/s/') ? decodeURIComponent(location.slice(3)) : null

	const article = useQuery(qn ? `article:${qn}` : null, () => api.symbolArticle(qn!))

	if (!qn) return <EmptyState title="no symbol" />
	if (article.error) return <EmptyState title="symbol not found" description={article.error.message} />
	if (!article.data) return <Spinner lines={6} />

	const a = article.data
	const { symbol } = a

	return (
		<ArticleShell
			header={
				<ArticleHeader
					eyebrow={
						<>
							<KindBadge kind={symbol.kind} />
							<FileLink path={symbol.filePath} line={symbol.lineStart} />
							{symbol.isExported && <Badge tone="accent">exported</Badge>}
							{a.subsystem && (
								<Link href={`/sub/${encodeURIComponent(a.subsystem.id)}`} className="text-text-muted hover:text-accent inline-flex items-center gap-1">
									<Boxes size={11} /> {a.subsystem.name}
								</Link>
							)}
						</>
					}
					title={<span className="font-mono">{symbol.name}</span>}
					subtitle={symbol.signature ? <code className="text-sm bg-surface-sunken px-2 py-1 rounded">{symbol.signature}</code> : undefined}
				/>
			}
			aside={<SymbolFacts qn={qn} article={a} />}
		>
			<SummarySection qn={qn} initial={a.summary ?? undefined} />

			{symbol.docComment && (
				<Section id="docs" title="documentation">
					<div className="prose">{symbol.docComment}</div>
				</Section>
			)}

			{(a.sourceHtml || a.sourceCode) && (
				<Section id="source" title="source" right={`${symbol.lineEnd - symbol.lineStart + 1} lines`}>
					<CodeBlock html={a.sourceHtml ?? undefined} code={a.sourceCode ?? undefined} language={a.language} maxHeight={520} />
				</Section>
			)}

			{a.downstream.length > 0 && (
				<Section id="calls" title="calls" right={`${a.downstream.length}`}>
					<DepList items={a.downstream} />
				</Section>
			)}

			{a.upstream.length > 0 && (
				<Section id="called-by" title="called by" right={`${a.upstream.length}`}>
					<DepList items={a.upstream} />
				</Section>
			)}

			{a.testCoverage && a.testCoverage.tests.length > 0 && (
				<Section id="tests" title="tests" right={a.testCoverage.coveredBy}>
					<ul className="space-y-1">
						{a.testCoverage.tests.map((t, i) => (
							<li key={i} className="flex items-center gap-2 py-1">
								<Beaker size={12} className="text-text-muted" />
								<FileLink path={t.testFilePath} muted />
								<Badge tone={t.confidence === 'called' ? 'success' : 'neutral'}>{t.confidence}</Badge>
							</li>
						))}
					</ul>
				</Section>
			)}

			{(a.lastChanged || a.contributors.length > 0) && (
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
						<div>
							<div className="flex items-center gap-1.5 text-xs text-text-muted mb-2">
								<Users size={12} /> top contributors to this file
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
				</Section>
			)}

			{a.upstream.length === 0 && a.downstream.length === 0 && (
				<Section id="empty" title="connections" collapsible={false}>
					<div className="text-sm text-text-muted">no incoming or outgoing edges recorded.</div>
				</Section>
			)}
		</ArticleShell>
	)
}

function DepList({ items }: { items: { symbol: any; edgeKind: string; line?: number | null }[] }) {
	return (
		<ul className="space-y-1">
			{items.map((d, i) => (
				<li key={`${d.symbol.qualifiedName}-${i}`} className="flex items-center gap-2 py-1">
					<SymbolLink name={d.symbol.name} qualifiedName={d.symbol.qualifiedName} kind={d.symbol.kind} />
					<Badge>{d.edgeKind}</Badge>
					<span className="text-xs text-text-muted ml-auto truncate font-mono">
						{d.symbol.filePath}{d.symbol.lineStart ? `:${d.symbol.lineStart}` : ''}
					</span>
				</li>
			))}
		</ul>
	)
}

function SummarySection({ qn, initial }: { qn: string; initial?: string }) {
	const [summary, setSummary] = useState<string | null>(initial ?? null)
	const [loading, setLoading] = useState(false)
	const [err, setErr] = useState<string | null>(null)

	const generate = async () => {
		setLoading(true); setErr(null)
		try {
			const r = await api.summarize(qn)
			setSummary(r.summary)
		} catch (e: any) {
			setErr(e.message || 'failed')
		} finally { setLoading(false) }
	}

	if (summary) {
		return (
			<Section id="summary" title="summary" right={<span className="flex items-center gap-1"><Sparkles size={11} /> llm</span>}>
				<div className="prose">{summary}</div>
			</Section>
		)
	}

	return (
		<Section id="summary" title="summary" collapsible={false}>
			<div className="flex items-center gap-3">
				<Button size="sm" variant="secondary" onClick={generate} disabled={loading}>
					<Sparkles size={12} />
					{loading ? 'summarizing...' : 'generate summary'}
				</Button>
				{err && <span className="text-xs text-error">{err}</span>}
			</div>
		</Section>
	)
}

function SymbolFacts({ qn, article }: { qn: string; article: any }) {
	const { symbol, upstream, downstream, subsystem, testCoverage } = article
	return (
		<FactList
			items={[
				{ label: 'kind', value: <KindBadge kind={symbol.kind} /> },
				{ label: 'file', value: <FileLink path={symbol.filePath} line={symbol.lineStart} /> },
				{ label: 'lines', value: <span className="font-mono text-xs">{symbol.lineStart}-{symbol.lineEnd}</span> },
				{ label: 'visibility', value: symbol.isExported ? 'exported' : 'internal' },
				{ label: 'callers', value: <span className="tabular-nums">{upstream.length}</span> },
				{ label: 'callees', value: <span className="tabular-nums">{downstream.length}</span> },
				{
					label: 'tests',
					value: testCoverage
						? <span className="tabular-nums">{testCoverage.tests.length} ({testCoverage.coveredBy})</span>
						: <span className="text-text-faint">none</span>,
				},
				{
					label: 'subsystem',
					value: subsystem
						? <Link href={`/sub/${encodeURIComponent(subsystem.id)}`} className="text-accent hover:underline">{subsystem.name}</Link>
						: <span className="text-text-faint">—</span>,
				},
				{
					label: 'graph',
					value: (
						<Link href={`/graph?focus=${encodeURIComponent(qn)}`} className="inline-flex items-center gap-1 text-accent hover:underline text-xs">
							open in graph view <ExternalLink size={11} />
						</Link>
					),
				},
			]}
		/>
	)
}
