import type { ReactNode } from 'react'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'error'

const tones: Record<Tone, string> = {
	neutral: 'bg-surface-sunken text-text-muted border-border',
	accent: 'bg-accent-soft text-accent border-accent/30',
	success: 'bg-success/10 text-success border-success/30',
	warning: 'bg-warning/10 text-warning border-warning/30',
	error: 'bg-error/10 text-error border-error/30',
}

export function Badge({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
	return (
		<span className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded-[6px] text-[11px] font-medium border ${tones[tone]} ${className}`}>
			{children}
		</span>
	)
}
