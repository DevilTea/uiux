import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { bearer, provisionToken } from './support/access'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * Shutting the server down while a Workbench holds the change-event stream open (issue #69 review):
 * Nitro's graceful shutdown waits up to `NITRO_SHUTDOWN_TIMEOUT` (30 s) for open connections, and a
 * stream never ends by itself, so the server closes every stream as soon as the signal arrives. The
 * packaged server run directly (SIGTERM) and `uiux dev` (Ctrl+C, SIGINT, which it forwards) both
 * stop within about 2 seconds. Needs `pnpm build`.
 */
const REPOSITORY_ROOT = join(import.meta.dirname, '..')
const SHUTDOWN_BUDGET_MS = 2000

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function freePort(): Promise<number> {
	const probe = createServer()
	await new Promise<void>((resolve, reject) => {
		probe.once('error', reject)
		probe.listen(0, '127.0.0.1', () => resolve())
	})
	const address = probe.address()
	await new Promise<void>(resolve => probe.close(() => resolve()))
	if (!address || typeof address === 'string') throw new Error('Could not allocate a local port.')
	return address.port
}

async function start(mode: 'server' | 'cli'): Promise<{ child: ChildProcess; origin: string; token: string; output: () => string }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-shutdown-')))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	await writeCurrentWorkspace(root, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	const token = await provisionToken(root, { nickname: 'lead', kind: 'human', preset: 'owner' })
	const port = await freePort()
	const args = mode === 'server'
		? [join(REPOSITORY_ROOT, '.output', 'server', 'index.mjs')]
		: [join(REPOSITORY_ROOT, 'bin', 'uiux.mjs'), 'dev', '--workspace', root]
	const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), NITRO_PORT: String(port), ...(mode === 'server' ? { HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', UIUX_WORKSPACE_ROOT: root } : {}) }
	delete env.NITRO_SHUTDOWN_TIMEOUT
	delete env.NITRO_SHUTDOWN_DISABLED
	const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
	let output = ''
	child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
	child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
	cleanups.push(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise(resolve => child.once('exit', resolve))
			child.kill('SIGKILL')
			await exited
		}
	})
	const origin = `http://127.0.0.1:${port}`
	const deadline = Date.now() + 20_000
	for (;;) {
		if (child.exitCode !== null) throw new Error(`the server exited before becoming ready.\n${output}`)
		if (Date.now() > deadline) throw new Error(`the server did not become ready within 20 seconds.\n${output}`)
		try {
			if ((await fetch(`${origin}/api/health`)).ok) break
		}
		catch { /* not listening yet */ }
		await new Promise(resolve => setTimeout(resolve, 150))
	}
	return { child, origin, token, output: () => output }
}

/** Opens the stream, waits for its `hello`, and resolves `ended` once the connection ends either way. */
async function openStream(origin: string, token: string): Promise<{ ended: Promise<void>; close: () => void }> {
	const controller = new AbortController()
	const response = await fetch(`${origin}/api/events`, { headers: { accept: 'text/event-stream', ...bearer(token) }, signal: controller.signal })
	expect(response.status).toBe(200)
	const reader = response.body!.getReader()
	const decoder = new TextDecoder()
	let text = ''
	while (!text.includes('event: hello')) {
		const { value, done } = await reader.read()
		if (done) throw new Error('the stream ended before hello')
		text += decoder.decode(value, { stream: true })
	}
	const ended = (async () => {
		try {
			for (;;) if ((await reader.read()).done) return
		}
		catch { /* reset: also an end */ }
	})()
	return { ended, close: () => controller.abort() }
}

async function stopWithin(child: ChildProcess, signal: NodeJS.Signals): Promise<number> {
	const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
	const started = Date.now()
	child.kill(signal)
	await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 15_000))])
	return Date.now() - started
}

describe('shutdown with an open change-event stream', () => {
	it('the packaged server stops within about 2 s of SIGTERM, closing the stream', async () => {
		const server = await start('server')
		const stream = await openStream(server.origin, server.token)
		try {
			const elapsed = await stopWithin(server.child, 'SIGTERM')
			expect(elapsed, server.output()).toBeLessThan(SHUTDOWN_BUDGET_MS)
			await stream.ended
		}
		finally { stream.close() }
	}, 60_000)

	it('uiux dev stops within about 2 s of Ctrl+C (SIGINT), which it forwards to the server', async () => {
		const cli = await start('cli')
		const stream = await openStream(cli.origin, cli.token)
		try {
			const elapsed = await stopWithin(cli.child, 'SIGINT')
			expect(elapsed, cli.output()).toBeLessThan(SHUTDOWN_BUDGET_MS)
			expect(cli.child.exitCode).toBe(0)
			await stream.ended
		}
		finally { stream.close() }
	}, 60_000)
})
