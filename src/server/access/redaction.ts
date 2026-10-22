import { inspect } from 'node:util'

import { redactCredentials } from './credentials'

type ConsoleMethod = (...args: unknown[]) => void
type ConsoleMethods = Record<string, ConsoleMethod>

/** Methods whose arguments are all printed; each argument is redacted (strings as is, other values through `inspect`). */
const PRINTING_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dirxml', 'group', 'groupCollapsed', 'count', 'countReset', 'time', 'timeEnd'] as const
/** Methods that print, but whose first argument is not printed as is (a condition, a label that is not output verbatim, a data table or an object). */
const SPECIAL_METHODS = ['assert', 'timeLog', 'dir', 'table'] as const

/**
 * Console methods that never write caller-supplied data, and so are deliberately not patched:
 * `clear` and `groupEnd` print nothing, `profile`/`profileEnd`/`timeStamp` feed the inspector only,
 * `context` and `createTask` are inspector hooks, and `Console` is the constructor.
 */
export const EXEMPT_CONSOLE_METHODS = ['clear', 'groupEnd', 'profile', 'profileEnd', 'timeStamp', 'context', 'createTask', 'Console'] as const

/** Every console method {@link installLogRedaction} patches. */
export const PATCHED_CONSOLE_METHODS = [...PRINTING_METHODS, ...SPECIAL_METHODS] as const

const installations = new WeakMap<Console, () => void>()

function redactValue(value: unknown): string {
	return redactCredentials(typeof value === 'string' ? value : inspect(value, { depth: 6, breakLength: Infinity }))
}

/** Deep-copies plain data with every string redacted, keeping the shape `console.table` needs. */
function redactStructure(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === 'string') return redactCredentials(value)
	if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? redactValue(value) : value
	if (seen.has(value)) return '[Circular]'
	seen.add(value)
	if (Array.isArray(value)) return value.map(item => redactStructure(item, seen))
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return redactValue(value)
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactCredentials(key), redactStructure(item, seen)]))
}

/**
 * Secrets never appear in logs (decision 3): every console method of the server process that
 * writes output passes it through credential redaction (credential-shaped strings, `Authorization`
 * values and `uiux_session_*` cookies); {@link EXEMPT_CONSOLE_METHODS} write no caller data. The
 * one-time first-run sign-in link is written to stdout directly.
 *
 * Installing is idempotent per target. Returns a function that restores the original methods.
 */
export function installLogRedaction(target: Console = console): () => void {
	const existing = installations.get(target)
	if (existing) return existing
	const methods = target as unknown as ConsoleMethods
	const originals: ConsoleMethods = {}
	for (const name of PATCHED_CONSOLE_METHODS) originals[name] = methods[name]!
	const call = (name: string, ...args: unknown[]): void => originals[name]!.apply(target, args)
	const redactAll = (args: unknown[]): string[] => args.map(redactValue)

	for (const name of PRINTING_METHODS) methods[name] = (...args) => call(name, ...redactAll(args))
	methods.assert = (condition, ...args) => call('assert', condition, ...redactAll(args))
	methods.timeLog = (label, ...args) => call('timeLog', label === undefined ? label : redactValue(label), ...redactAll(args))
	methods.dir = object => call('log', redactValue(object))
	methods.table = (data, ...rest) => call('table', redactStructure(data), ...rest.map(item => Array.isArray(item) ? item.map(redactValue) : item))

	const uninstall = (): void => {
		for (const name of PATCHED_CONSOLE_METHODS) methods[name] = originals[name]!
		installations.delete(target)
	}
	installations.set(target, uninstall)
	return uninstall
}

/** Writes lines to stdout without redaction (the first-run bootstrap banner carries a sign-in link by design). */
export function writeUnredacted(lines: readonly string[]): void {
	process.stdout.write(`${lines.join('\n')}\n`)
}
