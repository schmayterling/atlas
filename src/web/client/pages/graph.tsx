import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import * as Tabs from '@radix-ui/react-tabs'
import type { ElementDefinition } from 'cytoscape'
import { ExternalLink, X } from 'lucide-react'
import { api } from '../lib/api.js'
import { depsToElements, blastToElements } from '../lib/graph-utils.js'
import { GraphView, type GraphNodeData } from '../components/graph-view.js'
import { Button, KindBadge, EmptyState, Kbd } from '../ui/index.js'

type Mode = 'deps' | 'blast'
type Direction = 'upstream' | 'downstream' | 'both'

function readParams(): { focus: string; mode: Mode; direction: Direction; depth: number } {
	const sp = new URLSearchParams(window.location.search)
	const mode = sp.get('mode') === 'blast' ? 'blast' : 'deps'
	const directionRaw = sp.get('direction')
	const direction: Direction = directionRaw === 'upstream' || directionRaw === 'downstream' ? directionRaw : 'both'
	const depth = Math.max(1, Math.min(5, Number(sp.get('depth')) || 3))
	return { focus: sp.get('focus') ?? '', mode, direction, depth }
}

export function GraphPage() {
	const [, setLocation] = useLocation()
	const initial = useMemo(() => readParams(), [])
	const [focus, setFocus] = useState(initial.focus)
	const [draftFocus, setDraftFocus] = useState(initial.focus)
	const [mode, setMode] = useState<Mode>(initial.mode)
	const [direction, setDirection] = useState<Direction>(initial.direction)
	const [depth, setDepth] = useState(initial.depth)
	const [elements, setElements] = useState<ElementDefinition[]>([])
	const [info, setInfo] = useState('')
	const [loading, setLoading] = useState(false)
	const [selected, setSelected] = useState<GraphNodeData | null>(null)
	const inputRef = useRef<HTMLInputElement>(null)

	// reflect state to url so the view is shareable + browser back/forward works
	useEffect(() => {
		const sp = new URLSearchParams()
		if (focus) sp.set('focus', focus)
		if (mode !== 'deps') sp.set('mode', mode)
		if (direction !== 'both') sp.set('direction', direction)
		if (depth !== 3) sp.set('depth', String(depth))
		const next = sp.toString() ? `/graph?${sp.toString()}` : '/graph'
		if (next !== window.location.pathname + window.location.search) {
			setLocation(next, { replace: true })
		}
	}, [focus, mode, direction, depth])

	// load whenever a real focus + load-trigger inputs change
	useEffect(() => {
		if (!focus.trim()) { setElements([]); setInfo(''); return }
		let cancelled = false
		setLoading(true); setInfo('')
		;(async () => {
			try {
				if (mode === 'deps') {
					const r = await api.deps(focus, { direction, depth })
					if (cancelled) return
					setElements(depsToElements(r))
					setInfo(`${r.stats.totalNodes} nodes, ${r.stats.totalEdges} edges${r.truncated ? ' (truncated)' : ''}`)
				} else {
					const r = await api.blast(focus, { depth })
					if (cancelled) return
					setElements(blastToElements(r))
					setInfo(`${r.summary.totalSymbols} affected across ${r.summary.totalFiles} files${r.truncated ? ' (truncated)' : ''}`)
				}
			} catch (e: any) {
				if (cancelled) return
				setInfo(e.message ?? 'error')
				setElements([])
			} finally {
				if (!cancelled) setLoading(false)
			}
		})()
		return () => { cancelled = true }
	}, [focus, mode, direction, depth])

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
				e.preventDefault(); inputRef.current?.focus()
			}
			if (e.key === 'Escape') setSelected(null)
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	const submit = (e?: { preventDefault: () => void }) => {
		e?.preventDefault()
		setFocus(draftFocus.trim())
	}

	return (
		<div className="flex flex-col h-[calc(100vh-9rem)]">
			<div className="flex items-baseline gap-3 mb-4">
				<h1 className="text-xl font-bold tracking-tight">graph</h1>
				{info && <span className="text-xs text-text-muted">{info}</span>}
			</div>

			<form onSubmit={submit} className="flex gap-3 mb-4 items-center flex-wrap">
				<div className="relative flex-1 min-w-[260px]">
					<input
						ref={inputRef}
						value={draftFocus}
						onChange={(e) => setDraftFocus(e.target.value)}
						placeholder="qualified symbol name…"
						className="w-full h-9 pl-3 pr-12 rounded-[var(--radius-default)] border border-border bg-surface-raised text-sm font-mono focus-ring focus:border-accent"
					/>
					<div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-faint">
						<Kbd>/</Kbd>
					</div>
				</div>

				<Tabs.Root value={mode} onValueChange={(v) => setMode(v as Mode)}>
					<Tabs.List className="flex border border-border rounded-[var(--radius-default)] overflow-hidden">
						<Tabs.Trigger
							value="deps"
							className="px-3 h-9 text-sm data-[state=active]:bg-accent-soft data-[state=active]:text-accent text-text-muted hover:text-text cursor-pointer"
						>
							dependencies
						</Tabs.Trigger>
						<Tabs.Trigger
							value="blast"
							className="px-3 h-9 text-sm data-[state=active]:bg-accent-soft data-[state=active]:text-accent text-text-muted hover:text-text border-l border-border cursor-pointer"
						>
							blast radius
						</Tabs.Trigger>
					</Tabs.List>
				</Tabs.Root>

				{mode === 'deps' && (
					<div className="flex border border-border rounded-[var(--radius-default)] overflow-hidden">
						{(['upstream', 'downstream', 'both'] as Direction[]).map((d) => (
							<button
								key={d}
								type="button"
								onClick={() => setDirection(d)}
								className={`px-3 h-9 text-sm cursor-pointer ${
									direction === d ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text'
								} ${d !== 'upstream' ? 'border-l border-border' : ''}`}
							>
								{d}
							</button>
						))}
					</div>
				)}

				<div className="flex items-center gap-2">
					<label className="text-xs text-text-muted">depth</label>
					<input
						type="range"
						min={1}
						max={5}
						value={depth}
						onChange={(e) => setDepth(Number(e.target.value))}
						className="w-24"
					/>
					<span className="text-xs text-text-muted w-3 tabular-nums">{depth}</span>
				</div>

				<Button type="submit" variant="primary" size="md" disabled={loading || !draftFocus.trim()}>
					{loading ? 'loading…' : 'visualize'}
				</Button>
			</form>

			<div className="relative flex-1 min-h-0 flex gap-4">
				{!focus && (
					<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
						<EmptyState
							title="visualize a symbol"
							description="enter a qualified symbol name (e.g. src/web/server.ts::createApp) to see its neighborhood."
						/>
					</div>
				)}
				<GraphView
					elements={elements}
					layout={mode === 'blast' ? 'concentric' : 'cose'}
					onNodeClick={setSelected}
					onNodeDoubleClick={(d) => { setDraftFocus(d.qualifiedName); setFocus(d.qualifiedName) }}
					className="flex-1 border border-border rounded-[var(--radius-default)] bg-surface-raised"
				/>

				{selected && (
					<aside className="w-72 shrink-0 border border-border rounded-[var(--radius-default)] bg-surface-raised p-4 overflow-auto">
						<div className="flex items-center justify-between mb-3">
							<KindBadge kind={selected.kind} />
							<button
								onClick={() => setSelected(null)}
								className="text-text-faint hover:text-text cursor-pointer"
								aria-label="close"
							>
								<X size={14} />
							</button>
						</div>
						<div className="font-mono text-base font-semibold mb-1 break-all">{selected.label}</div>
						<div className="text-xs text-text-muted font-mono mb-4 break-all">
							{selected.filePath}:{selected.lineStart}
						</div>
						<div className="flex flex-col gap-2">
							<Link
								href={`/s/${encodeURIComponent(selected.qualifiedName)}`}
								className="inline-flex items-center justify-between gap-2 h-9 px-3 rounded-[var(--radius-default)] border border-border text-sm text-text hover:bg-surface-hover hover:border-border-strong"
							>
								open article <ExternalLink size={12} />
							</Link>
							<button
								onClick={() => { setDraftFocus(selected.qualifiedName); setFocus(selected.qualifiedName) }}
								className="h-9 px-3 rounded-[var(--radius-default)] border border-border text-sm text-text-secondary hover:text-text hover:bg-surface-hover cursor-pointer text-left"
							>
								re-center on this node
							</button>
						</div>
					</aside>
				)}
			</div>
		</div>
	)
}
