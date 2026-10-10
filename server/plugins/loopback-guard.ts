import {
	createLoopbackGuardHandler,
	resolveLoopbackBindHost,
} from '../../src/server/loopback-guard'
import { createAccessGuardHandler } from '../../src/server/access/http'
import { getSelectedWorkspaceServerRuntime } from '../../src/server/selected-workspace'

/**
 * Keeps the live single-user server loopback-only (Part 1 item 12).
 *
 * - Bind: `uiux dev` already selects a loopback address; this is the backstop for running
 *   `.output/server/index.mjs` directly. Nitro plugins run before the node-server entry reads
 *   `NITRO_HOST`, so an unset host defaults to 127.0.0.1, a loopback host is normalized and a
 *   non-loopback host is refused.
 * - Requests: the guard is placed ahead of every h3 layer, including Nitro's static asset
 *   middleware, so `/mcp`, `/api/*` and SPA assets all pass the same Host/Origin gate.
 * - Authentication (accepted identity decision 4) runs right after the baseline gates: every
 *   `/api/*` and `/mcp` request resolves to one principal or gets 401; `/.well-known/*` is a JSON 404.
 *
 * Prerendering has no live listener and is left untouched.
 */
export default defineNitroPlugin((nitroApp) => {
	if (import.meta.prerender) return

	if (!import.meta.dev && !process.env.NITRO_UNIX_SOCKET) {
		const bind = resolveLoopbackBindHost(process.env)
		if (!bind.ok) {
			console.error(`uiux: ${bind.message}`)
			process.exit(2)
		}
		process.env.NITRO_HOST = bind.host
	}

	nitroApp.h3App.stack.unshift(
		{
			route: '',
			handler: createLoopbackGuardHandler({ anyPort: import.meta.dev }),
		},
		{
			route: '',
			handler: createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()),
		},
	)
})
