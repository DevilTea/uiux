import { resolve } from 'node:path'

import { acquireServerHold, type AcquiredServerHold } from '../../src/persistence/server-hold'
import { checkWorkspaceSelection } from '../../src/persistence/workspace-selection'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../../src/product/workspace-schema'
import { AccessError } from '../../src/server/access/roster'
import { closeEventStreamsOnShutdown } from '../../src/server/event-stream'
import { installLogRedaction, writeUnredacted } from '../../src/server/access/redaction'
import { getServerNetwork } from '../../src/server/network-access'
import {
	closeSelectedWorkspaceServerRuntime,
	getSelectedWorkspaceServerRuntime,
	resolveInternalServerOrigin,
} from '../../src/server/selected-workspace'

export default defineNitroPlugin((nitroApp) => {
	let pendingHold: Promise<AcquiredServerHold | undefined> | undefined
	let acquiredHold: AcquiredServerHold | undefined
	if (process.env.UIUX_WORKSPACE_ROOT) {
		// The layout entry check runs before the runtime opens anything: no lock, hold or recovery yet.
		const selection = checkWorkspaceSelection(resolve(process.env.UIUX_WORKSPACE_ROOT), PRODUCT_WORKSPACE_SCHEMA_POLICY)
		if (!selection.ok) {
			console.error(`uiux: ${selection.message}`)
			process.exit(2)
		}
		const runtime = getSelectedWorkspaceServerRuntime()
		// A live server holds its selected Workspace so `uiux access copy` refuses to copy host history
		// underneath it, and `uiux invite create` can name its port.
		if (!import.meta.prerender) {
			// Secrets never appear in logs (identity decision 3).
			installLogRedaction()
			// The graceful shutdown waits for open connections before the `close` hook runs, and an
			// event stream never ends by itself: close the streams as soon as the signal arrives.
			closeEventStreamsOnShutdown(runtime.eventStreams)
			// Open (or create) this Workspace's host-local roster now: an unsafe or mismatched store
			// stops the server instead of failing every request, and a roster without a human Owner
			// bootstraps one and prints its one-time sign-in link (decision 8).
			void runtime.access()
				.then(async (access) => {
					const banner = await access.bootstrap([resolveInternalServerOrigin(), ...getServerNetwork().origins.map(origin => origin.origin)])
					if (banner) writeUnredacted(banner)
					if (access.store.paths) console.log(`uiux: access roster ${access.hint} for ${access.workspaceRoot} (${access.store.paths.file}).`)
				})
				.catch((error: unknown) => {
					console.error(`uiux: ${error instanceof AccessError ? error.message : `could not open the access store: ${error instanceof Error ? error.message : String(error)}`}`)
					process.exit(2)
				})
			// Version history: close a leftover autosave, record changes made while no server ran,
			// write the Baseline on a host without history, prune, then record design writes. A
			// failure here is logged and never stops the server.
			void runtime.historyRecorder.start().then((report) => {
				if (report.baseline) console.log(`uiux: history recorded the Baseline Checkpoint ${report.baseline} for ${runtime.root}.`)
			})
			pendingHold = acquireServerHold(resolve(process.env.UIUX_WORKSPACE_ROOT), { origin: resolveInternalServerOrigin(), layout: runtime.persistence.layout })
				.then((hold) => {
					acquiredHold = hold
					return hold
				})
				.catch((error: unknown) => {
					console.warn(`uiux: could not record the Workspace server hold: ${error instanceof Error ? error.message : String(error)}`)
					return undefined
				})
			process.once('exit', () => acquiredHold?.releaseSync())
			// The kit build (Rule 01a11bb1-9d90-79c0-a51d-44382359bb6b): one process for the Workspace, the
			// declared watch command or else the build command once. Its argument array is printed first.
			void runtime.kitBuild.start().catch((error: unknown) => {
				console.warn(`uiux: could not start the kit build: ${error instanceof Error ? error.message : String(error)}`)
			})
			process.once('exit', () => runtime.kitBuild.stopSync())
		}
	}
	nitroApp.hooks.hook('close', async () => {
		await (await pendingHold)?.release()
		await closeSelectedWorkspaceServerRuntime()
	})
})
