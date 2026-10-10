import { resolve } from 'node:path'

import type { McpHttpHandler } from '@modelcontextprotocol/server'
import { createLeaseManager, type LeaseManager } from '../application/access/leases'
import { createHistoryRecorder, type HistoryRecorder } from '../application/services/history-recorder'
import type { WorkspaceApplicationSession } from '../application/services/workspace-session'
import { createWorkspaceApplicationSession } from '../application/services/workspace-session'
import { createUiuxMcpHttpHandler } from '../mcp/server'
import { formatOriginHost } from './loopback-guard'
import { FileNativePersistence } from '../persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'
import { AccessService } from './access/service'
import { AccessStore, resolveUiuxHome } from './access/store'
import { createHistoryStoreFactory, type HistoryStoreFactory } from './history-stores'

export type SelectedWorkspaceServerRuntime = Readonly<{
	root: string
	serverOrigin: string
	persistence: FileNativePersistence
	app: WorkspaceApplicationSession
	leases: LeaseManager
	/** The Workspace's roster and authentication, opened (and created if needed) once per process. */
	access(): Promise<AccessService>
	/** The Workspace's history stores, opened lazily. */
	history: HistoryStoreFactory
	/**
	 * The autosave recorder over those stores. The Nitro plugin starts it (start boundary, Baseline,
	 * pruning) and `close()` stops it.
	 */
	historyRecorder: HistoryRecorder
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

export function createSelectedWorkspaceServerRuntime(
	root: string,
	options?: { serverOrigin?: string; uiuxHome?: string },
): SelectedWorkspaceServerRuntime {
	const selectedRoot = resolve(root)
	const persistence = new FileNativePersistence({
		root: selectedRoot,
		schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
	})
	const serverOrigin = options?.serverOrigin ?? resolveInternalServerOrigin()
	const leases = createLeaseManager()
	let accessService: AccessService | undefined
	// The recorder writes these stores and version comparison reads them.
	const history = createHistoryStoreFactory({
		workspaceRoot: selectedRoot,
		persistence,
		home: () => options?.uiuxHome ?? resolveUiuxHome(),
	})
	const historyRecorder = createHistoryRecorder({ persistence, stores: () => history.open() })
	const app = createWorkspaceApplicationSession(persistence, {
		serverOrigin,
		// Formal capture loads Preview as the in-memory `system:capture` principal (cookie-scoped to the internal origin).
		captureCookie: () => accessService ? { name: accessService.cookieName, value: accessService.captureCredential } : undefined,
		history,
		// A Checkpoint first closes the open autosave and records outside changes (Rule 01a11a5e-00b9-7bf5-8005-9380a388afb8).
		historyBoundary: () => historyRecorder,
	})
	let pending: Promise<AccessService> | undefined
	function access(): Promise<AccessService> {
		pending ??= (async () => {
			const store = (await AccessStore.open({ workspaceRoot: selectedRoot, home: options?.uiuxHome ?? resolveUiuxHome(), create: true }))!
			accessService = new AccessService({ store, leases })
			return accessService
		})()
		return pending
	}
	const mcp = createUiuxMcpHttpHandler(app, { leases, history: historyRecorder })
	return Object.freeze({
		root: selectedRoot,
		serverOrigin,
		persistence,
		app,
		leases,
		access,
		history,
		historyRecorder,
		mcp,
		async close() {
			await historyRecorder.stop()
			await accessService?.flushUsage()
			await mcp.close()
		},
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
