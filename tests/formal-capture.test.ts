import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { chromium } from 'playwright'

import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createFormalCaptureService } from '../src/application/services/formal-capture'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { createUiuxMcpHttpHandler, principalAuthInfo } from '../src/mcp/server'
import { createLeaseManager } from '../src/application/access/leases'
import { AGENT_EDITOR, provisionToken, sessionCookieFor } from './support/access'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'

const temporaryRoots: string[] = []
const runningServers: ChildProcess[] = []

afterEach(async () => {
	for (const s of runningServers.splice(0)) {
		s.kill('SIGTERM')
	}
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function makeCounterAdapterSource(): string {
	return `
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
    return () => h('div', { class: 'real-counter', id: 'counter-container' }, [
      h('button', {
        id: 'increment-btn',
        onClick: () => { state.count.value += 1; },
      }, 'Increment'),
      h('span', { id: 'count-value' }, 'Count: ' + state.count.value),
    ]);
  }
});

export const manifest = {
  id: 'my-counter',
  apiVersion: '1',
  widgetPlugins: [counterPlugin],
  catalog: { widgets: { Counter: {} } },
  renderers: [{ type: 'Counter', component: CounterRenderer }],
  providers: [],
  styles: [],
  tokens: [],
};
`
}

async function createTestWorkspace(adapters: Array<{ moduleSpecifier: string; config?: unknown }> = []): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-capture-test-'))
	temporaryRoots.push(root)
	await mkdir(join(root, '.uiux'), { recursive: true })
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })

	const serverModules = join(process.cwd(), '.output/server/node_modules')
	const rootModules = join(process.cwd(), 'node_modules')
	const useServerModules = true

	const widgetCorePath = join(useServerModules ? serverModules : rootModules, '@deviltea', 'widget-core')
	const widgetVuePath = join(useServerModules ? serverModules : rootModules, '@deviltea', 'widget-vue')
	const vuePath = join(useServerModules ? serverModules : rootModules, 'vue')

	await symlink(widgetCorePath, join(root, 'node_modules', '@deviltea', 'widget-core')).catch(() => undefined)
	await symlink(widgetVuePath, join(root, 'node_modules', '@deviltea', 'widget-vue')).catch(() => undefined)
	await symlink(vuePath, join(root, 'node_modules', 'vue')).catch(() => undefined)

	await writeFile(join(root, '.uiux', 'workspace.json'), JSON.stringify({
		schemaVersion: 3,
		i18n: { defaultLocale: 'en-US' },
		adapters,
		viewports: {
			desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } },
			mobile: { label: 'Mobile', dimensions: { width: 375, height: 667 } },
		},
		themes: {
			light: { label: 'Light' },
			dark: { label: 'Dark' },
		},
	}))

	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	return { root, persistence }
}

async function startTestServer(workspaceRoot: string): Promise<{ url: string; close: () => void; token: string; cookie: { name: string; value: string }; headers: Record<string, string> }> {
	const token = await provisionToken(workspaceRoot, { nickname: 'tester', kind: 'human', role: 'owner' })
	const probe = createServer()
	await new Promise<void>((res, rej) => { probe.once('error', rej); probe.listen(0, '127.0.0.1', () => res()) })
	const address = probe.address() as AddressInfo
	const port = address.port
	await new Promise<void>((res, rej) => probe.close(err => err ? rej(err) : res()))

	const serverEntry = resolve(process.cwd(), '.output/server/index.mjs')
	const server = spawn(process.execPath, [serverEntry], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(port),
			NITRO_HOST: '127.0.0.1',
			NITRO_PORT: String(port),
			UIUX_WORKSPACE_ROOT: workspaceRoot,
			UIUX_PACKAGE_ROOT: process.cwd(),
		},
	})
	runningServers.push(server)

	let serverOutput = ''
	server.stdout?.setEncoding('utf8').on('data', chunk => { serverOutput += chunk })
	server.stderr?.setEncoding('utf8').on('data', chunk => { serverOutput += chunk })

	const baseUrl = `http://127.0.0.1:${port}`
	const deadline = Date.now() + 15_000
	let ready = false
	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(`Test Nitro server exited before becoming ready:\n${serverOutput}`)
		}
		try {
			const res = await fetch(`${baseUrl}/api/health`)
			if (res.status === 200) {
				ready = true
				break
			}
		}
		catch {
			await new Promise(r => setTimeout(r, 100))
		}
	}

	if (!ready) {
		throw new Error(`Test Nitro server timed out waiting for /api/health:\n${serverOutput}`)
	}

	const cookie = await sessionCookieFor(baseUrl, token)
	return {
		url: baseUrl,
		close: () => server.kill('SIGTERM'),
		token,
		cookie,
		headers: { cookie: `${cookie.name}=${cookie.value}` },
	}
}

const VIEW_COUNTER_ID = '11111111-1111-4111-8111-111111111111'

function createCounterView(): ViewResource {
	return {
		id: VIEW_COUNTER_ID,
		name: 'Interactive Counter View',
		feature: 'demo',
		ir: {
			type: 'RootShell',
			id: 'root',
			slots: {
				content: [{
					type: 'Counter',
					id: 'counter-1',
					props: {},
					bindings: {},
					events: {},
				}],
			},
		},
		variants: {
			alt: {
				description: 'Alternative variant',
				state: {},
			},
		},
		spec: {
			intent: 'Demonstrate interactive counter and fresh runtime proof.',
			entryConditions: [],
			interactionRules: [],
			constraints: [],
			accessibility: [],
			references: [],
			decisions: [],
		},
	}
}

describe('Formal capture service & fresh-runtime proof', () => {
	it('proves fresh isolated runtime: widget state mutated in page does not bleed into formal capture', { timeout: 30_000 }, async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		// Persist the view
		await persistence.views.create(VIEW_COUNTER_ID, createCounterView())

		// Start local server
		const server = await startTestServer(root)
		const serverUrl = server.url

		// 1. Manually launch a separate browser page and mutate the runtime state
		const browser = await chromium.launch({ headless: true })
		try {
			const dirtyContext = await browser.newContext()
			await dirtyContext.addCookies([{ ...server.cookie, url: serverUrl }])
			const dirtyPage = await dirtyContext.newPage()
			const previewUrl = `${serverUrl}/preview?viewId=${VIEW_COUNTER_ID}&locale=en-US&viewportId=desktop&themeId=light`
			await dirtyPage.goto(previewUrl, { waitUntil: 'load' })
			await dirtyPage.waitForSelector('[data-preview-status="ready"]', { timeout: 10_000 })

			// Check initial state is Count: 42
			const textInitial = await dirtyPage.locator('#count-value').innerText()
			expect(textInitial).toContain('42')

			// Mutate state multiple times
			await dirtyPage.click('#increment-btn')
			await dirtyPage.click('#increment-btn')
			await dirtyPage.click('#increment-btn')

			const textMutated = await dirtyPage.locator('#count-value').innerText()
			expect(textMutated).toContain('45')

			// Keep the dirty page open while formal capture executes!
			// 2. Execute Formal Capture via FormalCaptureService
			const formalService = createFormalCaptureService(persistence, { captureCookie: () => server.cookie })
			const context: ResolvedRenderContext = {
				viewId: VIEW_COUNTER_ID,
				locale: 'en-US',
				viewportId: 'desktop',
				viewport: { width: 1280, height: 800 },
				themeId: 'light',
			}

			const captureResult1 = await formalService.capture({
				contexts: [context],
				baseUrl: serverUrl,
			})

			expect(captureResult1.status).toBe('ok')
			expect(captureResult1.results).toHaveLength(1)
			const item1 = captureResult1.results[0]!
			expect(item1.status).toBe('captured')
			expect(item1.evidenceDigest).toBeDefined()
			expect(item1.screenshotDigest).toBeDefined()

			// 3. Mutate the dirty page even further
			await dirtyPage.click('#increment-btn')
			expect(await dirtyPage.locator('#count-value').innerText()).toContain('46')

			// 4. Run a second formal capture for the same context
			const captureResult2 = await formalService.capture({
				contexts: [context],
				baseUrl: serverUrl,
			})

			expect(captureResult2.status).toBe('ok')
			const item2 = captureResult2.results[0]!
			expect(item2.status).toBe('captured')

			// DETERMINISTIC PROOF:
			// Identical inputs in two independent runs yield the EXACT SAME screenshot and evidence digest!
			expect(item2.screenshotDigest).toBe(item1.screenshotDigest)
			expect(item2.evidenceDigest).toBe(item1.evidenceDigest)

			// Verify evidence record schema & fields in store
			const storedBytes = await persistence.artifacts.read(item1.evidenceDigest!)
			expect(storedBytes).toBeDefined()
			const evidenceRecord = JSON.parse(Buffer.from(storedBytes!).toString('utf8'))
			expect(evidenceRecord.schemaVersion).toBe(1)
			expect(evidenceRecord.kind).toBe('formal_capture')
			expect(evidenceRecord.artifactRefs).toContain(item1.screenshotDigest)
			expect(evidenceRecord.provenance.resources).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ identity: { type: 'view', id: VIEW_COUNTER_ID } }),
					expect.objectContaining({ identity: { type: 'workspace', id: 'workspace' } }),
				]),
			)
		}
		finally {
			await browser.close()
		}
	})

	it('produces new evidence digest when view revision or spec changes', { timeout: 30_000 }, async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createCounterView()
		await persistence.views.create(VIEW_COUNTER_ID, view)

		const server = await startTestServer(root)
		const serverUrl = server.url
		const formalService = createFormalCaptureService(persistence, { captureCookie: () => server.cookie })

		const context: ResolvedRenderContext = {
			viewId: VIEW_COUNTER_ID,
			locale: 'en-US',
			viewportId: 'desktop',
			viewport: { width: 1280, height: 800 },
			themeId: 'light',
		}

		const initialCapture = await formalService.capture({
			contexts: [context],
			baseUrl: serverUrl,
		})
		expect(initialCapture.status).toBe('ok')
		const initialEvidenceDigest = initialCapture.results[0]?.evidenceDigest

		// Update the view spec revision
		const inspected = await persistence.views.readInspected(VIEW_COUNTER_ID)
		const casResult = await persistence.views.compareAndSwap({
			key: VIEW_COUNTER_ID,
			expectedRevision: inspected!.revision,
			resource: {
				...inspected!.resource,
				spec: {
					...inspected!.resource.spec,
					intent: 'Updated intent for change detection.',
				},
			},
		})
		expect(casResult.ok).toBe(true)

		const secondCapture = await formalService.capture({
			contexts: [context],
			baseUrl: serverUrl,
		})
		expect(secondCapture.status).toBe('ok')
		const secondEvidenceDigest = secondCapture.results[0]?.evidenceDigest

		// Evidence digest must change because provenance resource revision changed
		expect(secondEvidenceDigest).not.toBe(initialEvidenceDigest)
	})

	it('fails closed with structured diagnostics and generates no artifact for invalid/unsupported contexts', async () => {
		const { persistence } = await createTestWorkspace()
		await persistence.views.create(VIEW_COUNTER_ID, createCounterView())
		const formalService = createFormalCaptureService(persistence)

		// 1. Invalid Viewport
		const invalidViewportContext: ResolvedRenderContext = {
			viewId: VIEW_COUNTER_ID,
			locale: 'en-US',
			viewportId: 'non-existent-viewport',
			viewport: { width: 100, height: 100 },
			themeId: 'light',
		}
		const res1 = await formalService.capture({ contexts: [invalidViewportContext] })
		expect(res1.status).toBe('failed')
		expect(res1.results[0]?.status).toBe('failed')
		expect(res1.results[0]?.evidenceDigest).toBeUndefined()
		expect(res1.results[0]?.screenshotDigest).toBeUndefined()
		expect(res1.results[0]?.diagnostics?.[0]?.code).toBe('render_context.unknown_viewport')

		// 2. Invalid Theme
		const invalidThemeContext: ResolvedRenderContext = {
			viewId: VIEW_COUNTER_ID,
			locale: 'en-US',
			viewportId: 'desktop',
			viewport: { width: 1280, height: 800 },
			themeId: 'neon-cyberpunk',
		}
		const res2 = await formalService.capture({ contexts: [invalidThemeContext] })
		expect(res2.status).toBe('failed')
		expect(res2.results[0]?.diagnostics?.[0]?.code).toBe('render_context.unknown_theme')

		// 3. Invalid Locale
		const invalidLocaleContext: ResolvedRenderContext = {
			viewId: VIEW_COUNTER_ID,
			locale: 'fr-FR',
			viewportId: 'desktop',
			viewport: { width: 1280, height: 800 },
			themeId: 'light',
		}
		const res3 = await formalService.capture({ contexts: [invalidLocaleContext] })
		expect(res3.status).toBe('failed')
		expect(res3.results[0]?.diagnostics?.[0]?.code).toBe('render_context.unknown_locale')

		// 4. Invalid Variant
		const invalidVariantContext: ResolvedRenderContext = {
			viewId: VIEW_COUNTER_ID,
			variantName: 'unauthored-variant',
			locale: 'en-US',
			viewportId: 'desktop',
			viewport: { width: 1280, height: 800 },
			themeId: 'light',
		}
		const res4 = await formalService.capture({ contexts: [invalidVariantContext] })
		expect(res4.status).toBe('failed')
		expect(res4.results[0]?.diagnostics?.[0]?.code).toBe('render_context.unknown_variant')

		// Ensure artifact store remains completely empty of evidence/screenshot artifacts
		const identities = await persistence.artifacts.listIdentities()
		expect(identities).toHaveLength(0)
	})

	it('provides context-scoped error isolation: successful contexts succeed even when another context fails', { timeout: 30_000 }, async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		await persistence.views.create(VIEW_COUNTER_ID, createCounterView())

		const server = await startTestServer(root)
		const serverUrl = server.url
		const formalService = createFormalCaptureService(persistence, { captureCookie: () => server.cookie })

		const validContext: ResolvedRenderContext = {
			viewId: VIEW_COUNTER_ID,
			locale: 'en-US',
			viewportId: 'desktop',
			viewport: { width: 1280, height: 800 },
			themeId: 'light',
		}
		const invalidContext: ResolvedRenderContext = {
			viewId: '99999999-9999-4999-8999-999999999999',
			locale: 'en-US',
			viewportId: 'desktop',
			viewport: { width: 1280, height: 800 },
			themeId: 'light',
		}

		const batchResult = await formalService.capture({
			contexts: [validContext, invalidContext],
			baseUrl: serverUrl,
		})

		expect(batchResult.status).toBe('incomplete')
		expect(batchResult.summary).toEqual({ total: 2, captured: 1, failed: 1 })
		expect(batchResult.results[0]?.status).toBe('captured')
		expect(batchResult.results[0]?.evidenceDigest).toBeDefined()
		expect(batchResult.results[1]?.status).toBe('failed')
		expect(batchResult.results[1]?.diagnostics?.[0]?.code).toBe('view.not_found')
	})

	it('serves immutable artifacts over HTTP with security headers and rejects invalid digests', async () => {
		const { root, persistence } = await createTestWorkspace()
		const testBytes = Buffer.from('fake png image bytes for test')
		const { identity: digest } = await persistence.artifacts.put(testBytes)

		const server = await startTestServer(root)
		const serverUrl = server.url

		// 1. Valid artifact download
		const validRes = await fetch(`${serverUrl}/api/artifacts/${digest}`, { headers: server.headers })
		expect(validRes.status).toBe(200)
		expect(validRes.headers.get('x-content-type-options')).toBe('nosniff')
		expect(validRes.headers.get('cache-control')).toContain('immutable')
		const fetchedBytes = Buffer.from(await validRes.arrayBuffer())
		expect(fetchedBytes).toEqual(testBytes)

		// 2. Malformed digest (path traversal attempt / invalid sha256)
		const maliciousRes = await fetch(`${serverUrl}/api/artifacts/${encodeURIComponent('../../etc/passwd')}`, { headers: server.headers })
		expect(maliciousRes.status).toBe(400)
		const invalidFormatRes = await fetch(`${serverUrl}/api/artifacts/not-a-valid-sha256-hash`, { headers: server.headers })
		expect(invalidFormatRes.status).toBe(400)

		// 3. Non-existent digest
		const fakeDigest = 'sha256:' + 'a'.repeat(64)
		const missingRes = await fetch(`${serverUrl}/api/artifacts/${fakeDigest}`, { headers: server.headers })
		expect(missingRes.status).toBe(404)
	})

	it('exposes capture_formal_evidence through MCP with structured outcome', { timeout: 30_000 }, async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		await persistence.views.create(VIEW_COUNTER_ID, createCounterView())

		const server = await startTestServer(root)
		const serverUrl = server.url
		const prevServerUrl = process.env.UIUX_SERVER_URL
		process.env.UIUX_SERVER_URL = serverUrl

		const app = createWorkspaceApplicationSession(persistence, { captureCookie: () => server.cookie })

		const handler = createUiuxMcpHttpHandler(app, { leases: createLeaseManager() })
		const client = new Client({ name: 'mcp-evidence-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
		const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/api/mcp`), {
			fetch: async (input, init) => handler.fetch(new Request(input, init), { authInfo: principalAuthInfo(AGENT_EDITOR) }),
		})
		await client.connect(transport)

		try {
			// Call MCP capture tool
			const toolResult = await client.callTool({
				name: 'capture_formal_evidence',
				arguments: {
					contexts: [{
						viewId: VIEW_COUNTER_ID,
						locale: 'en-US',
						viewportId: 'desktop',
						viewport: { width: 1280, height: 800 },
						themeId: 'light',
					}],
				},
			})

			expect(toolResult.isError).toBeFalsy()
			const structured = toolResult.structuredContent as { status: string; results: Array<{ status: string; evidenceDigest?: string }> }
			expect(structured.status).toBe('ok')
			expect(structured.results[0]?.status).toBe('captured')
			expect(structured.results[0]?.evidenceDigest).toBeDefined()
		}
		finally {
			if (prevServerUrl !== undefined) process.env.UIUX_SERVER_URL = prevServerUrl
			else delete process.env.UIUX_SERVER_URL
			await client.close()
			await handler.close()
		}
	})

	it('rejects hostile Host / X-Forwarded-Host: capture never sends requests to attacker origin', { timeout: 30_000 }, async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		await persistence.views.create(VIEW_COUNTER_ID, createCounterView())

		const server = await startTestServer(root)
		const serverUrl = server.url

		// Set up an attacker mock server to monitor if any SSRF request hits it
		const attackerRequests: string[] = []
		const attackerServer = createHttpServer((req, res) => {
			attackerRequests.push(`${req.method} ${req.url}`)
			res.writeHead(500, { 'Content-Type': 'text/plain' })
			res.end('attacker response')
		})

		await new Promise<void>((resolve) => attackerServer.listen(0, '127.0.0.1', () => resolve()))
		const attackerAddress = attackerServer.address() as AddressInfo
		const attackerOrigin = `http://127.0.0.1:${attackerAddress.port}`
		const attackerHost = `attacker.test:${attackerAddress.port}`

		try {
			// Issue capture request with hostile Host, X-Forwarded-Host, and hostile baseUrl in body
			const res = await fetch(`${serverUrl}/api/evidence/capture`, {
				method: 'POST',
				headers: {
					...server.headers,
					'Content-Type': 'application/json',
					'Host': attackerHost,
					'X-Forwarded-Host': attackerHost,
				},
				body: JSON.stringify({
					contexts: [{
						viewId: VIEW_COUNTER_ID,
						locale: 'en-US',
						viewportId: 'desktop',
						viewport: { width: 1280, height: 800 },
						themeId: 'light',
					}],
					baseUrl: attackerOrigin,
				}),
			})

			expect(res.status).toBe(200)
			const outcome = await res.json() as { status: string; results: Array<{ status: string }> }
			expect(outcome.status).toBe('ok')
			expect(outcome.results[0]?.status).toBe('captured')

			// Crucial security invariant: attacker origin must receive ZERO requests
			expect(attackerRequests).toHaveLength(0)
		}
		finally {
			attackerServer.close()
		}
	})
})
