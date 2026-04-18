import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: Variant
	size?: Size
	children: ReactNode
}

const variants: Record<Variant, string> = {
	primary: 'bg-accent text-white hover:bg-accent-hover border border-transparent',
	secondary: 'bg-surface-raised text-text border border-border hover:bg-surface-hover hover:border-border-strong',
	ghost: 'bg-transparent text-text-secondary hover:text-text hover:bg-surface-hover border border-transparent',
	danger: 'bg-transparent text-error hover:bg-error/10 border border-transparent',
}

const sizes: Record<Size, string> = {
	sm: 'h-7 px-2.5 text-xs gap-1.5',
	md: 'h-9 px-3.5 text-sm gap-2',
	lg: 'h-11 px-5 text-base gap-2',
}

export function Button({ variant = 'secondary', size = 'md', className = '', children, ...rest }: ButtonProps) {
	return (
		<button
			{...rest}
			className={`inline-flex items-center justify-center rounded-[var(--radius-default)] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-ring ${variants[variant]} ${sizes[size]} ${className}`}
		>
			{children}
		</button>
	)
}
