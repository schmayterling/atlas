import { useEffect, useState, useCallback } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { SymbolResult, SearchResult, SymbolDetail } from '../../../shared/types.js'
import { api } from '../lib/api.js'
import { SearchInput } from '../components/search-input.js'
import { SymbolCard, KindBadge } from '../components/symbol-card.js'

const SYMBOL_KINDS = [
	'all',
	'function',
	'class',
	'method',
	'interface',
	'type',
	'variable',
	'module',
	'enum',
	'property',
]

export function SearchPage() {
	const [query, setQuery] = useState('')
	const [kind, setKind] = useState('all')
	const [results, setResults] = useState<SymbolResult[]>([])
	const [total, setTotal] = useState(0)
	const [selected, setSelected] = useState<SymbolDetail | null>(null)
	const [loading, setLoading] = useState(false)

	const doSearch = useCallback(async (q: string, k: string) => {
		if (!q.trim()) {
			setResults([])
			setTotal(0)
			return
		}
		setLoading(true)
		try {
			const result = (await api.search(q, {
				kind: k === 'all' ? undefined : k,
				limit: 50,
			})) as SearchResult
			setResults(result.results)
			setTotal(result.total)
		} catch {
			setResults([])
			setTotal(0)
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		doSearch(query, kind)
	}, [query, kind, doSearch])

	const handleSelect = async (sym: SymbolResult) => {
		try {
			const detail = await api.symbolDetail(sym.qualifiedName)
			setSelected(detail)
		} catch {
			setSelected(null)
		}
	}

	return (
		<div className="flex gap-4 h-full">
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-3 mb-4">
					<h1 className="text-lg font-bold">search</h1>
					{total > 0 && <span className="text-xs text-text-muted">{total} results</span>}
				</div>

				<div className="flex gap-2 mb-4">
					<div className="flex-1">
						<SearchInput value={query} onChange={setQuery} />
					</div>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger className="px-3 py-2 border border-border rounded text-xs bg-surface-raised text-text-muted hover:text-text transition-colors cursor-pointer">
							{kind === 'all' ? 'all kinds' : kind}
						</DropdownMenu.Trigger>
						<DropdownMenu.Portal>
							<DropdownMenu.Content className="bg-surface-raised border border-border rounded p-1 min-w-[120px] z-50">
								{SYMBOL_KINDS.map((k) => (
									<DropdownMenu.Item
										key={k}
										className="text-xs px-3 py-1.5 rounded cursor-pointer text-text-muted hover:text-text hover:bg-surface-hover outline-none"
										onSelect={() => setKind(k)}
									>
										{k}
									</DropdownMenu.Item>
								))}
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>
				</div>

				{loading && <div className="text-xs text-text-muted">searching...</div>}

				<div className="space-y-0.5">
					{results.map((sym) => (
						<button
							key={sym.qualifiedName}
							className="w-full text-left px-3 py-2 rounded hover:bg-surface-hover transition-colors cursor-pointer flex items-center gap-3"
							onClick={() => handleSelect(sym)}
						>
							<KindBadge kind={sym.kind} />
							<span className="text-sm font-bold truncate">{sym.name}</span>
							<span className="text-xs text-text-muted truncate ml-auto">
								{sym.filePath}:{sym.lineStart}
							</span>
							{sym.isExported && <span className="text-[10px] text-accent">exp</span>}
						</button>
					))}
				</div>

				{!loading && query && results.length === 0 && (
					<div className="text-xs text-text-muted mt-4">no results for "{query}"</div>
				)}
			</div>

			{selected && (
				<div className="w-80 shrink-0 border-l border-border pl-4 overflow-auto">
					<div className="flex items-center justify-between mb-3">
						<span className="text-xs text-text-muted">detail</span>
						<button
							className="text-xs text-text-muted hover:text-text cursor-pointer"
							onClick={() => setSelected(null)}
						>
							close
						</button>
					</div>
					<SymbolCard symbol={selected.symbol} />
					{selected.sourceCode && (
						<div className="mt-3">
							<div className="text-xs text-text-muted mb-1">source</div>
							<pre className="text-xs bg-surface p-3 rounded border border-border overflow-x-auto max-h-60 overflow-y-auto">
								<code>{selected.sourceCode}</code>
							</pre>
						</div>
					)}
					{selected.upstream.length > 0 && (
						<div className="mt-3">
							<div className="text-xs text-text-muted mb-1">
								depends on ({selected.upstream.length})
							</div>
							<div className="space-y-1">
								{selected.upstream.map((dep) => (
									<div key={dep.symbol.qualifiedName} className="text-xs flex items-center gap-1.5">
										<KindBadge kind={dep.symbol.kind} />
										<span>{dep.symbol.name}</span>
										<span className="text-text-muted">({dep.edgeKind})</span>
									</div>
								))}
							</div>
						</div>
					)}
					{selected.downstream.length > 0 && (
						<div className="mt-3">
							<div className="text-xs text-text-muted mb-1">
								depended on by ({selected.downstream.length})
							</div>
							<div className="space-y-1">
								{selected.downstream.map((dep) => (
									<div key={dep.symbol.qualifiedName} className="text-xs flex items-center gap-1.5">
										<KindBadge kind={dep.symbol.kind} />
										<span>{dep.symbol.name}</span>
										<span className="text-text-muted">({dep.edgeKind})</span>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	)
}
