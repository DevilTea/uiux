import { resolve } from 'node:path'

import type { McpHttpHandler } from '@modelcontextprotocol/server'
import type { WorkspaceApplicationSession } from '../application/services/workspace-session'
import { createWorkspaceApplicationSession } from '../application/services/workspace-session'
import { createUiuxMcpHttpHandler } from '../mcp/server'
import { FileNativePersistence } from '../persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'

export type SelectedWorkspaceServerRuntime = Readonly<{
	root: string
	persistence: FileNativePersistence
	app: WorkspaceApplicationSession
	mcp: McpHttpHandler
	close(): Promise<void>
}>

let selectedRuntime: SelectedWorkspaceServerRuntime | undefined

export function createSelectedWorkspaceServerRuntime(root: string): SelectedWorkspaceServerRuntime {
	const selectedRoot = resolve(root)
	const persistence = new FileNativePersistence({
		root: selectedRoot,
		schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
	})
	const app = createWorkspaceApplicationSession(persistence)
	const mcp = createUiuxMcpHttpHandler(app)
	return Object.freeze({
		root: selectedRoot,
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
