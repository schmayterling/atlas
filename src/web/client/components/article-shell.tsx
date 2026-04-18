// shared shell for symbol / file / subsystem articles. main column is
// constrained to a readable width; right rail holds facts. left rail
// is an in-page outline that auto-collects Section ids registered via
// the OutlineContext provider.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

type OutlineEntry = { id: string; label: string }

type OutlineCtx = {
	entries: OutlineEntry[]
	register: (entry: OutlineEntry) => void
	unregister: (id: string) => void
	active: string | null
	setActive: (id: string | null) => void
}

const OutlineContext = createContext<OutlineCtx | null>(null)

export function useOutline() {
	return useContext(OutlineContext)
}

export function ArticleShell({
	header,
	aside,
	children,
}: {
	header: ReactNode
	aside?: ReactNode
	children: ReactNode
}) {
	const [entries, setEntries] = useState<OutlineEntry[]>([])
	const [active, setActive] = useState<string | null>(null)

	const ctx = useMemo<OutlineCtx>(() => ({
		entries,
		register: (e) => setEntries((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e])),
		unregister: (id) => setEntries((prev) => prev.filter((x) => x.id !== id)),
		active,
		setActive,
	}), [entries, active])

	useEffect(() => {
		const observer = new IntersectionObserver(
			(records) => {
				const visible = records
					.filter((r) => r.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
				if (visible[0]) setActive(visible[0].target.id)
			},
			{ rootMargin: '-80px 0px -60% 0px' },
		)
		entries.forEach((e) => {
			const el = document.getElementById(e.id)
			if (el) observer.observe(el)
		})
		return () => observer.disconnect()
	}, [entries])

	return (
		<OutlineContext.Provider value={ctx}>
			<div className="flex gap-10">
				<OutlineRail />
				<article className="flex-1 min-w-0 max-w-[820px]">
					<div className="mb-8">{header}</div>
					{children}
				</article>
				{aside && (
					<aside className="hidden lg:block w-64 shrink-0 sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-auto">
						{aside}
					</aside>
				)}
			</div>
		</OutlineContext.Provider>
	)
}

function OutlineRail() {
	const ctx = useContext(OutlineContext)
	if (!ctx || ctx.entries.length === 0) return null
	return (
		<nav className="hidden xl:block w-48 shrink-0 sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-auto pt-1">
			<div className="text-[11px] uppercase tracking-wider text-text-faint mb-2">on this page</div>
			<ul className="space-y-1">
				{ctx.entries.map((e) => (
					<li key={e.id}>
						<a
							href={`#${e.id}`}
							className={`block py-0.5 text-sm border-l-2 pl-3 ${
								ctx.active === e.id
									? 'border-accent text-accent'
									: 'border-transparent text-text-muted hover:text-text'
							}`}
						>
							{e.label}
						</a>
					</li>
				))}
			</ul>
		</nav>
	)
}

export function ArticleHeader({
	eyebrow,
	title,
	subtitle,
	meta,
}: {
	eyebrow?: ReactNode
	title: ReactNode
	subtitle?: ReactNode
	meta?: ReactNode
}) {
	return (
		<header>
			{eyebrow && <div className="text-xs text-text-muted mb-2 flex items-center gap-2 flex-wrap">{eyebrow}</div>}
			<h1 className="text-xl font-bold tracking-tight text-text">{title}</h1>
			{subtitle && <div className="mt-2 text-base text-text-secondary">{subtitle}</div>}
			{meta && <div className="mt-3 flex items-center gap-3 text-xs text-text-muted flex-wrap">{meta}</div>}
		</header>
	)
}

export function FactList({ items }: { items: { label: string; value: ReactNode }[] }) {
	return (
		<dl className="space-y-3">
			{items.map((item, i) => (
				<div key={i}>
					<dt className="text-[11px] uppercase tracking-wider text-text-faint mb-0.5">{item.label}</dt>
					<dd className="text-sm text-text-secondary break-words">{item.value}</dd>
				</div>
			))}
		</dl>
	)
}
