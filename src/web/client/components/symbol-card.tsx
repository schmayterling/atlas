import type { SymbolResult } from '../../../shared/types.js'

const KIND_COLORS: Record<string, string> = {
	function: 'text-indigo-400 bg-indigo-400/10 border-indigo-400/30',
	class: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30',
	method: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/30',
	interface: 'text-violet-400 bg-violet-400/10 border-violet-400/30',
	type: 'text-amber-400 bg-amber-400/10 border-amber-400/30',
	variable: 'text-rose-400 bg-rose-400/10 border-rose-400/30',
	module: 'text-sky-400 bg-sky-400/10 border-sky-400/30',
	enum: 'text-orange-400 bg-orange-400/10 border-orange-400/30',
	property: 'text-gray-400 bg-gray-400/10 border-gray-400/30',
}

export function KindBadge({ kind }: { kind: string }) {
	const colors = KIND_COLORS[kind] ?? 'text-text-muted bg-surface-hover border-border'
	return (
		<span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] border ${colors}`}>
			{kind}
		</span>
	)
}

export function SymbolCard({ symbol, compact }: { symbol: SymbolResult; compact?: boolean }) {
	if (compact) {
		return (
			<div className="flex items-center gap-2 text-sm">
				<KindBadge kind={symbol.kind} />
				<span className="font-bold">{symbol.name}</span>
				<span className="text-text-muted text-xs">{symbol.filePath}:{symbol.lineStart}</span>
				{symbol.isExported && <span className="text-accent text-[10px]">exported</span>}
			</div>
		)
	}

	return (
		<div className="border border-border rounded p-4 bg-surface-raised space-y-2">
			<div className="flex items-center gap-2">
				<KindBadge kind={symbol.kind} />
				<span className="font-bold">{symbol.name}</span>
				{symbol.isExported && <span className="text-accent text-[10px] border border-accent/30 px-1 rounded">exported</span>}
			</div>
			<div className="text-xs text-text-muted">{symbol.filePath}:{symbol.lineStart}-{symbol.lineEnd}</div>
			{symbol.signature && (
				<div className="text-xs font-mono bg-surface p-2 rounded border border-border overflow-x-auto">
					{symbol.signature}
				</div>
			)}
			{symbol.docComment && (
				<div className="text-xs text-text-muted italic">{symbol.docComment}</div>
			)}
			<div className="flex gap-4 text-xs text-text-muted">
				<span>usages: {symbol.usageCount}</span>
				<span>dependents: {symbol.dependentCount}</span>
			</div>
		</div>
	)
}
