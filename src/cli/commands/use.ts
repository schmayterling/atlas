import pc from 'picocolors'
import {
	getActiveProject,
	getProject,
	listProjects,
	setActiveProject,
} from '../../core/registry.js'

// `atlas use <id>` — set the active registered project. subsequent
// cli invocations without -p and mcp tool calls without a project
// argument will route to this project's engine.
//
// `atlas use --list` — show every registered project with the active
// one marked. equivalent to `atlas projects list` but adds the active
// marker and is easier to type when you just want to see state.
//
// `atlas use --clear` — unset the active project so the default falls
// back to first-registered.
export async function useCommand(
	arg: string | undefined,
	opts: { list?: boolean; clear?: boolean },
): Promise<void> {
	if (opts.list) {
		const projects = listProjects()
		if (projects.length === 0) {
			console.log(pc.dim('no projects registered; run `atlas projects add .`'))
			return
		}
		const activeId = getActiveProject()
		for (const p of projects) {
			const marker = p.id === activeId ? pc.green('*') : ' '
			console.log(`${marker} ${pc.bold(p.id)}  ${pc.dim(p.root)}`)
		}
		return
	}

	if (opts.clear) {
		setActiveProject(null)
		console.log('active project cleared; default resolution falls back to first-registered')
		return
	}

	if (!arg) {
		const activeId = getActiveProject()
		if (!activeId) {
			console.log(pc.dim('no active project set; use `atlas use <id>` or `atlas use --list`'))
			return
		}
		const entry = getProject(activeId)
		if (!entry) {
			console.log(
				pc.yellow(`active project "${activeId}" is not registered; run \`atlas use --clear\``),
			)
			return
		}
		console.log(`${pc.bold(entry.id)}  ${pc.dim(entry.root)}`)
		return
	}

	try {
		const entry = setActiveProject(arg)
		if (entry) {
			console.log(`active project: ${pc.bold(entry.id)}  ${pc.dim(entry.root)}`)
		}
	} catch (e) {
		console.error(pc.red(String(e instanceof Error ? e.message : e)))
		process.exit(1)
	}
}
