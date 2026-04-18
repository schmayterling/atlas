// per-kind colored badge driven by css vars (themes its own colors).

const KIND_VAR: Record<string, string> = {
	function: '--color-kind-function',
	class: '--color-kind-class',
	method: '--color-kind-method',
	interface: '--color-kind-interface',
	type: '--color-kind-type',
	variable: '--color-kind-variable',
	module: '--color-kind-module',
	enum: '--color-kind-enum',
	property: '--color-kind-property',
}

export function KindBadge({ kind, size = 'sm' }: { kind: string; size?: 'xs' | 'sm' }) {
	const cssVar = KIND_VAR[kind] ?? '--color-text-muted'
	const cls = size === 'xs' ? 'text-[9px] px-1 py-[1px]' : 'text-[10px] px-1.5 py-[1px]'
	return (
		<span
			className={`inline-flex items-center rounded-[5px] font-medium border ${cls}`}
			style={{
				color: `var(${cssVar})`,
				backgroundColor: `color-mix(in oklab, var(${cssVar}) 10%, transparent)`,
				borderColor: `color-mix(in oklab, var(${cssVar}) 25%, transparent)`,
			}}
		>
			{kind}
		</span>
	)
}
