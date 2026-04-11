import { useLocation, Link } from 'wouter'
import { useState, useEffect, type ReactNode } from 'react'
import { api, setCurrentProject, getCurrentProject } from '../lib/api.js'

const NAV_ITEMS = [
	{ path: '/', label: 'dashboard', icon: '◈' },
	{ path: '/search', label: 'search', icon: '⌕' },
	{ path: '/graph', label: 'graph', icon: '◉' },
	{ path: '/trace', label: 'trace', icon: '→' },
	{ path: '/dead-code', label: 'dead code', icon: '✕' },
	{ path: '/flows', label: 'flows', icon: '⇢' },
	{ path: '/duplicates', label: 'duplicates', icon: '⊜' },
	{ path: '/wiki', label: 'wiki', icon: '≡' },
	{ path: '/projects', label: 'projects', icon: '◫' },
]

export function Layout({ children }: { children: ReactNode }) {
	const [location] = useLocation()
	const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
	const [activeProject, setActiveProject] = useState(getCurrentProject())

	useEffect(() => {
		api.projects().then((r) => {
			setProjects(r.projects)
			if (!activeProject && r.projects.length > 0) {
				setActiveProject(r.projects[0].id)
				setCurrentProject(r.projects[0].id)
			}
		}).catch(() => {})
	}, [])

	const handleProjectChange = (id: string) => {
		setActiveProject(id)
		setCurrentProject(id)
		window.location.reload()
	}

	return (
		<div className="flex h-screen">
			<nav className="w-48 shrink-0 border-r border-border bg-surface-raised flex flex-col">
				<div className="px-4 py-4 border-b border-border">
					<span className="text-sm font-bold tracking-wider text-accent">atlas</span>
					{projects.length > 1 && (
						<select
							value={activeProject ?? ''}
							onChange={(e) => handleProjectChange(e.target.value)}
							className="mt-2 w-full bg-surface border border-border rounded px-2 py-1 text-[10px] text-text-muted"
						>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>{p.name}</option>
							))}
						</select>
					)}
					{projects.length === 1 && (
						<div className="mt-1 text-[10px] text-text-muted truncate">{projects[0].name}</div>
					)}
				</div>
				<div className="flex flex-col gap-0.5 p-2 flex-1">
					{NAV_ITEMS.map((item) => {
						const active = item.path === '/' ? location === '/' : location.startsWith(item.path)
						return (
							<Link
								key={item.path}
								href={item.path}
								className={`flex items-center gap-2.5 px-3 py-2 rounded text-xs transition-colors ${
									active
										? 'bg-accent/10 text-accent'
										: 'text-text-muted hover:text-text hover:bg-surface-hover'
								}`}
							>
								<span className="w-4 text-center opacity-60">{item.icon}</span>
								{item.label}
							</Link>
						)
					})}
				</div>
			</nav>
			<main className="flex-1 overflow-auto p-6">{children}</main>
		</div>
	)
}
