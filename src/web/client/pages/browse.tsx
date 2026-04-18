import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { FileInfo, SymbolResult } from '../../../shared/types.js'
import { api } from '../lib/api.js'
import { useQuery } from '../lib/query.js'
import { SymbolLink, FileLink, Spinner, EmptyState, Kbd } from '../ui/index.js'

// browse: unified search + tree. types in the box → fuzzy symbol search;
// empty box → directory tree of files. clicking a file shows its
// exported symbols inline.

export function BrowsePage() {
	const [q, setQ] = useState('')
	const files = useQuery('files', () => api.files())
	const search = useQuery(q.trim() ? `search:${q}` : null, () => api.search(q.trim(), { limit: 40 }))

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
				e.preventDefault();
				(document.getElementById('browse-input') as HTMLInputElement | null)?.focus()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	return (
		<div>
			<header className="mb-6">
				<h1 className="text-xl font-bold tracking-tight">browse</h1>
				<p className="text-sm text-text-muted mt-1">find symbols by name or pick a file from the tree.</p>
			</header>

			<div className="relative mb-6">
				<Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
				<input
					id="browse-input"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="search symbols..."
					className="w-full h-11 pl-10 pr-16 rounded-[var(--radius-default)] border border-border bg-surface-raised text-base text-text placeholder:text-text-faint focus-ring focus:border-accent"
				/>
				<div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-faint">
					<Kbd>/</Kbd>
				</div>
			</div>

			{q.trim() ? <SearchResults search={search} /> : <FileTree files={files} />}
		</div>
	)
}

function SearchResults({ search }: { search: ReturnType<typeof useQuery<any>> }) {
	if (search.error) return <EmptyState title="search failed" description={search.error.message} />
	if (!search.data) return <Spinner lines={5} />
	const results = search.data.results as SymbolResult[]
	if (results.length === 0) return <div className="text-sm text-text-muted">no matches.</div>

	return (
		<div className="border border-border rounded-[var(--radius-default)] bg-surface-raised divide-y divide-border">
			{results.map((s) => (
				<div key={s.qualifiedName} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover">
					<SymbolLink name={s.name} qualifiedName={s.qualifiedName} kind={s.kind} />
					{s.signature && <span className="text-xs text-text-muted truncate font-mono flex-1">{s.signature}</span>}
					<FileLink path={s.filePath} line={s.lineStart} muted />
				</div>
			))}
		</div>
	)
}

function FileTree({ files }: { files: ReturnType<typeof useQuery<FileInfo[]>> }) {
	const [filter, setFilter] = useState('')

	const grouped = useMemo(() => {
		if (!files.data) return new Map<string, FileInfo[]>()
		const visible = filter
			? files.data.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()))
			: files.data
		const m = new Map<string, FileInfo[]>()
		for (const f of visible) {
			const parts = f.path.split('/')
			const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.'
			if (!m.has(dir)) m.set(dir, [])
			m.get(dir)!.push(f)
		}
		return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)))
	}, [files.data, filter])

	if (files.error) return <EmptyState title="failed to load files" description={files.error.message} />
	if (!files.data) return <Spinner lines={5} />

	return (
		<div>
			<input
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				placeholder="filter files by path..."
				className="w-full h-9 px-3 mb-4 rounded-[var(--radius-default)] border border-border bg-surface-raised text-sm focus-ring focus:border-accent"
			/>
			<div className="space-y-5">
				{[...grouped.entries()].map(([dir, dirFiles]) => (
					<div key={dir}>
						<div className="text-[11px] uppercase tracking-wider text-text-faint mb-1.5">{dir}/</div>
						<ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
							{dirFiles
								.sort((a, b) => a.path.localeCompare(b.path))
								.map((f) => (
									<li key={f.path} className="flex items-center justify-between py-1 hover:bg-surface-hover -mx-2 px-2 rounded">
										<FileLink path={f.path} basename />
										<span className="text-xs text-text-faint tabular-nums">{f.symbolCount}</span>
									</li>
								))}
						</ul>
					</div>
				))}
			</div>
		</div>
	)
}
