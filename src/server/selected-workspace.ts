import { resolve } from 'node:path'

import type { McpHttpHandler } from '@modelcontextprotocol/server'
import type { WorkspaceApplicationSession } from '../application/services/workspace-session'
import { createWorkspaceApplicationSession } from '../application/services/workspace-session'
import { createUiuxMcpHttpHandler } from '../mcp/server'
import { formatOriginHost } from './loopback-guard'
import { FileNativePersistence } from '../persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'

export type SelectedWorkspaceServerRuntime = Readonly<{
	root: string
	serverOrigin: string
	persistence: FileNativePersistence
	app: WorkspaceApplicationSession
	mcp: McpHttpHandler
	close(): Promise<void>
}>

let selectedRuntime: SelectedWorkspaceServerRuntime | undefined
let configuredServerOrigin: string | undefined

export function setInternalServerOrigin(origin: string): void {
	configuredServerOrigin = origin
}

export function resolveInternalServerOrigin(): string {
	if (configuredServerOrigin) return configuredServerOrigin
	if (process.env.UIUX_SERVER_ORIGIN) return process.env.UIUX_SERVER_ORIGIN
	const port = process.env.NITRO_PORT || process.env.PORT || '3000'
	const host = process.env.NITRO_HOST || process.env.HOST || '127.0.0.1'
	const normalizedHost = (host === '0.0.0.0' || host === '::' || host === '') ? '127.0.0.1' : host
	return `http://${formatOriginHost(normalizedHost)}:${port}`
}

export function createSelectedWorkspaceServerRuntime(root: string, options?: { serverOrigin?: string }): SelectedWorkspaceServerRuntime {
	const selectedRoot = resolve(root)
	const persistence = new FileNativePersistence({
		root: selectedRoot,
		schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
	})
	const serverOrigin = options?.serverOrigin ?? resolveInternalServerOrigin()
	const app = createWorkspaceApplicationSession(persistence, { serverOrigin })
	const mcp = createUiuxMcpHttpHandler(app)
	return Object.freeze({
		root: selectedRoot,
		serverOrigin,
		persistence,
		app,
		mcp,
		async close() { await mcp.close() },
	})
}

/**
 * Process-wide composition root for the one Workspace explicitly selected by the CLI dev command.
 * The environment variable is internal CLI-to-Nitro plumbing, not persisted configuration.
 */
export function getSelectedWorkspaceServerRuntime(): SelectedWorkspaceServerRuntime {
	const configuredRoot = process.env.UIUX_WORKSPACE_ROOT
	if (!configuredRoot)
		throw new Error('UIUX_WORKSPACE_ROOT is required for selected-Workspace server routes. Start the server with uiux dev --workspace <dir>.')
	const selectedRoot = resolve(configuredRoot)
	if (selectedRuntime && selectedRuntime.root !== selectedRoot)
		throw new Error('A UIUX server process cannot switch its selected Workspace root after startup.')
	selectedRuntime ??= createSelectedWorkspaceServerRuntime(selectedRoot)
	return selectedRuntime
}

export async function closeSelectedWorkspaceServerRuntime(): Promise<void> {
	const runtime = selectedRuntime
	selectedRuntime = undefined
	if (runtime) await runtime.close()
}
