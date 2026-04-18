// renders pre-highlighted html (from server-side shiki, see src/web/highlight.ts)
// or falls back to raw text in a styled <pre>.
//
// SAFETY: the html prop is only ever populated by the server's shiki
// renderer over source code already indexed by atlas (i.e. files inside
// the user's own project). shiki escapes its inputs and emits a
// well-formed <pre><code>...</code></pre> tree with inline styles.
// atlas web is local-only (binds 127.0.0.1, see server.ts), matching the
// existing trust boundary used by the wiki page.

export function CodeBlock({
	html,
	code,
	language,
	maxHeight,
}: {
	html?: string
	code?: string
	language?: string
	maxHeight?: number
}) {
	const style = maxHeight ? { maxHeight: `${maxHeight}px` } : undefined
	if (html) {
		return (
			<div
				className="rounded-[var(--radius-default)] border border-border bg-surface-sunken text-sm overflow-auto p-3"
				style={style}
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		)
	}
	return (
		<pre
			className="rounded-[var(--radius-default)] border border-border bg-surface-sunken text-sm overflow-auto p-3 font-mono"
			style={style}
			data-lang={language}
		>
			<code>{code}</code>
		</pre>
	)
}
