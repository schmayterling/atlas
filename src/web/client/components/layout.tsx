import { Link, useLocation } from 'wouter'
import { useEffect, useState, type ReactNode } from 'react'
import { Home, Library, Boxes, Sparkles, GitBranch, Search } from 'lucide-react'
import { api, getCurrentProject, setCurrentProject } from '../lib/api.js'
import { ThemeToggle, Kbd } from '../ui/index.js'
import { CommandPalette, useCommandPalette } from './command-palette.js'

const NAV = [
	{ path: '/', label: 'home', icon: Home, exact: true },
	{ path: '/browse', label: 'browse', icon: Library },
	{ path: '/sub', label: 'subsystems', icon: Boxes, prefix: '/sub' },
	{ path: '/insights', label: 'insights', icon: Sparkles },
	{ path: '/graph', label: 'graph', icon: GitBranch },
]

function isActive(itemPath: string, location: string, exact = false, prefix?: string): boolean {
	if (exact) return location === itemPath
	if (prefix) return location.startsWith(prefix)
	return location === itemPath || location.startsWith(`${itemPath}/`)
}

export function Layout({ children }: { children: ReactNode }) {
	const [location] = useLocation()
	const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
	const [activeProject, setActiveProject] = useState(getCurrentProject())
	const palette = useCommandPalette()

	useEffect(() => {
		api.projects().then((r) => {
			setProjects(r.projects)
			if (!activeProject && r.projects.length > 0) {
				setActiveProject(r.projects[0].id)
				setCurrentProject(r.projects[0].id)
			}
		}).catch(() => {})
	}, [])

	const onProjectChange = (id: string) => {
		setActiveProject(id)
		setCurrentProject(id)
		window.location.reload()
	}

	return (
		<div className="min-h-screen flex flex-col bg-surface text-text">
			<header className="sticky top-0 z-40 border-b border-border bg-surface/85 backdrop-blur-md">
				<div className="max-w-[1400px] mx-auto flex items-center h-14 px-6 gap-6">
					<Link href="/" className="flex items-center gap-2 text-text font-semibold tracking-tight text-md">
						<span className="text-accent">atlas</span>
						<span className="text-text-faint font-normal text-xs">/ wiki</span>
					</Link>

					<nav className="flex items-center gap-1">
						{NAV.map((item) => {
							const active = isActive(item.path, location, item.exact, item.prefix)
							const Icon = item.icon
							return (
								<Link
									key={item.path}
									href={item.path}
									className={`flex items-center gap-1.5 px-2.5 h-8 rounded-[var(--radius-default)] text-sm font-medium ${
										active
											? 'bg-accent-soft text-accent'
											: 'text-text-secondary hover:text-text hover:bg-surface-hover'
									}`}
								>
									<Icon size={14} strokeWidth={2} />
									<span>{item.label}</span>
								</Link>
							)
						})}
					</nav>

					<div className="flex-1" />

					<button
						className="flex items-center gap-2 h-8 px-2.5 rounded-[var(--radius-default)] border border-border text-text-muted hover:text-text hover:bg-surface-hover text-sm cursor-pointer"
						title="search (⌘K)"
						onClick={() => palette.setOpen(true)}
					>
						<Search size={13} strokeWidth={2} />
						<span>search</span>
						<Kbd>⌘K</Kbd>
					</button>

					{projects.length > 1 && (
						<select
							value={activeProject ?? ''}
							onChange={(e) => onProjectChange(e.target.value)}
							className="h-8 px-2 rounded-[var(--radius-default)] border border-border bg-surface-raised text-sm text-text-secondary cursor-pointer hover:bg-surface-hover focus-ring"
						>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>{p.name}</option>
							))}
						</select>
					)}

					<ThemeToggle />
				</div>
			</header>

			<main className="flex-1 max-w-[1400px] w-full mx-auto px-6 py-8">
				{children}
			</main>

			<CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
		</div>
	)
}
