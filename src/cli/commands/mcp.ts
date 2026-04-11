import { startMcpServer } from '../../mcp/server.js'

export async function mcpCommand(projectRoot: string) {
	await startMcpServer(projectRoot)
}
