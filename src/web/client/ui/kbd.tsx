import type { ReactNode } from 'react'

export function Kbd({ children }: { children: ReactNode }) {
	return (
		<kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-[4px] border border-border bg-surface-sunken text-[10px] font-mono text-text-muted">
			{children}
		</kbd>
	)
}
