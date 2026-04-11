import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

interface ProjectInfo {
	id: string
	name: string
	root: string
}

interface ProjectLink {
	from: string
	to: string
	type: string
}

export function ProjectsPage() {
	const [projects, setProjects] = useState<ProjectInfo[]>([])
	const [links, setLinks] = useState<ProjectLink[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		api.projects()
			.then((r) => {
				setProjects(r.projects)
				setLinks(r.links ?? [])
			})
			.catch((e) => setError(e.message))
			.finally(() => setLoading(false))
	}, [])

	if (error) return <div className="text-error text-sm">{error}</div>
	if (loading) return <div className="text-text-muted text-sm">loading...</div>

	return (
		<div>
			<h1 className="text-lg font-bold mb-4">projects</h1>

			{projects.length === 0 && (
				<div className="border border-border rounded p-4 bg-surface-raised text-sm text-text-muted">
					no projects registered. run <code className="text-accent bg-surface px-1 rounded">atlas projects add .</code> to register a project.
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
				{projects.map((p) => (
					<div key={p.id} className="border border-border rounded p-4 bg-surface-raised">
						<div className="flex items-center gap-2 mb-2">
							<span className="text-sm font-bold text-accent">{p.name}</span>
							<span className="text-[10px] text-text-muted border border-border px-1 rounded">{p.id}</span>
						</div>
						<div className="text-xs text-text-muted truncate">{p.root}</div>
					</div>
				))}
			</div>

			{links.length > 0 && (
				<div>
					<h2 className="text-sm font-bold mb-3">links</h2>
					<div className="space-y-1">
						{links.map((l, i) => (
							<div key={i} className="flex items-center gap-2 text-sm text-text-muted px-3 py-2 border border-border rounded bg-surface-raised">
								<span className="text-accent">{l.from}</span>
								<span>→</span>
								<span className="text-accent">{l.to}</span>
								<span className="text-[10px] border border-border px-1 rounded ml-auto">{l.type}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	)
}
