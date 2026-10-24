import { installLogRedaction } from '../../src/server/access/redaction'

/**
 * Secrets never appear in logs (Rule 01a11485-ed17-791a-a30e-1b63fa6f16ce, issue #290): the console
 * redaction is installed before any other Nitro plugin runs. Nitro loads `server/plugins/` in file
 * name order, so the `00-` prefix keeps this plugin ahead of `loopback-guard.ts` and
 * `selected-workspace.ts`, whose startup diagnostics (a refused Workspace selection, a refused
 * network configuration) are the first messages the server can log. `installLogRedaction` is
 * idempotent. A prerender writes no server logs and keeps the console as it is.
 */
export default defineNitroPlugin(() => {
	if (!import.meta.prerender) installLogRedaction()
})
