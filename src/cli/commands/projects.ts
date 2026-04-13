import { listProjects, addProject, removeProject, linkProjects, getProjectLinks, getLinkedProjects, getProject } from '../../core/registry.js'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { buildCrossProjectEdges } from '../../core/queries/api-trace.js'
import { buildCrossProjectEdgesBySymbolName } from '../../core/queries/symbol-name-linker.js'
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
		case 'build-edges': {
			// `atlas projects build-edges [--all] [--match-by-name] [--from <id> --to <id>]`
			// args layout (positional + flags interleaved): --all picks
			// every linked pair from the registry; --from/--to scopes
			// to a single pair; --match-by-name additionally runs the
			// heuristic name-match linker (off by default — see #8b).
			const all = args.includes('--all')
			const matchByName = args.includes('--match-by-name')
			const fromIdx = args.indexOf('--from')
			const toIdx = args.indexOf('--to')
			const explicitFrom = fromIdx !== -1 ? args[fromIdx + 1] : undefined
			const explicitTo = toIdx !== -1 ? args[toIdx + 1] : undefined

			const pairs: Array<{ from: { id: string; root: string }; to: { id: string; root: string } }> = []
			if (explicitFrom && explicitTo) {
				const fromProject = getProject(explicitFrom)
				const toProject = getProject(explicitTo)
				if (!fromProject || !toProject) {
					console.error(`unknown project id(s): ${[!fromProject && explicitFrom, !toProject && explicitTo].filter(Boolean).join(', ')}`)
					process.exit(1)
				}
				pairs.push({ from: fromProject, to: toProject })
			} else if (all) {
				const projects = listProjects()
				for (let i = 0; i < projects.length; i++) {
					for (let j = i + 1; j < projects.length; j++) {
						pairs.push({ from: projects[i], to: projects[j] })
					}
				}
			} else {
				const projects = listProjects()
				const seen = new Set<string>()
				for (const p of projects) {
					const linked = getLinkedProjects(p.id)
					for (const l of linked) {
						const key = [p.id, l.id].sort().join('|')
						if (seen.has(key)) continue
						seen.add(key)
						pairs.push({ from: p, to: l })
					}
				}
			}

			if (pairs.length === 0) {
				console.error('no project pairs to link. add `--all` for cartesian, link projects with `atlas projects link`, or pass `--from <id> --to <id>`.')
				process.exit(1)
			}

			const summary: Array<{
				from: string
				to: string
				routeMatches: number
				nameMatches: number
			}> = []
			for (const pair of pairs) {
				const fromEngine = getOrCreateEngine(pair.from.id, pair.from.root)
				const toEngine = getOrCreateEngine(pair.to.id, pair.to.root)
				const fromStore = fromEngine.getStoreForCrossProject()
				const toStore = toEngine.getStoreForCrossProject()
				const routeMatches = buildCrossProjectEdges(fromStore, pair.from.id, toStore, pair.to.id)
				const nameMatches = matchByName
					? buildCrossProjectEdgesBySymbolName(fromStore, pair.from.id, toStore, pair.to.id)
					: 0
				summary.push({ from: pair.from.id, to: pair.to.id, routeMatches, nameMatches })
			}

			if (json) {
				console.log(JSON.stringify(summary, null, 2))
			} else {
				for (const row of summary) {
					console.log(
						`${pc.cyan(row.from)} ↔ ${pc.cyan(row.to)}: ${pc.green(String(row.routeMatches))} route, ${pc.green(String(row.nameMatches))} name`,
					)
				}
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
