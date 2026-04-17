import { listProjects, addProject, removeProject, linkProjects, getProjectLinks, getLinkedProjects, getProject } from '../../core/registry.js'
import { getOrCreateEngine } from '../../core/engine-pool.js'
import { buildCrossProjectEdges } from '../../core/queries/api-trace.js'
import { buildCrossProjectEdgesBySymbolName } from '../../core/queries/symbol-name-linker.js'
import pc from 'picocolors'

// subcommand actions. each is exported so the commander definition in
// src/cli/index.ts can attach it directly — flag parsing and input
// validation run through commander rather than the hand-rolled
// args.indexOf('--from') style the old dispatcher used. see #69.

export function projectsList(json: boolean) {
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
}

export function projectsAdd(root: string | undefined, name: string | undefined, json: boolean) {
	const project = addProject(root ?? process.cwd(), name)
	if (json) {
		console.log(JSON.stringify(project, null, 2))
	} else {
		console.log(`added project: ${pc.cyan(project.id)} (${project.root})`)
	}
}

export function projectsRemove(id: string, json: boolean) {
	const removed = removeProject(id)
	if (json) {
		console.log(JSON.stringify({ removed }))
	} else if (removed) {
		console.log(`removed project: ${id}`)
	} else {
		console.log(`project not found: ${id}`)
	}
}

export function projectsLink(from: string, to: string, json: boolean) {
	const linked = linkProjects(from, to)
	if (json) {
		console.log(JSON.stringify({ linked }))
	} else if (linked) {
		console.log(`linked: ${from} → ${to}`)
	} else {
		console.log('failed to link (project not found)')
	}
}

export function projectsBuildEdges(
	json: boolean,
	opts: { all?: boolean; from?: string; to?: string; matchByName?: boolean },
) {
	// commander enforces value-required for --from <id> / --to <id>, so
	// reaching this function with a bare `--from` that swallowed the
	// next flag is no longer possible.
	if ((opts.from && !opts.to) || (!opts.from && opts.to)) {
		console.error('--from and --to must be provided together')
		process.exit(1)
	}
	if (opts.from && opts.to && opts.from === opts.to) {
		console.error('--from and --to must differ; a project cannot be linked to itself')
		process.exit(1)
	}

	const pairs: Array<{ from: { id: string; root: string }; to: { id: string; root: string } }> = []
	if (opts.from && opts.to) {
		const fromProject = getProject(opts.from)
		const toProject = getProject(opts.to)
		if (!fromProject || !toProject) {
			console.error(
				`unknown project id(s): ${[!fromProject && opts.from, !toProject && opts.to].filter(Boolean).join(', ')}`,
			)
			process.exit(1)
		}
		pairs.push({ from: fromProject, to: toProject })
	} else if (opts.all) {
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
		console.error(
			'no project pairs to link. add `--all` for cartesian, link projects with `atlas projects link`, or pass `--from <id> --to <id>`.',
		)
		process.exit(1)
	}

	const summary: Array<{ from: string; to: string; routeMatches: number; nameMatches: number }> = []
	for (const pair of pairs) {
		const fromEngine = getOrCreateEngine(pair.from.id, pair.from.root)
		const toEngine = getOrCreateEngine(pair.to.id, pair.to.root)
		const fromStore = fromEngine.getStoreForCrossProject()
		const toStore = toEngine.getStoreForCrossProject()
		const routeMatches = buildCrossProjectEdges(fromStore, pair.from.id, toStore, pair.to.id)
		const nameMatches = opts.matchByName
			? buildCrossProjectEdgesBySymbolName(fromStore, pair.from.id, toStore, pair.to.id)
			: 0
		summary.push({ from: pair.from.id, to: pair.to.id, routeMatches, nameMatches })
	}

	if (json) {
		console.log(JSON.stringify(summary, null, 2))
		return
	}
	for (const row of summary) {
		console.log(
			`${pc.cyan(row.from)} ↔ ${pc.cyan(row.to)}: ${pc.green(String(row.routeMatches))} route, ${pc.green(String(row.nameMatches))} name`,
		)
	}
}

export function projectsClearEdges(ids: string[], json: boolean) {
	const projects = listProjects()
	const targets = ids.length > 0 ? projects.filter((p) => ids.includes(p.id)) : projects
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
		return
	}
	for (const row of summary) {
		console.log(
			`cleared ${pc.yellow(String(row.deleted))} cross-project edge${row.deleted === 1 ? '' : 's'} from ${pc.cyan(row.project)}`,
		)
	}
}
