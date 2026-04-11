import { useLocation, Link } from 'wouter'
import { useState, useEffect, type ReactNode } from 'react'
import { api, setCurrentProject, getCurrentProject } from '../lib/api.js'
import {
	LayoutDashboard,
	Search,
	GitBranch,
	Route,
	Trash2,
	Workflow,
	Copy,
	BookOpen,
	FolderKanban,
	PanelLeftClose,
	PanelLeftOpen,
	ChevronRight,
} from 'lucide-react'

const NAV_ITEMS = [
	{ path: '/', label: 'dashboard', icon: LayoutDashboard },
	{ path: '/search', label: 'search', icon: Search },
	{ path: '/graph', label: 'graph', icon: GitBranch },
	{ path: '/trace', label: 'trace', icon: Route },
	{ path: '/dead-code', label: 'dead code', icon: Trash2 },
	{ path: '/flows', label: 'flows', icon: Workflow },
	{ path: '/duplicates', label: 'duplicates', icon: Copy },
	{ path: '/wiki', label: 'wiki', icon: BookOpen },
	{ path: '/projects', label: 'projects', icon: FolderKanban },
]

function getBreadcrumbs(path: string): { label: string; href: string }[] {
	const crumbs = [{ label: 'atlas', href: '/' }]
	const item = NAV_ITEMS.find((i) => i.path === path || (i.path !== '/' && path.startsWith(i.path)))
	if (item && item.path !== '/') {
		crumbs.push({ label: item.label, href: item.path })
	}
	return crumbs
}

export function Layout({ children }: { children: ReactNode }) {
	const [location] = useLocation()
	const [collapsed, setCollapsed] = useState(localStorage.getItem('sidebar-collapsed') === 'true')
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

	const toggleCollapsed = () => {
		const next = !collapsed
		setCollapsed(next)
		localStorage.setItem('sidebar-collapsed', String(next))
	}

	const handleProjectChange = (id: string) => {
		setActiveProject(id)
		setCurrentProject(id)
		window.location.reload()
	}

	const breadcrumbs = getBreadcrumbs(location)

	return (
		<div className="flex h-screen overflow-hidden">
			<nav
				className={`shrink-0 border-r border-border bg-surface-raised flex flex-col sidebar-nav ${
					collapsed ? 'w-12 sidebar-collapsed' : 'w-48'
				}`}
			>
				<div className="flex items-center h-11 border-b border-border px-0 gap-0">
					<span className="w-9 flex items-center justify-center shrink-0">
						<button
							onClick={toggleCollapsed}
							className="p-1 rounded-[var(--radius-default)] text-text-muted hover:text-text hover:bg-surface-hover cursor-pointer"
						>
							{collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
						</button>
					</span>
					<span className="text-xs font-semibold tracking-wide text-accent sidebar-label">atlas</span>
				</div>

				{!collapsed && projects.length > 1 && (
					<div className="px-2 py-2 border-b border-border">
						<select
							value={activeProject ?? ''}
							onChange={(e) => handleProjectChange(e.target.value)}
							className="w-full bg-surface border border-border rounded-[var(--radius-default)] px-2 py-1 text-[11px] text-text-secondary"
						>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>{p.name}</option>
							))}
						</select>
					</div>
				)}

				<div className="flex flex-col gap-px p-1.5 flex-1 overflow-y-auto overflow-x-hidden">
					{NAV_ITEMS.map((item) => {
						const active = item.path === '/'
							? location === '/'
							: location.startsWith(item.path)
						const Icon = item.icon
						return (
							<Link
								key={item.path}
								href={item.path}
								className={`flex items-center gap-0 rounded-[var(--radius-default)] py-[7px] px-0 ${
									active
										? 'bg-accent/10 text-accent'
										: 'text-text-muted hover:text-text hover:bg-surface-hover'
								}`}
								title={collapsed ? item.label : undefined}
							>
								<span className="w-9 flex items-center justify-center shrink-0">
									<Icon size={15} strokeWidth={1.8} />
								</span>
								<span className="text-[12px] sidebar-label">{item.label}</span>
							</Link>
						)
					})}
				</div>

				{!collapsed && projects.length === 1 && (
					<div className="px-3 py-2 border-t border-border">
						<div className="text-[10px] text-text-muted truncate">{projects[0]?.name}</div>
					</div>
				)}
			</nav>

			<div className="flex-1 flex flex-col min-w-0">
				<div className="flex items-center gap-1 px-5 h-11 border-b border-border text-[12px] shrink-0">
					{breadcrumbs.map((crumb, i) => (
						<span key={crumb.href} className="flex items-center gap-1">
							{i > 0 && <ChevronRight size={12} className="text-text-muted" />}
							{i === breadcrumbs.length - 1 ? (
								<span className="text-text-secondary">{crumb.label}</span>
							) : (
								<Link href={crumb.href} className="text-text-muted hover:text-text">
									{crumb.label}
								</Link>
							)}
						</span>
					))}
				</div>

				<main className="flex-1 overflow-auto p-5">{children}</main>
			</div>
		</div>
	)
}
