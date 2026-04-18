import { useState, useEffect, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useOutline } from '../components/article-shell.js'

// section: a collapsible chunk of an article. id becomes the anchor target.
// title is rendered as h2. registers itself with the surrounding article
// shell's outline (if any).

export function Section({
	id,
	title,
	right,
	defaultOpen = true,
	collapsible = true,
	children,
}: {
	id: string
	title: string
	right?: ReactNode
	defaultOpen?: boolean
	collapsible?: boolean
	children: ReactNode
}) {
	const [open, setOpen] = useState(defaultOpen)
	const outline = useOutline()

	useEffect(() => {
		if (!outline) return
		outline.register({ id, label: title })
		return () => outline.unregister(id)
	}, [id, title])

	return (
		<section id={id} className="scroll-mt-20 mt-8 first:mt-0">
			<div className="flex items-center justify-between border-b border-border pb-2 mb-3">
				<button
					onClick={() => collapsible && setOpen(!open)}
					className={`flex items-center gap-2 group ${collapsible ? 'cursor-pointer' : 'cursor-default'}`}
					disabled={!collapsible}
				>
					{collapsible && (
						<ChevronDown
							size={14}
							className={`text-text-faint transition-transform ${open ? '' : '-rotate-90'}`}
						/>
					)}
					<h2 className="text-md font-semibold text-text group-hover:text-accent">{title}</h2>
				</button>
				{right && <div className="text-xs text-text-muted">{right}</div>}
			</div>
			{open && <div>{children}</div>}
		</section>
	)
}
