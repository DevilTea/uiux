import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { renderInputDigest } from '../src/domain/evidence/render-input-digest'
import type { ViewResource } from '../src/domain/views/schema'
import { FileNativePersistence } from '../src/persistence'
import { readActiveServerHold } from '../src/persistence/server-hold'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { provisionToken } from './support/access'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * `uiux evidence capture` against a real `uiux dev` server (the packaged Nitro server of `pnpm build`):
 * the command finds the server through the hold, signs in as a member with its Token, captures through
 * the shared capture service and leaves formal Evidence that the Workbench judges fresh (Rule
 * 01a115cd-c395-72b0-be67-4a77c4d2ade4, issue #466). The Token never leaves `UIUX_TOKEN`.
 */
const execute = promisify(execFile)
const CLI = resolve(process.cwd(), 'bin', 'uiux.mjs')
const VIEW = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []
const servers: ChildProcess[] = []

afterEach(async () => {
	for (const server of servers.splice(0)) server.kill('SIGTERM')
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const ADAPTER = `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';
import { useWidget } from '@deviltea/widget-vue';

export const counterPlugin = createWidgetPlugin('Counter')
  .interfaces()
  .state(s => s.count({ authorWritable: true, validate: (v) => typeof v === 'number', default: () => 42 }))
  .done();

export const CounterRenderer = defineComponent({
  name: 'CounterRenderer',
  setup() {
    const { useState } = useWidget(counterPlugin);
    const state = useState();
    return () => h('div', { id: 'counter-container' }, 'Count: ' + state.count.value);
  }
});

export const manifest = {
  id: 'my-counter',
  apiVersion: '1',
  widgetPlugins: [counterPlugin],
  catalog: { widgets: { Counter: {} } },
  renderers: [{ type: 'Counter', component: CounterRenderer }],
  providers: [],
};
`

function counterView(): ViewResource {
	return {
		id: VIEW,
		name: 'Counter',
		feature: 'demo',
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Counter', id: 'counter-1', props: {}, bindings: {}, events: {} }] } },
		variants: { alt: { state: {} } },
		spec: { intent: 'Count.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
	} as unknown as ViewResource
}

async function makeWorkspace(): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-cli-evidence-server-')))
	roots.push(root)
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })
	const modules = join(process.cwd(), '.output/server/node_modules')
	await symlink(join(modules, '@deviltea', 'widget-core'), join(root, 'node_modules', '@deviltea', 'widget-core'))
	await symlink(join(modules, '@deviltea', 'widget-vue'), join(root, 'node_modules', '@deviltea', 'widget-vue'))
	await symlink(join(modules, 'vue'), join(root, 'node_modules', 'vue'))
	await writeCurrentWorkspace(root, {
		i18n: { defaultLocale: 'en-US' },
		adapters: [{ moduleSpecifier: './adapters/counter.mjs' }],
		viewports: { desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } }, mobile: { label: 'Mobile', dimensions: { width: 375, height: 667 } } },
		themes: { light: { label: 'Light' }, dark: { label: 'Dark' } },
	})
	await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
	await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), ADAPTER)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.locales.create('en-US', {})
	await persistence.views.create(VIEW, counterView())
	return { root, persistence }
}

async function freePort(): Promise<number> {
	const probe = createServer()
	await new Promise<void>((done, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', () => done()) })
	const { port } = probe.address() as AddressInfo
	await new Promise<void>(done => probe.close(() => done()))
	return port
}

/** Starts the packaged server for `root` and waits until it answers and has recorded its hold. */
async function startServer(root: string, persistence: FileNativePersistence): Promise<{ origin: string }> {
	const port = await freePort()
	let output = ''
	const server = spawn(process.execPath, [resolve(process.cwd(), '.output/server/index.mjs')], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), UIUX_WORKSPACE_ROOT: root, UIUX_PACKAGE_ROOT: process.cwd() },
	})
	servers.push(server)
	server.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
	server.stderr?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
	const origin = `http://127.0.0.1:${port}`
	const deadline = Date.now() + 20_000
	for (;;) {
		if (server.exitCode !== null) throw new Error(`The test server exited before becoming ready:\n${output}`)
		if (Date.now() > deadline) throw new Error(`The test server was not ready in time:\n${output}`)
		try {
			if ((await fetch(`${origin}/api/health`)).ok && await readActiveServerHold(root, persistence.layout)) return { origin }
		}
		catch { /* not listening yet */ }
		await new Promise(resolveWait => setTimeout(resolveWait, 100))
	}
}

type Run = Readonly<{ code: number; stdout: string; stderr: string }>

/** `uiux evidence capture ...` through the real binary, with the Token only in the environment. */
async function capture(root: string, args: string[], token?: string): Promise<Run> {
	const env: NodeJS.ProcessEnv = { ...process.env }
	delete env.UIUX_TOKEN
	if (token !== undefined) env.UIUX_TOKEN = token
	try {
		const done = await execute(process.execPath, [CLI, 'evidence', 'capture', '--workspace', root, ...args], { env, cwd: root })
		return { code: 0, stdout: done.stdout, stderr: done.stderr }
	}
	catch (error) {
		const failure = error as { code: number; stdout: string; stderr: string }
		return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr }
	}
}

describe('uiux evidence capture against a running uiux dev server', () => {
	it('captures formal Evidence that is fresh for the View, finding the server through its hold', { timeout: 120_000 }, async () => {
		const { root, persistence } = await makeWorkspace()
		const { origin } = await startServer(root, persistence)
		const token = await provisionToken(root, { nickname: 'recapture', kind: 'agent', preset: 'editor' })

		const run = await capture(root, ['--view', VIEW, '--variant', 'alt', '--viewport', 'mobile', '--theme', 'dark', '--json'], token)
		expect(run.stderr).toBe('')
		expect(run.code).toBe(0)
		expect(run.stdout).not.toContain(token)
		const result = JSON.parse(run.stdout) as { status: string; results: { context: { variantName?: string; viewport: unknown }; status: string; evidenceDigest: string; screenshotDigest: string }[]; summary: unknown }
		expect(result.status).toBe('ok')
		expect(result.summary).toEqual({ total: 2, captured: 2, failed: 0 })
		expect(result.results.map(item => item.context.variantName)).toEqual([undefined, 'alt'])
		expect(result.results.every(item => item.status === 'captured' && item.context.viewport && JSON.stringify(item.context.viewport) === '{"width":375,"height":667}')).toBe(true)

		// The Evidence the Workbench lists is the one the command captured, recorded against the View as it is now.
		const listed = await (await fetch(`${origin}/api/evidence/list`, { headers: { authorization: `Bearer ${token}` } })).json() as {
			items: { digest: string; record: { executionContext: { viewId: string; variantName?: string; viewportId: string; themeId: string }; provenance: { renderInputDigest?: string } } }[]
		}
		const digests = result.results.map(item => item.evidenceDigest)
		const items = listed.items.filter(item => digests.includes(item.digest))
		expect(items).toHaveLength(2)
		expect(items.every(item => item.record.executionContext.viewId === VIEW && item.record.executionContext.viewportId === 'mobile' && item.record.executionContext.themeId === 'dark')).toBe(true)
		const view = (await persistence.views.readInspected(VIEW))!.resource!
		expect(items.every(item => item.record.provenance.renderInputDigest === renderInputDigest(view))).toBe(true)

		// The default text output: one line per context, then the count.
		const text = await capture(root, ['--view', VIEW, '--viewport', 'desktop', '--theme', 'light'], token)
		expect(text.code).toBe(0)
		const lines = text.stdout.trim().split('\n')
		expect(lines[0]).toMatch(new RegExp(`^captured\\t${VIEW}\\t-\\ten-US\\tdesktop\\tlight\\tsha256:[0-9a-f]{64}$`))
		expect(lines[1]).toBe('Captured 1 of 1 contexts, 0 failed.')
	})

	it('refuses a Token the server does not accept and a member without evidence.capture, capturing nothing', { timeout: 120_000 }, async () => {
		const { root, persistence } = await makeWorkspace()
		await startServer(root, persistence)
		const viewer = await provisionToken(root, { nickname: 'reader', kind: 'agent', preset: 'viewer' })
		const before = (await persistence.artifacts.readAllCandidateJson<unknown, unknown>({ select: value => value })).length

		const wrong = await capture(root, ['--view', VIEW], 'not-a-token-of-this-roster')
		expect(wrong.code).toBe(1)
		expect(wrong.stderr).toContain('did not accept the Token (401)')
		expect(wrong.stdout).toBe('')

		const denied = await capture(root, ['--view', VIEW, '--json'], viewer)
		expect(denied.code).toBe(1)
		expect(denied.stderr).toContain('(403)')
		expect(denied.stderr).toContain('evidence.capture')
		expect(denied.stdout).toBe('')
		for (const run of [wrong, denied]) expect(run.stderr).not.toContain(viewer)

		expect((await persistence.artifacts.readAllCandidateJson<unknown, unknown>({ select: value => value })).length).toBe(before)
	})

	it('exits 1 when no server runs for the Workspace, and when --origin names one that does not answer', { timeout: 60_000 }, async () => {
		const { root } = await makeWorkspace()
		const token = await provisionToken(root, { nickname: 'recapture', kind: 'agent', preset: 'editor' })
		const none = await capture(root, ['--view', VIEW], token)
		expect(none.code).toBe(1)
		expect(none.stderr).toContain('uiux dev')
		const closed = await capture(root, ['--view', VIEW, '--origin', `http://127.0.0.1:${await freePort()}`], token)
		expect(closed.code).toBe(1)
		expect(closed.stderr).toContain('no server answered')
		expect(closed.stderr).not.toContain(token)
	})
})
