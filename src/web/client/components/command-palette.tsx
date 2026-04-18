// global command palette. ⌘K / Ctrl+K opens it. fuzzy search across
// symbols (via /api/search FTS), files (substring on cached file list),
// and subsystems (substring on cached list). Enter routes to article.

import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { Search, FileText, Boxes, Home, Library, Sparkles, GitBranch, ArrowRight } from 'lucide-react'
import { api } from '../lib/api.js'
import type { FileInfo, SymbolResult, SubsystemSummary } from '../../../shared/types.js'
import { KindBadge, Kbd } from '../ui/index.js'

type Item =
	| { type: 'symbol'; key: string; label: string; sublabel: string; href: string; kind: string }
	| { type: 'file'; key: string; label: string; sublabel: string; href: string }
	| { type: 'subsystem'; key: string; label: string; sublabel: string; href: string }
	| { type: 'nav'; key: string; label: string; sublabel: string; href: string; icon: any; shortcut?: string }

const NAV_ITEMS: Item[] = [
	{ type: 'nav', key: 'nav:home', label: 'home', sublabel: 'overview', href: '/', icon: Home, shortcut: 'g h' },
	{ type: 'nav', key: 'nav:browse', label: 'browse', sublabel: 'files & symbols', href: '/browse', icon: Library, shortcut: 'g b' },
	{ type: 'nav', key: 'nav:sub', label: 'subsystems', sublabel: 'clusters', href: '/sub', icon: Boxes, shortcut: 'g s' },
	{ type: 'nav', key: 'nav:insights', label: 'insights', sublabel: 'dead code, hotspots', href: '/insights', icon: Sparkles, shortcut: 'g i' },
	{ type: 'nav', key: 'nav:graph', label: 'graph', sublabel: 'visualize dependencies', href: '/graph', icon: GitBranch, shortcut: 'g g' },
]

interface PaletteProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange }: PaletteProps) {
	const [, setLocation] = useLocation()
	const [q, setQ] = useState('')
	const [active, setActive] = useState(0)
	const [files, setFiles] = useState<FileInfo[] | null>(null)
	const [subs, setSubs] = useState<SubsystemSummary[] | null>(null)
	const [symbols, setSymbols] = useState<SymbolResult[]>([])
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (!open) return
		setQ(''); setActive(0)
		api.files().then(setFiles).catch(() => setFiles([]))
		api.subsystems().then(setSubs).catch(() => setSubs([]))
		setTimeout(() => inputRef.current?.focus(), 10)
	}, [open])

	useEffect(() => {
		if (!open || !q.trim()) { setSymbols([]); return }
		let cancelled = false
		api.search(q.trim(), { limit: 20 }).then((r) => {
			if (cancelled) return
			if ('results' in r) setSymbols(r.results as SymbolResult[])
		}).catch(() => { if (!cancelled) setSymbols([]) })
		return () => { cancelled = true }
	}, [q, open])

	const items: Item[] = useMemo(() => {
		const ql = q.trim().toLowerCase()
		if (!ql) return NAV_ITEMS

		const out: Item[] = []
		for (const s of symbols.slice(0, 12)) {
			out.push({
				type: 'symbol', key: `s:${s.qualifiedName}`, label: s.name,
				sublabel: `${s.filePath}:${s.lineStart}`, kind: s.kind,
				href: `/s/${encodeURIComponent(s.qualifiedName)}`,
			})
		}
		for (const f of (files ?? []).filter((f) => f.path.toLowerCase().includes(ql)).slice(0, 8)) {
			out.push({
				type: 'file', key: `f:${f.path}`, label: f.path.split('/').pop() ?? f.path,
				sublabel: f.path, href: `/f/${f.path.split('/').map(encodeURIComponent).join('/')}`,
			})
		}
		for (const sub of (subs ?? []).filter((s) => s.name.toLowerCase().includes(ql)).slice(0, 5)) {
			out.push({
				type: 'subsystem', key: `sub:${sub.id}`, label: sub.name,
				sublabel: `${sub.fileCount} files`, href: `/sub/${encodeURIComponent(sub.id)}`,
			})
		}
		// keep nav items at the bottom of search so users can still jump
		for (const n of NAV_ITEMS) {
			if (n.label.toLowerCase().includes(ql)) out.push(n)
		}
		return out
	}, [q, symbols, files, subs])

	useEffect(() => {
		if (active >= items.length) setActive(0)
	}, [items, active])

	const choose = (item: Item) => {
		setLocation(item.href)
		onOpenChange(false)
	}

	const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)) }
		else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
		else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) choose(items[active]) }
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm" />
				<Dialog.Content
					className="fixed left-1/2 top-[15%] z-50 -translate-x-1/2 w-[640px] max-w-[92vw] rounded-[var(--radius-lg)] border border-border bg-surface-raised shadow-2xl outline-none"
				>
					<Dialog.Title className="sr-only">command palette</Dialog.Title>
					<div className="flex items-center gap-3 border-b border-border px-4 h-14">
						<Search size={16} className="text-text-faint" />
						<input
							ref={inputRef}
							value={q}
							onChange={(e) => { setQ(e.target.value); setActive(0) }}
							onKeyDown={onKey}
							placeholder="search symbols, files, subsystems…"
							className="flex-1 bg-transparent text-base outline-none placeholder:text-text-faint"
						/>
						<Kbd>esc</Kbd>
					</div>
					<div className="max-h-[420px] overflow-auto py-2">
						{items.length === 0 ? (
							<div className="px-4 py-6 text-sm text-text-muted">no matches</div>
						) : (
							<ul>
								{items.map((it, i) => (
									<li key={it.key}>
										<button
											onMouseEnter={() => setActive(i)}
											onClick={() => choose(it)}
											className={`w-full flex items-center gap-3 px-4 py-2 text-left cursor-pointer ${
												active === i ? 'bg-accent-soft' : 'hover:bg-surface-hover'
											}`}
										>
											<ItemIcon item={it} />
											<div className="flex-1 min-w-0">
												<div className={`text-sm font-medium truncate ${active === i ? 'text-accent' : 'text-text'}`}>
													{it.label}
												</div>
												<div className="text-xs text-text-muted truncate font-mono">{it.sublabel}</div>
											</div>
											{it.type === 'nav' && it.shortcut && <Kbd>{it.shortcut}</Kbd>}
											{active === i && <ArrowRight size={12} className="text-accent" />}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
					<div className="border-t border-border px-4 py-2 flex items-center justify-between text-xs text-text-faint">
						<span><Kbd>↑↓</Kbd> navigate · <Kbd>↵</Kbd> open</span>
						<span><Kbd>?</Kbd> help</span>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

function ItemIcon({ item }: { item: Item }) {
	if (item.type === 'symbol') return <KindBadge kind={item.kind} />
	if (item.type === 'file') return <FileText size={14} className="text-text-muted" />
	if (item.type === 'subsystem') return <Boxes size={14} className="text-text-muted" />
	const I = item.icon
	return <I size={14} className="text-text-muted" />
}

// global keyboard handler: ⌘K / ctrl+K to open palette, g+letter for nav.
// returns the open state + setter so the parent renders the palette.
export function useCommandPalette() {
	const [open, setOpen] = useState(false)
	const [, setLocation] = useLocation()
	const gPressed = useRef<number | null>(null)

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement
			const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				e.preventDefault(); setOpen(true); return
			}
			if (e.key === 'Escape' && open) { setOpen(false); return }
			if (inField) return

			// g <letter> sequence for nav
			if (e.key === 'g') {
				gPressed.current = Date.now()
				return
			}
			if (gPressed.current && Date.now() - gPressed.current < 1500) {
				const map: Record<string, string> = { h: '/', b: '/browse', s: '/sub', i: '/insights', g: '/graph' }
				if (map[e.key]) { e.preventDefault(); setLocation(map[e.key]); gPressed.current = null }
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open])

	return { open, setOpen }
}
