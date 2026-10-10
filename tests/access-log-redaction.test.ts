import { afterEach, describe, expect, it, vi } from 'vitest'

import { generateCredential } from '../src/server/access/credentials'

// The console methods `installLogRedaction` patches on the server process.
const PATCHED_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
type PatchedMethod = typeof PATCHED_METHODS[number]

const originalConsole = new Map(PATCHED_METHODS.map(method => [method, console[method]] as const))

// `installLogRedaction` installs at most once per module instance, so each test loads a fresh copy.
async function loadRedaction() {
	vi.resetModules()
	return import('../src/server/access/redaction')
}

function captureConsole(): Map<PatchedMethod, unknown[][]> {
	const calls = new Map<PatchedMethod, unknown[][]>()
	for (const method of PATCHED_METHODS) {
		const sink: unknown[][] = []
		calls.set(method, sink)
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			sink.push(args)
		})
	}
	return calls
}

afterEach(() => {
	vi.restoreAllMocks()
	for (const [method, original] of originalConsole) console[method] = original
})

describe('log redaction', () => {
	it('redacts credentials, Authorization values and session cookies written through every patched console method', async () => {
		const token = generateCredential('token', 'k3x7').value
		const calls = captureConsole()
		const { installLogRedaction } = await loadRedaction()
		installLogRedaction()

		for (const method of PATCHED_METHODS) {
			console[method](
				`${method} Authorization: Bearer ${token}`,
				{ headers: { authorization: `Bearer ${token}` }, cookie: 'uiux_session_k3x7=abc123' },
				new Error(`rejected ${token}`),
				'plain text',
			)
		}

		for (const method of PATCHED_METHODS) {
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

	it('installs once, so a second call does not wrap the console again', async () => {
		captureConsole()
		const { installLogRedaction } = await loadRedaction()
		installLogRedaction()
		const wrapped = PATCHED_METHODS.map(method => console[method])
		installLogRedaction()
		expect(PATCHED_METHODS.map(method => console[method])).toEqual(wrapped)
	})

	it('writes the first-run sign-in banner to stdout without redaction, bypassing the patched console', async () => {
		const token = generateCredential('session', 'k3x7').value
		const calls = captureConsole()
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const { installLogRedaction, writeUnredacted } = await loadRedaction()
		installLogRedaction()

		writeUnredacted(['uiux: sign in as the Owner', `http://127.0.0.1:3000/login#${token}`])

		expect(write).toHaveBeenCalledTimes(1)
		expect(write).toHaveBeenCalledWith(`uiux: sign in as the Owner\nhttp://127.0.0.1:3000/login#${token}\n`)
		for (const method of PATCHED_METHODS) expect(calls.get(method)).toHaveLength(0)
	})
})
