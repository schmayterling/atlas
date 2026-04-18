import { Link } from 'wouter'

export function FileLink({
	path,
	line,
	muted = false,
	basename = false,
}: {
	path: string
	line?: number
	muted?: boolean
	basename?: boolean
}) {
	const display = basename ? path.split('/').pop() ?? path : path
	const suffix = line ? `:${line}` : ''
	return (
		<Link
			href={`/f/${path.split('/').map(encodeURIComponent).join('/')}`}
			className={`font-mono text-xs hover:text-accent hover:underline underline-offset-2 ${muted ? 'text-text-muted' : 'text-text-secondary'}`}
			title={`${path}${suffix}`}
		>
			{display}{suffix}
		</Link>
	)
}
