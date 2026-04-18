import { Link } from 'wouter'
import { KindBadge } from './kind-badge.js'

// every symbol mention in the ui becomes one of these. href routes to /s/<qn>.

export function SymbolLink({
	name,
	qualifiedName,
	kind,
	muted = false,
	showKind = true,
}: {
	name: string
	qualifiedName: string
	kind?: string
	muted?: boolean
	showKind?: boolean
}) {
	return (
		<Link
			href={`/s/${encodeURIComponent(qualifiedName)}`}
			className={`inline-flex items-center gap-1.5 group ${muted ? 'text-text-muted hover:text-text' : 'text-text hover:text-accent'}`}
		>
			{showKind && kind && <KindBadge kind={kind} size="xs" />}
			<span className="font-mono text-sm group-hover:underline underline-offset-2">{name}</span>
		</Link>
	)
}
