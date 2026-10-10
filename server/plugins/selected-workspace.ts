import { resolve } from 'node:path'

import { acquireServerHold, type AcquiredServerHold } from '../../src/persistence/server-hold'
import { AccessError } from '../../src/server/access/roster'
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
		const runtime = getSelectedWorkspaceServerRuntime()
		// A live server holds its selected Workspace so `uiux migrate` refuses to rewrite it underneath.
		if (!import.meta.prerender) {
			// Secrets never appear in logs (identity decision 3).
			installLogRedaction()
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
		}
	}
	nitroApp.hooks.hook('close', async () => {
		await (await pendingHold)?.release()
		await closeSelectedWorkspaceServerRuntime()
	})
})
