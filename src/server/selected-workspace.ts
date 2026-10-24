import { resolve } from 'node:path'

import type { McpHttpHandler } from '@modelcontextprotocol/server'
import { createLeaseManager, type LeaseManager } from '../application/access/leases'
import { createChangeEventBus, publishCommits, publishLeaseChanges, type ChangeEventBus } from '../application/services/change-events'
import type { AdapterProvenanceSource } from '../application/services/adapter-provenance'
import { createHistoryRecorder, type HistoryRecorder } from '../application/services/history-recorder'
import type { WorkspaceApplicationSession } from '../application/services/workspace-session'
import { createWorkspaceApplicationSession } from '../application/services/workspace-session'
import { createUiuxMcpHttpHandler } from '../mcp/server'
import { formatOriginHost } from './loopback-guard'
import { FileNativePersistence } from '../persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'
import { AccessService } from './access/service'
import { AccessStore, resolveUiuxHome } from './access/store'
import { createWorkspaceAccessPresetsReader } from './access/workspace-presets'
import { createEventStreamHub, type EventStreamHub } from './event-stream'
import { createHistoryStoreFactory, type HistoryStoreFactory } from './history-stores'
import { createKitBuildRunner, registerKitBuildRunner, type KitBuildRunner } from './kit-build'
import { checkAdapterSetRuntime, getSelectedWorkspacePreviewBundle, pinnedAdapterContentDigest, resolveSelectedWorkspaceAdapterList, selectedWorkspaceThemeSupport } from './workspace-adapters'

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
	/**
	 * The change events of every committed write, lease change and roster change (Feature "Live
	 * refresh"), and the `GET /api/events` streams that carry them.
	 */
	events: ChangeEventBus
	eventStreams: EventStreamHub
	/**
	 * The kit build runner (Feature 01a11bb1-8534-7f0f-b8d0-de7efabe31f7). The Nitro plugin starts it
	 * under `uiux dev`; `close()` stops its process.
	 */
	kitBuild: KitBuildRunner
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
	// The Adapter provenance of a version or Checkpoint record follows the server's resolution and kit build (Rule 01a167bf-1f93-78b7-9045-6562c20f5a42); set once the kit build runner exists.
	const adapterProvenanceHolder: { source?: AdapterProvenanceSource } = {}
	const historyRecorder = createHistoryRecorder({ persistence, stores: () => history.open(), adapterProvenance: () => adapterProvenanceHolder.source })
	const kitBuild = createKitBuildRunner({
		root: selectedRoot,
		codeDirectoryName: persistence.layout.codeDir,
		// Each output generation is resolved and bundled as it settles, before a later build can change
		// its files (Rules 01a11bb1-9df8-762d-b5e5-306f9898aae2 and 01a11bb1-9e5e-79ab-841e-c953e8b44bbf).
		captureOutput: () => getSelectedWorkspacePreviewBundle(selectedRoot, persistence.layout),
	})
	const unregisterKitBuild = registerKitBuildRunner(selectedRoot, kitBuild)
	const adapterResolution = {
		resolve: (adapters: Parameters<typeof resolveSelectedWorkspaceAdapterList>[2]) => resolveSelectedWorkspaceAdapterList(selectedRoot, persistence.layout, adapters),
		pinnedContentDigest: pinnedAdapterContentDigest,
		outputGeneration: () => kitBuild.outputVersion(),
	}
	adapterProvenanceHolder.source = { ...adapterResolution, kitBuild: () => kitBuild.status() }
	const app = createWorkspaceApplicationSession(persistence, {
		serverOrigin,
		// Formal capture loads Preview as the in-memory `system:capture` principal (cookie-scoped to the internal origin).
		captureCookie: () => accessService ? { name: accessService.cookieName, value: accessService.captureCredential } : undefined,
		history,
		// A Checkpoint first closes the open autosave and records outside changes (Rule 01a11a5e-00b9-7bf5-8005-9380a388afb8).
		historyBoundary: () => historyRecorder,
		kitBuild,
		// Handoff refuses an Adapter set the Preview refuses (Clause 01a116f0-cae2-7c64-9c76-d472f252789a).
		checkAdapterSet: set => checkAdapterSetRuntime(selectedRoot, persistence.layout, set),
		// Formal capture refuses a theme the current Adapter resolution does not support (Rule 01a11add-f46d-7e92-8f5a-9d10dba6473d).
		adapterThemeSupport: () => selectedWorkspaceThemeSupport(selectedRoot, persistence.layout),
		// Formal capture, Evidence freshness and Handoff export resolve the Adapters as the Preview does (Rule 01a167bf-1f93-78b7-9045-6562c20f5a42).
		adapterResolution,
		// Review reads mark an actor whose member left the roster (Rule 01a11485-f185-7c23-8f2a-e045a279cd27).
		memberIds: async () => {
			const service = await access()
			await service.refresh()
			return new Set(service.roster().members.map(member => member.id))
		},
	})
	// Every committed write (HTTP and MCP alike) and every lease change becomes a change event.
	const events = createChangeEventBus()
	const stopCommitEvents = publishCommits(events, persistence)
	const stopLeaseEvents = publishLeaseChanges(events, leases)
	const eventStreams = createEventStreamHub({
		bus: events,
		credentialKeys: principal => accessService?.credentialKeys(principal),
		// Leases end lazily, and the CLI edits the roster on disk: look at both on every heartbeat,
		// so an expired lease and a roster change made outside this server still emit.
		onHeartbeat: async () => {
			leases.list()
			await accessService?.refresh()
		},
	})
	let pending: Promise<AccessService> | undefined
	function access(): Promise<AccessService> {
		pending ??= (async () => {
			const store = (await AccessStore.open({ workspaceRoot: selectedRoot, home: options?.uiuxHome ?? resolveUiuxHome(), create: true }))!
			accessService = new AccessService({ store, leases, presets: createWorkspaceAccessPresetsReader(selectedRoot, persistence.layout) })
			// A roster change emits `access.changed`; any access change re-checks the open streams.
			accessService.onChange((change) => {
				if (change.roster) events.publish({ type: 'access.changed' })
				eventStreams.revalidate()
			})
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
		events,
		eventStreams,
		kitBuild,
		async close() {
			eventStreams.close()
			stopCommitEvents()
			stopLeaseEvents()
			unregisterKitBuild()
			await kitBuild.stop()
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
