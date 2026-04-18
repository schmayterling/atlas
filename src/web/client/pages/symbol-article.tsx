import { useLocation, Link } from 'wouter'
import { ExternalLink, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { ArticleShell, ArticleHeader, FactList } from '../components/article-shell.js'
import {
	Section, KindBadge, Badge, SymbolLink, FileLink, CodeBlock, Spinner, EmptyState, Button,
} from '../ui/index.js'

export function SymbolArticle() {
	const [location] = useLocation()
	const qn = location.startsWith('/s/') ? decodeURIComponent(location.slice(3)) : null

	const detail = useQuery(qn ? `symbol:${qn}` : null, () => api.symbolDetail(qn!))

	if (!qn) return <EmptyState title="no symbol" />
	if (detail.error) return <EmptyState title="symbol not found" description={detail.error.message} />
	if (!detail.data) return <Spinner lines={6} />

	const { symbol, summary, upstream, downstream, sourceCode } = detail.data

	return (
		<ArticleShell
			header={
				<ArticleHeader
					eyebrow={
						<>
							<KindBadge kind={symbol.kind} />
							<FileLink path={symbol.filePath} line={symbol.lineStart} />
							{symbol.isExported && <Badge tone="accent">exported</Badge>}
						</>
					}
					title={<span className="font-mono">{symbol.name}</span>}
					subtitle={symbol.signature ? <code className="text-sm bg-surface-sunken px-2 py-1 rounded">{symbol.signature}</code> : undefined}
				/>
			}
			aside={<SymbolFacts qn={qn} symbol={symbol} upstream={upstream} downstream={downstream} />}
		>
			<SummarySection qn={qn} initial={summary} />

			{symbol.docComment && (
				<Section id="docs" title="documentation">
					<div className="prose">{symbol.docComment}</div>
				</Section>
			)}

			{sourceCode && (
				<Section id="source" title="source" defaultOpen>
					<HighlightedSource code={sourceCode} language={langForFile(symbol.filePath)} />
				</Section>
			)}

			{downstream.length > 0 && (
				<Section id="calls" title="calls" right={`${downstream.length}`}>
					<DepList items={downstream} />
				</Section>
			)}

			{upstream.length > 0 && (
				<Section id="called-by" title="called by" right={`${upstream.length}`}>
					<DepList items={upstream} />
				</Section>
			)}

			{upstream.length === 0 && downstream.length === 0 && (
				<Section id="empty" title="connections" collapsible={false}>
					<div className="text-sm text-text-muted">no incoming or outgoing edges recorded.</div>
				</Section>
			)}
		</ArticleShell>
	)
}

function langForFile(path: string): string {
	if (path.endsWith('.tsx')) return 'tsx'
	if (path.endsWith('.ts')) return 'typescript'
	if (path.endsWith('.jsx')) return 'jsx'
	if (path.endsWith('.js')) return 'javascript'
	if (path.endsWith('.py')) return 'python'
	return 'typescript'
}

// renders raw source as fallback. shiki rendering happens server-side and
// will be served via an article endpoint in phase 3; for phase 1 we send
// raw and let the browser render it monospaced.
function HighlightedSource({ code, language }: { code: string; language: string }) {
	return <CodeBlock code={code} language={language} maxHeight={520} />
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

function SymbolFacts({ qn, symbol, upstream, downstream }: { qn: string; symbol: any; upstream: any[]; downstream: any[] }) {
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
