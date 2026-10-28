import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { provisionToken, sessionCookieFor } from './access'

export type WorkbenchServer = Readonly<{
	origin: string
	workspaceRoot: string
	/** A human Owner's bearer token in the private Workspace copy's roster (test UIUX_HOME). */
	token: string
	/** That Owner's Workbench session cookie, for browsers and Workbench-only routes such as resolve. */
	cookie: Readonly<{ name: string; value: string }>
	/** `cookie` header value for `fetch`. */
	headers: Readonly<Record<string, string>>
	close: () => Promise<void>
	/** Stops the server process and starts a new one on the same port, Workspace and `UIUX_HOME`. */
	restart: () => Promise<void>
}>

const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..')
/**
 * Frozen snapshot of the dogfood Workspace the browser tests were written against (the
 * pre-Quiet-Canvas Workbench View, its Review threads, evidence and reference adapter). The live
 * `.uiux/` Workspace is authored freely through MCP, so tests must not depend on its contents.
 */
export const WORKBENCH_FIXTURE_WORKSPACE = join(REPOSITORY_ROOT, 'tests', 'fixtures', 'workbench-workspace')

async function freePort(): Promise<number> {
	const probe = createServer()
	await new Promise<void>((resolve, reject) => {
		probe.once('error', reject)
		probe.listen(0, '127.0.0.1', () => resolve())
	})
	const address = probe.address()
	await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
	if (!address || typeof address === 'string') throw new Error('Could not allocate a local port.')
	return address.port
}

/**
 * Starts the built Nitro server (`.output/server/index.mjs`, produced by `pnpm build`)
 * against a private copy of the frozen fixture Workspace. The copy lives under the
 * repository so its adapter resolves the repository's `@deviltea/widget-core`. `prepare`, when
 * given, changes the private copy before the server starts (a kit project for one test, say).
 */
export async function startWorkbenchServer(options: Readonly<{ prepare?: (workspaceRoot: string) => Promise<void> }> = {}): Promise<WorkbenchServer> {
	const workspaceRoot = await mkdtemp(join(REPOSITORY_ROOT, '.uiux-browser-test-'))
	let token: string
	try {
		// The frozen fixture is a current-schema Workspace (schemaVersion 7): its root holds
		// workspace.json, product-kit.json and access-presets.json, and its Adapter is in kit/. The
		// private copy is served as copied.
		await cp(WORKBENCH_FIXTURE_WORKSPACE, workspaceRoot, { recursive: true })
		await options.prepare?.(workspaceRoot)
		token = await provisionToken(workspaceRoot, { nickname: 'tester', kind: 'human', preset: 'owner' })
	}
	catch (error) {
		// A copy that never served leaves nothing behind in the repository.
		await rm(workspaceRoot, { recursive: true, force: true })
		throw error
	}
	const port = await freePort()
	const origin = `http://127.0.0.1:${port}`
	let output = ''

	function spawnServer(): ChildProcess {
		output = ''
		const serverProcess = spawn(process.execPath, [join(REPOSITORY_ROOT, '.output', 'server', 'index.mjs')], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				HOST: '127.0.0.1',
				PORT: String(port),
				NITRO_HOST: '127.0.0.1',
				NITRO_PORT: String(port),
				UIUX_WORKSPACE_ROOT: workspaceRoot,
			},
		})
		serverProcess.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
		serverProcess.stderr?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
		return serverProcess
	}
	let child = spawnServer()

	async function stop(): Promise<void> {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise(resolve => child.once('exit', resolve))
			child.kill('SIGTERM')
			await exited
		}
	}

	async function close(): Promise<void> {
		await stop()
		await rm(workspaceRoot, { recursive: true, force: true })
	}

	/** Waits until the current server process answers `/api/health`. */
	async function ready(): Promise<'ready' | 'exited' | 'timeout'> {
		const deadline = Date.now() + 20_000
		while (Date.now() < deadline) {
			if (child.exitCode !== null) return 'exited'
			try {
				const response = await fetch(`${origin}/api/health`)
				if (response.ok) return 'ready'
			}
			catch {
				// not listening yet
			}
			await new Promise(resolve => setTimeout(resolve, 150))
		}
		return 'timeout'
	}

	async function restart(): Promise<void> {
		await stop()
		child = spawnServer()
		const state = await ready()
		if (state !== 'ready') throw new Error(`Workbench server did not come back after a restart (${state}).\n${output}`)
	}

	const state = await ready()
	if (state === 'ready') {
		const cookie = await sessionCookieFor(origin, token)
		return { origin, workspaceRoot, token, cookie, headers: { cookie: `${cookie.name}=${cookie.value}` }, close, restart }
	}
	await close()
	throw new Error(state === 'exited'
		? `Workbench server exited before becoming ready.\n${output}`
		: `Workbench server did not become ready within 20 seconds.\n${output}`)
}
