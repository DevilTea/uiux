import { createLoopbackGuardHandler, resolveLoopbackBindHost } from '../../src/server/loopback-guard'
import { createAccessGuardHandler } from '../../src/server/access/http'
import {
	decodeDevHandoff,
	DEV_HANDOFF_VARIABLE,
	LOOPBACK_ONLY_NETWORK,
	resolveListenPort,
	setServerNetwork,
	startupLines,
	type NetworkConfig,
} from '../../src/server/network-access'
import { getSelectedWorkspaceServerRuntime, resolveInternalServerOrigin } from '../../src/server/selected-workspace'

/**
 * The bind and origin policy of the live server (Feature 01a12500-a0a0-74c0-b83b-3dbb628689e4).
 *
 * - Bind: Nitro plugins run before the node-server entry reads `NITRO_HOST`. Started by
 *   `uiux dev`, the server takes its bind address and configured origins from the internal
 *   handoff only, never from `HOST`/`NITRO_HOST`. Run directly, without the handoff, it binds
 *   loopback only and serves no configured origin (Rule 01a11485-ee85-7844-b82f-fd6a7cebb763):
 *   an unset host defaults to 127.0.0.1, a loopback host is normalized and any other host is
 *   refused.
 * - Transport: UIUX serves plain HTTP only (Rule 01a12500-bbed-7aaa-a9bf-869e5e09bd45). The
 *   node-server entry reads `NITRO_SSL_CERT`/`NITRO_SSL_KEY` before plugins run, so they are
 *   refused here rather than dropped.
 * - Requests: the gate is placed ahead of every h3 layer, including Nitro's static asset
 *   middleware, so `/mcp`, `/api/*` and SPA assets all pass the same Host/Origin gate.
 * - Authentication runs right after the baseline gates: every `/api/*` and `/mcp` request
 *   resolves to one principal or gets 401; `/.well-known/*` is a JSON 404.
 */
export default defineNitroPlugin((nitroApp) => {
	const refuse = (message: string): never => {
		console.error(`uiux: ${message}`)
		process.exit(2)
	}

	if (!import.meta.dev && !process.env.NITRO_UNIX_SOCKET) {
		if (process.env.NITRO_SSL_CERT || process.env.NITRO_SSL_KEY)
			refuse('NITRO_SSL_CERT and NITRO_SSL_KEY are not supported: UIUX serves plain HTTP only. Serve an https origin through a TLS-terminating front end and configure it with uiux dev --origin https://<host>.')
		let network: NetworkConfig = LOOPBACK_ONLY_NETWORK
		const handoff = process.env[DEV_HANDOFF_VARIABLE]
		if (handoff !== undefined) {
			const resolved = decodeDevHandoff(handoff, resolveListenPort(process.env))
			if (!resolved.ok) refuse(resolved.message)
			else network = resolved.value
		}
		else {
			const bind = resolveLoopbackBindHost(process.env)
			if (!bind.ok) refuse(bind.message)
			else network = { ...LOOPBACK_ONLY_NETWORK, bindHost: bind.host }
		}
		process.env.NITRO_HOST = network.bindHost
		setServerNetwork(network)
		console.log(startupLines(resolveInternalServerOrigin(), network).join('\n'))
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
