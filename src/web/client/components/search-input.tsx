import { useState, useEffect, useRef } from 'react'

export function SearchInput({
	value,
	onChange,
	placeholder = 'search symbols...',
	debounceMs = 300,
}: {
	value: string
	onChange: (value: string) => void
	placeholder?: string
	debounceMs?: number
}) {
	const [local, setLocal] = useState(value)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		setLocal(value)
	}, [value])

	const handleChange = (v: string) => {
		setLocal(v)
		if (timer.current) clearTimeout(timer.current)
		timer.current = setTimeout(() => onChange(v), debounceMs)
	}

	return (
		<input
			type="text"
			value={local}
			onChange={(e) => handleChange(e.target.value)}
			placeholder={placeholder}
			className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
		/>
	)
}
