import { startWebServer } from '../../web/server.js'

export async function serveCommand(projectRoot: string, opts: { port: number; open: boolean }) {
	await startWebServer(projectRoot, opts)
}
