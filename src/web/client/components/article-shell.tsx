// shared shell for symbol / file / subsystem articles. main column is
// constrained to a readable width; right rail holds facts. left rail
// (in-page outline) is reserved for phase 3 once articles get richer.

import type { ReactNode } from 'react'

export function ArticleShell({
	header,
	aside,
	children,
}: {
	header: ReactNode
	aside?: ReactNode
	children: ReactNode
}) {
	return (
		<div className="flex gap-10">
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
			{eyebrow && <div className="text-xs text-text-muted mb-2 flex items-center gap-2">{eyebrow}</div>}
			<h1 className="text-xl font-bold tracking-tight text-text">{title}</h1>
			{subtitle && <div className="mt-2 text-base text-text-secondary">{subtitle}</div>}
			{meta && <div className="mt-3 flex items-center gap-3 text-xs text-text-muted">{meta}</div>}
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
