import { inspect } from 'node:util'

import { redactCredentials } from './credentials'

let installed = false

/**
 * Secrets never appear in logs (decision 3): every console method of the server process passes
 * its output through credential redaction (credential-shaped strings, `Authorization` values and
 * `uiux_session_*` cookies). The one-time first-run sign-in link is written to stdout directly.
 */
export function installLogRedaction(target: Console = console): void {
	if (installed) return
	installed = true
	for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
		const original = target[method].bind(target)
		target[method] = (...args: unknown[]) => {
			original(...args.map(arg => typeof arg === 'string' ? redactCredentials(arg) : redactCredentials(inspect(arg, { depth: 6, breakLength: Infinity }))))
		}
	}
}

/** Writes lines to stdout without redaction (the first-run bootstrap banner carries a sign-in link by design). */
export function writeUnredacted(lines: readonly string[]): void {
	process.stdout.write(`${lines.join('\n')}\n`)
}
