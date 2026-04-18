import type { ReactNode } from 'react'

export function EmptyState({
	title,
	description,
	icon,
	action,
}: {
	title: string
	description?: ReactNode
	icon?: ReactNode
	action?: ReactNode
}) {
	return (
		<div className="flex flex-col items-center justify-center py-12 px-4 text-center border border-dashed border-border rounded-[var(--radius-lg)] bg-surface-raised">
			{icon && <div className="text-text-faint mb-3">{icon}</div>}
			<h3 className="text-base font-semibold text-text mb-1">{title}</h3>
			{description && <div className="text-sm text-text-muted max-w-md">{description}</div>}
			{action && <div className="mt-4">{action}</div>}
		</div>
	)
}
