import { resolve } from 'node:path'

import { acquireServerHold, type AcquiredServerHold } from '../../src/persistence/server-hold'
import {
	closeSelectedWorkspaceServerRuntime,
	getSelectedWorkspaceServerRuntime,
} from '../../src/server/selected-workspace'

export default defineNitroPlugin((nitroApp) => {
	let pendingHold: Promise<AcquiredServerHold | undefined> | undefined
	let acquiredHold: AcquiredServerHold | undefined
	if (process.env.UIUX_WORKSPACE_ROOT) {
		getSelectedWorkspaceServerRuntime()
		// A live server holds its selected Workspace so `uiux migrate` refuses to rewrite it underneath.
		if (!import.meta.prerender) {
			pendingHold = acquireServerHold(resolve(process.env.UIUX_WORKSPACE_ROOT))
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
