import { listProjects, addProject, removeProject, linkProjects, getProjectLinks } from '../../core/registry.js'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import pc from 'picocolors'

export function projectsCommand(action: string, args: string[], json: boolean) {
	switch (action) {
		case 'list': {
			const projects = listProjects()
			const links = getProjectLinks()
			if (json) {
				console.log(JSON.stringify({ projects, links }, null, 2))
				return
			}
			if (projects.length === 0) {
				console.log('no projects registered. run `atlas projects add <path>` to add one.')
				return
			}
			console.log(pc.bold(`${projects.length} project${projects.length > 1 ? 's' : ''}`))
			console.log()
			for (const p of projects) {
				console.log(`  ${pc.cyan(p.id)}  ${p.name}`)
				console.log(`    ${pc.dim(p.root)}`)
			}
			if (links.length > 0) {
				console.log()
				console.log(pc.bold('links'))
				for (const l of links) {
					console.log(`  ${l.from} → ${l.to} (${l.type})`)
				}
			}
			break
		}
		case 'add': {
			const root = args[0] ?? process.cwd()
			const name = args[1]
			const project = addProject(root, name)
			if (json) {
				console.log(JSON.stringify(project, null, 2))
			} else {
				console.log(`added project: ${pc.cyan(project.id)} (${project.root})`)
			}
			break
		}
		case 'remove': {
			const id = args[0]
			if (!id) {
				console.error('usage: atlas projects remove <id>')
				process.exit(1)
			}
			const removed = removeProject(id)
			if (json) {
				console.log(JSON.stringify({ removed }))
			} else if (removed) {
				console.log(`removed project: ${id}`)
			} else {
				console.log(`project not found: ${id}`)
			}
			break
		}
		case 'link': {
			const [from, to] = args
			if (!from || !to) {
				console.error('usage: atlas projects link <from-id> <to-id>')
				process.exit(1)
			}
			const linked = linkProjects(from, to)
			if (json) {
				console.log(JSON.stringify({ linked }))
			} else if (linked) {
				console.log(`linked: ${from} → ${to}`)
			} else {
				console.log('failed to link (project not found)')
			}
			break
		}
		case 'clear-edges': {
			const projects = listProjects()
			const targets = args.length > 0
				? projects.filter((p) => args.includes(p.id))
				: projects
			if (targets.length === 0) {
				console.error('no matching projects to clear edges from')
				process.exit(1)
			}
			const summary: Array<{ project: string; deleted: number }> = []
			for (const project of targets) {
				const engine = getOrCreateEngine(project.id, project.root)
				const deleted = engine.clearCrossProjectEdges()
				summary.push({ project: project.id, deleted })
			}
			if (json) {
				console.log(JSON.stringify(summary, null, 2))
			} else {
				for (const row of summary) {
					console.log(`cleared ${pc.yellow(String(row.deleted))} cross-project edge${row.deleted === 1 ? '' : 's'} from ${pc.cyan(row.project)}`)
				}
			}
			break
		}
		default:
			console.error(`unknown action: ${action}. use: list, add, remove, link, clear-edges`)
			process.exit(1)
	}
}
