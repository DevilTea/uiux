import { configureServerNetwork, createLoopbackGuardHandler } from '../../src/server/loopback-guard'
import { createAccessGuardHandler } from '../../src/server/access/http'
import { setServerNetwork, startupLines } from '../../src/server/network-access'
import { getSelectedWorkspaceServerRuntime, resolveInternalServerOrigin } from '../../src/server/selected-workspace'

/**
 * The bind and origin policy of the live server (Feature 01a12500-a0a0-74c0-b83b-3dbb628689e4).
 *
 * - Startup: Nitro plugins run before the node-server entry reads `NITRO_HOST`, so
 *   `configureServerNetwork` settles the bind address and the configured origins here: from the
 *   internal `uiux dev` handoff only (then removed from the environment), never from
 *   `HOST`/`NITRO_HOST`. Without the handoff the server binds and accepts loopback only (Rule
 *   01a11485-ee85-7844-b82f-fd6a7cebb763). The node-server entry reads `NITRO_SSL_CERT`/
 *   `NITRO_SSL_KEY` before plugins run, so they are refused rather than dropped (Rule
 *   01a12500-bbed-7aaa-a9bf-869e5e09bd45), on a Unix domain socket too.
 * - Requests: the gate is placed ahead of every h3 layer, including Nitro's static asset
 *   middleware, so `/mcp`, `/api/*` and SPA assets all pass the same Host/Origin gate.
 * - Authentication runs right after the baseline gates: every `/api/*` and `/mcp` request
 *   resolves to one principal or gets 401; `/.well-known/*` is a JSON 404.
 */
export default defineNitroPlugin((nitroApp) => {
	const localSocket = Boolean(process.env.NITRO_UNIX_SOCKET)
	if (!import.meta.dev) {
		const network = configureServerNetwork(process.env, { localSocket })
		if (!network.ok) {
			console.error(`uiux: ${network.message}`)
			process.exit(2)
		}
		setServerNetwork(network.value)
		if (!localSocket) console.log(startupLines(resolveInternalServerOrigin(), network.value).join('\n'))
	}

	nitroApp.h3App.stack.unshift(
		{
			route: '',
			handler: createLoopbackGuardHandler({ anyPort: import.meta.dev, localSocket }),
		},
		{
			route: '',
			handler: createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()),
		},
	)
})
