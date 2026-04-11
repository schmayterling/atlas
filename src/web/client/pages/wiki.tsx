import { useEffect, useState } from 'react'
import type { FileInfo } from '../../../shared/types.js'
import { api } from '../lib/api.js'

function SummarizeButton({ symbolQuery }: { symbolQuery: string }) {
	const [summary, setSummary] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const handleClick = async () => {
		setLoading(true)
		setError(null)
		try {
			const result = await api.summarize(symbolQuery)
			setSummary(result.summary)
		} catch (e: any) {
			setError(e.message || 'failed')
		} finally {
			setLoading(false)
		}
	}

	if (summary) {
		return (
			<div className="mt-4 p-3 rounded border border-accent/20 bg-surface text-sm text-text-muted">
				<div className="text-[10px] text-accent mb-1">LLM summary</div>
				{summary}
			</div>
		)
	}

	return (
		<div className="mt-4">
			{error && <div className="text-[10px] text-error mb-1">{error}</div>}
			<button
				onClick={handleClick}
				disabled={loading}
				className="text-[10px] text-accent hover:text-accent-hover cursor-pointer border border-accent/30 px-2 py-0.5 rounded transition-colors disabled:opacity-50"
			>
				{loading ? 'summarizing...' : 'summarize with LLM'}
			</button>
		</div>
	)
}

export function WikiPage() {
	const [files, setFiles] = useState<FileInfo[]>([])
	const [selectedFile, setSelectedFile] = useState<string | null>(null)
	const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
	const [wikiContent, setWikiContent] = useState<string | null>(null)
	const [fileSymbols, setFileSymbols] = useState<any[]>([])
	const [fileSummary, setFileSummary] = useState<string | null>(null)
	const [searchFilter, setSearchFilter] = useState('')
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		api
			.files()
			.then(setFiles)
			.catch((e) => setError(e.message))
	}, [])

	useEffect(() => {
		if (!selectedFile) {
			setFileSymbols([])
			setFileSummary(null)
			return
		}
		api
			.fileSymbols(selectedFile)
			.then(setFileSymbols)
			.catch((e) => setError(e.message))
		// fetch file summary
		fetch(`/api/wiki?file=${encodeURIComponent(selectedFile)}`)
			.then((r) => r.json())
			.then((r) => setFileSummary(r.summary))
			.catch(() => setFileSummary(null))
	}, [selectedFile])

	useEffect(() => {
		if (!selectedSymbol) {
			setWikiContent(null)
			return
		}
		setLoading(true)
		setError(null)
		api
			.wiki(selectedSymbol)
			.then((r) => {
				if (r.type === 'symbol' && 'html' in r) {
					setWikiContent(r.html as string)
				}
			})
			.catch((e) => setError(e.message))
			.finally(() => setLoading(false))
	}, [selectedSymbol])

	const filteredFiles = files.filter(
		(f) => !searchFilter || f.path.toLowerCase().includes(searchFilter.toLowerCase()),
	)

	// group files by directory
	const dirs = new Map<string, FileInfo[]>()
	for (const f of filteredFiles) {
		const parts = f.path.split('/')
		const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.'
		if (!dirs.has(dir)) dirs.set(dir, [])
		dirs.get(dir)!.push(f)
	}

	return (
		<div className="flex h-full gap-4">
			<div className="w-64 shrink-0 border-r border-border pr-4 overflow-auto">
				<div className="mb-3">
					<input
						type="text"
						value={searchFilter}
						onChange={(e) => setSearchFilter(e.target.value)}
						placeholder="filter files..."
						className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
					/>
				</div>
				{[...dirs.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([dir, dirFiles]) => (
						<div key={dir} className="mb-2">
							<div className="text-[10px] text-text-muted mb-0.5 uppercase tracking-wider">
								{dir}/
							</div>
							{dirFiles
								.sort((a, b) => a.path.localeCompare(b.path))
								.map((f) => {
									const fileName = f.path.split('/').pop()
									const active = selectedFile === f.path
									return (
										<button
											key={f.path}
											onClick={() => {
												setSelectedFile(f.path)
												setSelectedSymbol(null)
											}}
											className={`w-full text-left px-2 py-1 text-xs rounded cursor-pointer flex items-center justify-between ${
												active
													? 'bg-accent/10 text-accent'
													: 'text-text-muted hover:text-text hover:bg-surface-hover'
											}`}
										>
											<span className="truncate">{fileName}</span>
											<span className="text-[10px] opacity-50">{f.symbolCount}</span>
										</button>
									)
								})}
						</div>
					))}
			</div>

			<div className="flex-1 overflow-auto">
				{!selectedFile && !selectedSymbol && (
					<div>
						<h1 className="text-lg font-bold mb-4">wiki</h1>
						<p className="text-sm text-text-muted mb-4">
							select a file from the sidebar to browse symbols, or click a symbol to see its
							documentation.
						</p>
						<div className="text-xs text-text-muted">
							{files.length} files, {files.reduce((sum, f) => sum + f.symbolCount, 0)} symbols
							indexed
						</div>
					</div>
				)}

				{error && <div className="text-error text-sm mb-4">{error}</div>}

				{selectedFile &&
					!selectedSymbol &&
					(() => {
						const exported = fileSymbols.filter((s: any) => s.isExported)
						const internal = fileSymbols.filter((s: any) => !s.isExported)
						return (
							<div>
								<div className="text-xs text-text-muted mb-1">
									<button
										onClick={() => {
											setSelectedFile(null)
											setSelectedSymbol(null)
										}}
										className="hover:text-text cursor-pointer"
									>
										wiki
									</button>
									<span className="mx-1">/</span>
									<span>{selectedFile}</span>
								</div>
								<h1 className="text-lg font-bold mb-2">{selectedFile.split('/').pop()}</h1>
							{fileSummary && (
								<div className="text-xs text-text-muted mb-4 p-2 rounded border border-accent/20 bg-surface">
									<span className="text-[10px] text-accent">file summary: </span>
									{fileSummary}
								</div>
							)}
								<div className="space-y-1">
									{exported.map((sym: any) => (
										<button
											key={sym.qualifiedName}
											onClick={() => setSelectedSymbol(sym.qualifiedName)}
											className="w-full text-left px-3 py-2 rounded hover:bg-surface-hover transition-colors cursor-pointer flex items-center gap-2"
										>
											<span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-text-muted">
												{sym.kind}
											</span>
											<span className="text-sm font-bold">{sym.name}</span>
											{sym.signature && (
												<span className="text-xs text-text-muted truncate">{sym.signature}</span>
											)}
										</button>
									))}
									{internal.length > 0 && (
										<>
											<div className="text-xs text-text-muted mt-3 mb-1">internal</div>
											{internal.map((sym: any) => (
												<button
													key={sym.qualifiedName}
													onClick={() => setSelectedSymbol(sym.qualifiedName)}
													className="w-full text-left px-3 py-2 rounded hover:bg-surface-hover transition-colors cursor-pointer flex items-center gap-2 opacity-60"
												>
													<span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-text-muted">
														{sym.kind}
													</span>
													<span className="text-sm">{sym.name}</span>
												</button>
											))}
										</>
									)}
								</div>
							</div>
						)
					})()}

				{selectedSymbol && (
					<div>
						<div className="text-xs text-text-muted mb-1">
							<button
								onClick={() => {
									setSelectedFile(null)
									setSelectedSymbol(null)
								}}
								className="hover:text-text cursor-pointer"
							>
								wiki
							</button>
							{selectedFile && (
								<>
									<span className="mx-1">/</span>
									<button
										onClick={() => setSelectedSymbol(null)}
										className="hover:text-text cursor-pointer"
									>
										{selectedFile.split('/').pop()}
									</button>
								</>
							)}
							<span className="mx-1">/</span>
							<span>{selectedSymbol.split('::').pop()}</span>
						</div>
						{loading ? (
							<div className="text-sm text-text-muted">loading...</div>
						) : wikiContent ? (
							<>
								<WikiContent html={wikiContent} />
								<SummarizeButton symbolQuery={selectedSymbol} />
							</>
						) : (
							<div className="text-sm text-text-muted">no documentation available</div>
						)}
					</div>
				)}
			</div>
		</div>
	)
}

// server-side marked output with HTML-escaped inputs. local-only tool (127.0.0.1).
function WikiContent({ html }: { html: string }) {
	return (
		<div
			className="prose prose-invert prose-sm max-w-none [&_h1]:text-lg [&_h1]:font-bold [&_h1]:mb-3 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_p]:text-sm [&_p]:text-text-muted [&_p]:mb-2 [&_code]:text-xs [&_code]:bg-surface [&_code]:px-1 [&_code]:rounded [&_pre]:bg-surface [&_pre]:p-3 [&_pre]:rounded [&_pre]:border [&_pre]:border-border [&_pre]:overflow-x-auto [&_pre]:text-xs [&_ul]:text-sm [&_ul]:space-y-1 [&_li]:text-text-muted [&_strong]:text-text"
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	)
}
