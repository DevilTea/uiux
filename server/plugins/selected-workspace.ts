import { resolve } from 'node:path'

import { checkGitWorkTree, gitRequiredMessage } from '../../src/persistence/git'
import { acquireServerHold, type AcquiredServerHold } from '../../src/persistence/server-hold'
import { checkWorkspaceSelection } from '../../src/persistence/workspace-selection'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../../src/product/workspace-schema'
import { AccessError } from '../../src/server/access/roster'
import { closeEventStreamsOnShutdown } from '../../src/server/event-stream'
import { writeUnredacted } from '../../src/server/access/redaction'
import { getServerNetwork } from '../../src/server/network-access'
import {
	closeSelectedWorkspaceServerRuntime,
	getSelectedWorkspaceServerRuntime,
	resolveInternalServerOrigin,
} from '../../src/server/selected-workspace'
import { diagnostics } from '../../src/logging/diagnostics'

export default defineNitroPlugin((nitroApp) => {
	let pendingHold: Promise<AcquiredServerHold | undefined> | undefined
	let acquiredHold: AcquiredServerHold | undefined
	if (process.env.UIUX_WORKSPACE_ROOT) {
		// The layout entry check runs before the runtime opens anything: no lock, hold or recovery yet.
		const selection = checkWorkspaceSelection(resolve(process.env.UIUX_WORKSPACE_ROOT), PRODUCT_WORKSPACE_SCHEMA_POLICY)
		if (!selection.ok) {
			diagnostics.error(`uiux: ${selection.message}`)
			process.exit(2)
		}
		// Git is required however the server was started (Clause 01a1ece9-97ec-736f-99a3-80b76efc800b): refused
		// before the runtime opens anything, so before any lock, hold or listener.
		const git = checkGitWorkTree(resolve(process.env.UIUX_WORKSPACE_ROOT))
		if (!git.ok) {
			diagnostics.error(`uiux: ${gitRequiredMessage(git.message)}`)
			process.exit(2)
		}
		const runtime = getSelectedWorkspaceServerRuntime()
		// A live server holds its selected Workspace so `uiux access copy` and `uiux artifacts gc`
		// refuse to run underneath it, and `uiux invite create` can name its port.
		if (!import.meta.prerender) {
			// The graceful shutdown waits for open connections before the `close` hook runs, and an
			// event stream never ends by itself: close the streams as soon as the signal arrives.
			// `nuxt dev` has no graceful shutdown, and a signal listener there would suppress Node's default exit.
			if (!import.meta.dev) closeEventStreamsOnShutdown(runtime.eventStreams)
			// Open (or create) this Workspace's host-local roster now: an unsafe or mismatched store
			// stops the server instead of failing every request, and a roster without a human Owner
			// bootstraps one and prints its one-time sign-in link (decision 8).
			void runtime.access()
				.then(async (access) => {
					const banner = await access.bootstrap([resolveInternalServerOrigin(), ...getServerNetwork().origins.map(origin => origin.origin)])
					if (banner) writeUnredacted(banner)
					if (access.store.paths) diagnostics.info(`uiux: access roster ${access.hint} for ${access.workspaceRoot} (${access.store.paths.file}).`)
				})
				.catch((error: unknown) => {
					diagnostics.error(`uiux: ${error instanceof AccessError ? error.message : `could not open the access store: ${error instanceof Error ? error.message : String(error)}`}`)
					process.exit(2)
				})
			pendingHold = acquireServerHold(resolve(process.env.UIUX_WORKSPACE_ROOT), { origin: resolveInternalServerOrigin(), layout: runtime.persistence.layout })
				.then((hold) => {
					acquiredHold = hold
					return hold
				})
				.catch((error: unknown) => {
					diagnostics.warn(`uiux: could not record the Workspace server hold: ${error instanceof Error ? error.message : String(error)}`)
					return undefined
				})
			process.once('exit', () => acquiredHold?.releaseSync())
			// The kit build (Rule 01a11bb1-9d90-79c0-a51d-44382359bb6b): one process for the Workspace, the
			// declared watch command or else the build command once. Its argument array is printed first.
			void runtime.kitBuild.start().catch((error: unknown) => {
				diagnostics.warn(`uiux: could not start the kit build: ${error instanceof Error ? error.message : String(error)}`)
			})
			process.once('exit', () => runtime.kitBuild.stopSync())
			// View thumbnails (Feature 01a19b99-c9ee-…): the worker runs with the server only, never in a formal capture or a CLI-only command.
			runtime.thumbnails.start()
		}
	}
	nitroApp.hooks.hook('close', async () => {
		await (await pendingHold)?.release()
		await closeSelectedWorkspaceServerRuntime()
	})
})
