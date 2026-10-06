import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { FileNativePersistence } from '../../src/persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../../src/product/workspace-schema'
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
}>

const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..')
/**
 * Frozen snapshot of the dogfood Workspace the browser tests were written against (the
 * pre-Quiet-Canvas Workbench View, its Review threads, evidence and reference adapter). The live
 * `design/` Workspace is authored freely through MCP, so tests must not depend on its contents.
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
 * repository so its adapter resolves the repository's `@deviltea/widget-core`.
 */
export async function startWorkbenchServer(): Promise<WorkbenchServer> {
	const workspaceRoot = await mkdtemp(join(REPOSITORY_ROOT, '.uiux-browser-test-'))
	await cp(WORKBENCH_FIXTURE_WORKSPACE, workspaceRoot, { recursive: true })
	// The frozen fixture stays at the schemaVersion it was captured at; the private copy is migrated
	// to the current product schema the way an operator would (`uiux migrate`), never hand-edited.
	await new FileNativePersistence({ root: workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).migrateWorkspace()
	const token = await provisionToken(workspaceRoot, { nickname: 'tester', kind: 'human', role: 'owner' })
	const port = await freePort()
	const child: ChildProcess = spawn(process.execPath, [join(REPOSITORY_ROOT, '.output', 'server', 'index.mjs')], {
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
	let output = ''
	child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
	child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
	const origin = `http://127.0.0.1:${port}`

	async function close(): Promise<void> {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise(resolve => child.once('exit', resolve))
			child.kill('SIGTERM')
			await exited
		}
		await rm(workspaceRoot, { recursive: true, force: true })
	}

	const deadline = Date.now() + 20_000
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			await close()
			throw new Error(`Workbench server exited before becoming ready.\n${output}`)
		}
		try {
			const response = await fetch(`${origin}/api/health`)
			if (response.ok) {
				const cookie = await sessionCookieFor(origin, token)
				return { origin, workspaceRoot, token, cookie, headers: { cookie: `${cookie.name}=${cookie.value}` }, close }
			}
		}
		catch {
			// not listening yet
		}
		await new Promise(resolve => setTimeout(resolve, 150))
	}
	await close()
	throw new Error(`Workbench server did not become ready within 20 seconds.\n${output}`)
}
