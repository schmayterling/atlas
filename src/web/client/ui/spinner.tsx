// skeleton placeholder for loading article sections. prefer this over a
// spinner so the page doesn't twitch when content arrives.

export function Spinner({ lines = 3, className = '' }: { lines?: number; className?: string }) {
	return (
		<div className={`space-y-2 ${className}`} aria-busy="true">
			{Array.from({ length: lines }).map((_, i) => (
				<div
					key={i}
					className="h-3 rounded bg-surface-hover animate-pulse"
					style={{ width: `${60 + ((i * 17) % 35)}%` }}
				/>
			))}
		</div>
	)
}
