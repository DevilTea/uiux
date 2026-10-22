import { Console } from 'node:console'
import { Writable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { diagnostics } from '../src/logging/diagnostics'
import { generateCredential } from '../src/server/access/credentials'
import { EXEMPT_CONSOLE_METHODS, installLogRedaction, PATCHED_CONSOLE_METHODS, writeUnredacted } from '../src/server/access/redaction'

// The console methods that print their arguments verbatim-ish, so a sink can compare them.
const SIMPLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
type SimpleMethod = typeof SIMPLE_METHODS[number]

const uninstallers: Array<() => void> = []

function install(target: Console = console): void {
	uninstallers.push(installLogRedaction(target))
}

function captureConsole(): Map<SimpleMethod, unknown[][]> {
	const calls = new Map<SimpleMethod, unknown[][]>()
	for (const method of SIMPLE_METHODS) {
		const sink: unknown[][] = []
		calls.set(method, sink)
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			sink.push(args)
		})
	}
	return calls
}

/** A real Console over an in-memory stream, so every method writes through its own implementation. */
function memoryConsole(): { target: Console, output: () => string } {
	let text = ''
	const stream = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done() } })
	return { target: new Console({ stdout: stream, stderr: stream }), output: () => text }
}

afterEach(() => {
	while (uninstallers.length) uninstallers.pop()!()
	vi.restoreAllMocks()
})

describe('log redaction', () => {
	it('redacts credentials, Authorization values and session cookies written through every simple console method', () => {
		const token = generateCredential('token', 'k3x7').value
		const calls = captureConsole()
		install()

		for (const method of SIMPLE_METHODS) {
			console[method](
				`${method} Authorization: Bearer ${token}`,
				{ headers: { authorization: `Bearer ${token}` }, cookie: 'uiux_session_k3x7=abc123' },
				new Error(`rejected ${token}`),
				'plain text',
			)
		}

		for (const method of SIMPLE_METHODS) {
			const written = calls.get(method)!
			expect(written).toHaveLength(1)
			const [text, object, error, plain] = written[0]!
			expect(text).toBe(`${method} Authorization: Bearer <redacted>`)
			expect(object).toEqual(expect.any(String))
			expect(object).not.toContain(token)
			expect(object).not.toContain('abc123')
			expect(object).toContain('uiux_session_k3x7=<redacted>')
			expect(error).toEqual(expect.any(String))
			expect(error).not.toContain(token)
			expect(error).toContain('rejected <redacted>')
			expect(plain).toBe('plain text')
		}
	})

	it('redacts a token written through the diagnostics logger', () => {
		const token = generateCredential('token', 'k3x7').value
		const calls = captureConsole()
		install()

		diagnostics.info(`info ${token}`)
		diagnostics.warn(`warn ${token}`)
		diagnostics.error(`error ${token}`)

		expect(calls.get('log')).toEqual([['info <redacted>']])
		expect(calls.get('warn')).toEqual([['warn <redacted>']])
		expect(calls.get('error')).toEqual([['error <redacted>']])
	})

	it('patches every output method of the Console prototype, or lists it as exempt', () => {
		const names = Object.getOwnPropertyNames(Object.getPrototypeOf(console)).filter(name => name !== 'constructor' && typeof (console as unknown as Record<string, unknown>)[name] === 'function')
		expect(names.length).toBeGreaterThan(0)
		const accounted = new Set<string>([...PATCHED_CONSOLE_METHODS, ...EXEMPT_CONSOLE_METHODS])
		expect(names.filter(name => !accounted.has(name))).toEqual([])
		expect(PATCHED_CONSOLE_METHODS.filter(name => !names.includes(name))).toEqual([])
	})

	it('redacts a token written through every patched method of a real Console', () => {
		const token = generateCredential('token', 'k3x7').value
		const { target, output } = memoryConsole()
		install(target)
		const t = target as unknown as Record<string, (...args: unknown[]) => void>

		for (const method of PATCHED_CONSOLE_METHODS) {
			if (method === 'table') target.table([{ secret: token }, { secret: `Authorization: Bearer ${token}` }])
			else if (method === 'assert') target.assert(false, token)
			else if (method === 'timeLog') {
				target.time(token)
				target.timeLog(token, token)
			}
			else t[method]!(token)
		}
		target.groupEnd()

		expect(output().length).toBeGreaterThan(0)
		expect(output()).not.toContain(token)
	})

	it('installs once per target and restores the original methods on uninstall', () => {
		const { target } = memoryConsole()
		const before = target.log
		const uninstall = installLogRedaction(target)
		const wrapped = target.log
		expect(wrapped).not.toBe(before)
		expect(installLogRedaction(target)).toBe(uninstall)
		expect(target.log).toBe(wrapped)
		uninstall()
		expect(target.log).toBe(before)
		const again = installLogRedaction(target)
		expect(target.log).not.toBe(before)
		again()
	})

	it('writes the first-run sign-in banner to stdout without redaction, bypassing the patched console', () => {
		const token = generateCredential('session', 'k3x7').value
		const calls = captureConsole()
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		install()

		writeUnredacted(['uiux: sign in as the Owner', `http://127.0.0.1:3000/login#${token}`])

		expect(write).toHaveBeenCalledTimes(1)
		expect(write).toHaveBeenCalledWith(`uiux: sign in as the Owner\nhttp://127.0.0.1:3000/login#${token}\n`)
		for (const method of SIMPLE_METHODS) expect(calls.get(method)).toHaveLength(0)
	})
})
