import { useState } from 'react'
import type { SymbolResult } from '../../../shared/types.js'
import { api } from '../lib/api.js'
import { Sparkles } from 'lucide-react'

const KIND_COLORS: Record<string, string> = {
	function: 'text-blue-400 bg-blue-400/8 border-blue-400/20',
	class: 'text-green-400 bg-green-400/8 border-green-400/20',
	method: 'text-cyan-400 bg-cyan-400/8 border-cyan-400/20',
	interface: 'text-purple-400 bg-purple-400/8 border-purple-400/20',
	type: 'text-amber-400 bg-amber-400/8 border-amber-400/20',
	variable: 'text-pink-400 bg-pink-400/8 border-pink-400/20',
	module: 'text-sky-400 bg-sky-400/8 border-sky-400/20',
	enum: 'text-orange-400 bg-orange-400/8 border-orange-400/20',
	property: 'text-neutral-400 bg-neutral-400/8 border-neutral-400/20',
}

export function KindBadge({ kind }: { kind: string }) {
	const colors = KIND_COLORS[kind] ?? 'text-text-muted bg-surface-hover border-border'
	return (
		<span className={`inline-flex px-1.5 py-[1px] rounded-[6px] text-[10px] font-medium border ${colors}`}>
			{kind}
		</span>
	)
}

export function SymbolCard({ symbol }: { symbol: SymbolResult }) {
	const [summary, setSummary] = useState<string | null>(null)
	const [summarizing, setSummarizing] = useState(false)
	const [summaryError, setSummaryError] = useState<string | null>(null)

	const handleSummarize = async () => {
		setSummarizing(true)
		setSummaryError(null)
		try {
			const result = await api.summarize(symbol.qualifiedName)
			setSummary(result.summary)
		} catch (e: any) {
			setSummaryError(e.message || 'failed to summarize')
		} finally {
			setSummarizing(false)
		}
	}

	return (
		<div className="border border-border rounded-[var(--radius-default)] p-3.5 bg-surface-raised space-y-2">
			<div className="flex items-center gap-2">
				<KindBadge kind={symbol.kind} />
				<span className="text-[13px] font-semibold">{symbol.name}</span>
				{symbol.isExported && (
					<span className="text-[10px] text-accent/70 font-medium">exported</span>
				)}
			</div>
			<div className="text-[11px] text-text-muted font-mono">
				{symbol.filePath}:{symbol.lineStart}
			</div>
			{symbol.signature && (
				<div className="text-[11px] font-mono bg-surface p-2 rounded-[6px] border border-border overflow-x-auto text-text-secondary">
					{symbol.signature}
				</div>
			)}
			{symbol.docComment && (
				<div className="text-[11px] text-text-muted italic">{symbol.docComment}</div>
			)}
			<div className="text-[11px] text-text-muted">
				{symbol.dependentCount} dependent{symbol.dependentCount !== 1 ? 's' : ''}
			</div>

			{!summary && !summarizing && (
				<button
					onClick={handleSummarize}
					className="flex items-center gap-1.5 text-[11px] text-accent/80 hover:text-accent cursor-pointer transition-colors"
				>
					<Sparkles size={12} />
					summarize
				</button>
			)}
			{summarizing && (
				<div className="text-[11px] text-text-muted flex items-center gap-1.5">
					<Sparkles size={12} className="animate-pulse" />
					summarizing...
				</div>
			)}
			{summaryError && (
				<div className="text-[11px] text-error">{summaryError}</div>
			)}
			{summary && (
				<div className="text-[11px] bg-accent/5 p-2.5 rounded-[6px] border border-accent/10 text-text-secondary leading-relaxed">
					{summary}
				</div>
			)}
		</div>
	)
}
