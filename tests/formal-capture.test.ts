import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { chromium } from 'playwright'

import { FileNativePersistence } from '../src/persistence'
import { CheckpointStore, referencedDigests } from '../src/persistence/history'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createFormalCaptureService } from '../src/application/services/formal-capture'
import { isCompleteEvidenceForRenderInput } from '../src/domain/evidence/staleness'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { createUiuxMcpHttpHandler, principalAuthInfo } from '../src/mcp/server'
import { createLeaseManager } from '../src/application/access/leases'
import { AGENT_EDITOR, provisionToken, sessionCookieFor } from './support/access'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import { writeCurrentWorkspace } from './support/workspace-layout'

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
  .state(s => s
    .count({ authorWritable: true, validate: (v) => typeof v === 'number', default: () => 42 })
    .internal({ validate: (v) => typeof v === 'number', default: () => 0 }))
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
};
`
}

async function createTestWorkspace(adapters: Array<{ moduleSpecifier: string; config?: unknown }> = []): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-capture-test-'))
	temporaryRoots.push(root)
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

	await writeCurrentWorkspace(root, {
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
	})

	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	// The default Locale's file: without it every capture is refused (Rule 01a115cd-b30b-706e-b8a2-46e62259156e).
	await persistence.locales.create('en-US', {})
	return { root, persistence }
}

async function startTestServer(workspaceRoot: string): Promise<{ url: string; close: () => void; token: string; cookie: { name: string; value: string }; headers: Record<string, string> }> {
	const token = await provisionToken(workspaceRoot, { nickname: 'tester', kind: 'human', preset: 'owner' })
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())
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

	// Rule 01a1144e-524c-7715-8fd8-d9ce46969cc6 (issue #119): an authored but invalid Variant is never
	// used, even partly, for formal capture, so no Review submission can cite Evidence of it.
	it('refuses to capture an authored invalid Variant and stores nothing for it, while other contexts still capture', { timeout: 60_000 }, async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		const view = createCounterView()
		await persistence.views.create(VIEW_COUNTER_ID, {
			...view,
			variants: {
				...view.variants,
				// Overrides an author-writable State member.
				filled: { state: { 'counter-1': { count: 7 } } },
				// One valid override next to an unknown State member: the valid half must not be applied either.
				unknownMember: { state: { 'counter-1': { count: 7, unknown: 3 } } },
				// Overrides a State member that is not author-writable.
				notWritable: { state: { 'counter-1': { internal: 3 } } },
			},
		})
		// The invalid Variants keep their authored data for repair.
		expect((await persistence.views.readInspected(VIEW_COUNTER_ID))?.resource.variants).toMatchObject({
			unknownMember: { state: { 'counter-1': { count: 7, unknown: 3 } } },
			notWritable: { state: { 'counter-1': { internal: 3 } } },
		})

		const server = await startTestServer(root)
		const formalService = createFormalCaptureService(persistence, { captureCookie: () => server.cookie })
		const base: ResolvedRenderContext = {
			viewId: VIEW_COUNTER_ID,
			locale: 'en-US',
			viewportId: 'desktop',
			viewport: { width: 1280, height: 800 },
			themeId: 'light',
		}

		const outcome = await formalService.capture({
			contexts: [
				{ ...base, variantName: 'unknownMember' },
				base,
				{ ...base, variantName: 'notWritable' },
				{ ...base, variantName: 'filled' },
			],
			baseUrl: server.url,
		})

		expect(outcome.status).toBe('incomplete')
		expect(outcome.summary).toEqual({ total: 4, captured: 2, failed: 2 })
		for (const index of [0, 2]) {
			const failed = outcome.results[index]!
			expect(failed.status).toBe('failed')
			expect(failed.diagnostics?.[0]).toMatchObject({ code: 'preview.runtime_failed', path: '/preview' })
			expect(failed.diagnostics?.[0]?.message).toContain('invalid')
			expect(failed.evidenceDigest).toBeUndefined()
			expect(failed.screenshotDigest).toBeUndefined()
			expect(failed.evidence).toBeUndefined()
		}
		const captured = [outcome.results[1]!, outcome.results[3]!]
		expect(captured.map(item => item.status)).toEqual(['captured', 'captured'])
		// The valid Variant renders its override, so it differs from the base context.
		expect(captured[1]!.screenshotDigest).not.toBe(captured[0]!.screenshotDigest)

		// Only the valid contexts' screenshots and Evidence records were stored. The server's history
		// also stores the Baseline Checkpoint's file blobs in this artifact store, from a start it does
		// not await before /api/health answers, so they can land before, during or after capture.
		// They are left out by digest. The store is listed before the Checkpoints, so a Baseline that
		// lands in between only adds digests to leave out, never a blob that is not left out.
		const stored = await persistence.artifacts.listIdentities()
		const historyBlobs = referencedDigests((await new CheckpointStore(persistence).list()).records.flatMap(record => record.resources))
		const added = stored.filter(identity => !historyBlobs.has(identity))
		expect(added.sort()).toEqual(captured.flatMap(item => [item.evidenceDigest!, item.screenshotDigest!]).sort())
		// No Evidence of either invalid Variant exists, so a ready-for-review submission has none to cite.
		const evidence = await formalService.listEvidence(VIEW_COUNTER_ID)
		expect(evidence.map(item => item.digest).sort()).toEqual(captured.map(item => item.evidenceDigest!).sort())
		expect(evidence.map(item => item.record.executionContext.variantName ?? null).sort()).toEqual(['filled', null])
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())
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

/**
 * Two Widget types whose Catalog maps the authoring field `title` to the result Property `titleResult`.
 * `Label` shows its text; `Hidden` renders nothing, so nothing ever reads its Properties while it is
 * on screen. A title key of `boom` makes the result Property throw, like an Adapter whose `t` fails.
 */
function makeTranslationAdapterSource(): string {
	return `
import { createWidgetPlugin, createWidgetValueContract } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';
import { useWidget } from '@deviltea/widget-vue';

const TRANSLATION_RESULT = createWidgetValueContract('deviltea.uiux/translation-result@1');
const STRING = createWidgetValueContract('deviltea.uiux/string@1');

function createPlugin(type) {
  return createWidgetPlugin(type)
    .interfaces()
    .config({
      schema: { type: 'object', properties: { titleKey: { type: 'string' } }, additionalProperties: false },
      validate: (input) => input === undefined || input === null || (typeof input === 'object' && !Array.isArray(input)),
      resolve: (raw) => ({ titleKey: raw?.titleKey ?? null }),
    })
    .properties(p => p
      .titleResult({
        valueContract: TRANSLATION_RESULT,
        registerDeps: ({ dep }) => ({ t: dep.root.methods.invoke('t').validate((value) => typeof value === 'object' && value !== null && typeof value.text === 'string') }),
        compute: ({ config, deps }) => {
          if (config.titleKey === null) return { text: '', warnings: [] };
          if (config.titleKey === 'boom') throw new Error('the Adapter t exploded');
          const translated = deps.t(config.titleKey, {});
          return translated.ok && translated.value ? translated.value : { text: '', warnings: [] };
        },
      })
      .title({
        valueContract: STRING,
        registerDeps: ({ dep }) => ({ result: dep.self.properties.get('titleResult') }),
        compute: ({ deps }) => {
          const result = deps.result();
          return result.ok && result.value ? result.value.text : '';
        },
      }))
    .done();
}

export const labelPlugin = createPlugin('Label');
export const hiddenPlugin = createPlugin('Hidden');

export const LabelRenderer = defineComponent({
  name: 'LabelRenderer',
  setup() {
    const { useProperties } = useWidget(labelPlugin);
    const properties = useProperties();
    return () => h('span', { class: 'translated-label' }, String(properties.title.value));
  },
});

export const HiddenRenderer = defineComponent({
  name: 'HiddenRenderer',
  setup() {
    return () => h('div', { style: 'display: none' });
  },
});

const fields = { title: { configField: 'titleKey', resultProperty: 'titleResult', textProperty: 'title' } };

export const manifest = {
  id: 'translation-fixture',
  apiVersion: '1',
  widgetPlugins: [labelPlugin, hiddenPlugin],
  catalog: { widgets: { Label: { i18n: { fields } }, Hidden: { i18n: { fields } } } },
  renderers: [
    { type: 'Label', component: LabelRenderer },
    { type: 'Hidden', component: HiddenRenderer },
  ],
  providers: [],
};
`
}

const VIEW_TRANSLATED_ID = '22222222-2222-4222-8222-222222222222'

function createTranslatedView(children: ReadonlyArray<{ id: string; type: 'Label' | 'Hidden'; key: string }>): ViewResource {
	return {
		...createCounterView(),
		id: VIEW_TRANSLATED_ID,
		name: 'Translated View',
		ir: {
			type: 'RootShell',
			id: 'root',
			slots: { content: children.map(child => ({ id: child.id, type: child.type, config: { title: { $i18n: child.key } } })) },
		} as never,
		variants: {},
	}
}

function translatedContext(locale: string): ResolvedRenderContext {
	return { viewId: VIEW_TRANSLATED_ID, locale, viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }
}

const translatedLocator = (widgetId: string) => ({ viewId: VIEW_TRANSLATED_ID, widgetId, resultProperty: 'titleResult', catalogField: 'title' })

describe('Formal capture records its translation Evidence (#96)', () => {
	async function translatedWorkspace(children: Parameters<typeof createTranslatedView>[0]) {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/translation.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'translation.mjs'), makeTranslationAdapterSource())
		// `createTestWorkspace` wrote an empty default Locale file; fill it.
		const defaultRevision = await persistence.locales.readRevision('en-US')
		const filled = await persistence.locales.compareAndSwap({ key: 'en-US', expectedRevision: defaultRevision!, resource: { greeting: 'Hello', farewell: 'Goodbye', onlyEnglish: 'Only in English' } })
		expect(filled.ok).toBe(true)
		await persistence.locales.create('zh-TW', { greeting: '哈囉', farewell: '再見' })
		await persistence.views.create(VIEW_TRANSLATED_ID, createTranslatedView(children))
		const server = await startTestServer(root)
		const service = createFormalCaptureService(persistence, { captureCookie: () => server.cookie })
		return { persistence, server, service }
	}

	it('evaluates every declared Property of a View, a hidden Widget and warnings included, in en-US and zh-TW', { timeout: 60_000 }, async () => {
		const { persistence, server, service } = await translatedWorkspace([
			{ id: 'a-greeting', type: 'Label', key: 'greeting' },
			{ id: 'b-hidden', type: 'Hidden', key: 'farewell' },
			{ id: 'c-english', type: 'Label', key: 'onlyEnglish' },
			{ id: 'd-unknown', type: 'Label', key: 'nowhere' },
		])
		const outcome = await service.capture({ contexts: [translatedContext('en-US'), translatedContext('zh-TW')], baseUrl: server.url })
		expect(outcome.status).toBe('ok')

		const records = await Promise.all(outcome.results.map(async (result) => {
			expect(result.status).toBe('captured')
			return JSON.parse(Buffer.from((await persistence.artifacts.read(result.evidenceDigest!))!).toString('utf8')) as {
				coverage: unknown
				data: { translations: unknown[] }
			}
		}))
		const [english, chinese] = records as [typeof records[number], typeof records[number]]

		// The hidden Widget's Property was read although nothing renders it, and a warning-free entry is recorded.
		expect(english.data.translations).toEqual([
			{ occurrence: translatedLocator('a-greeting'), evaluatedText: 'Hello', warnings: [] },
			{ occurrence: translatedLocator('b-hidden'), evaluatedText: 'Goodbye', warnings: [] },
			{ occurrence: translatedLocator('c-english'), evaluatedText: 'Only in English', warnings: [] },
			{
				occurrence: translatedLocator('d-unknown'),
				evaluatedText: '⟦missing:nowhere⟧',
				warnings: [{ code: 'unresolved-key', key: 'nowhere', requestedLocale: 'en-US' }],
			},
		])
		// Warnings are data: the coverage stays complete, so the capture still satisfies a submission.
		expect(english.coverage).toEqual({ complete: true, translations: { complete: true, evaluated: 4 } })

		expect(chinese.data.translations).toEqual([
			{ occurrence: translatedLocator('a-greeting'), evaluatedText: '哈囉', warnings: [] },
			{ occurrence: translatedLocator('b-hidden'), evaluatedText: '再見', warnings: [] },
			{
				occurrence: translatedLocator('c-english'),
				evaluatedText: 'Only in English',
				warnings: [{ code: 'missing-translation', key: 'onlyEnglish', requestedLocale: 'zh-TW', fallbackLocale: 'en-US' }],
			},
			{
				occurrence: translatedLocator('d-unknown'),
				evaluatedText: '⟦missing:nowhere⟧',
				warnings: [{ code: 'unresolved-key', key: 'nowhere', requestedLocale: 'zh-TW' }],
			},
		])
		expect(chinese.coverage).toEqual({ complete: true, translations: { complete: true, evaluated: 4 } })

		const listed = await service.listEvidence(VIEW_TRANSLATED_ID)
		const views = await service.viewRenderInputs()
		const digest = views.find(view => view.key === VIEW_TRANSLATED_ID)!.renderInputDigest
		for (const item of listed) expect(isCompleteEvidenceForRenderInput(item.record, VIEW_TRANSLATED_ID, digest)).toBe(true)
	})

	it('records incomplete coverage with the missing Property when an Adapter t throws, and keeps the other entries', { timeout: 60_000 }, async () => {
		const { persistence, server, service } = await translatedWorkspace([
			{ id: 'a-greeting', type: 'Label', key: 'greeting' },
			{ id: 'b-broken', type: 'Hidden', key: 'boom' },
		])
		const outcome = await service.capture({ contexts: [translatedContext('en-US')], baseUrl: server.url })
		const result = outcome.results[0]!
		expect(result.status).toBe('captured')
		const record = JSON.parse(Buffer.from((await persistence.artifacts.read(result.evidenceDigest!))!).toString('utf8')) as {
			coverage: { complete: boolean; translations: { complete: boolean; missing: Array<{ reason: string }> } }
			data: { translations: Array<{ occurrence: { widgetId: string } }> }
		}
		expect(record.data.translations.map(entry => entry.occurrence.widgetId)).toEqual(['a-greeting'])
		expect(record.coverage).toEqual({
			complete: false,
			translations: { complete: false, missing: [{ ...translatedLocator('b-broken'), reason: expect.stringContaining('the Adapter t exploded') }] },
		})

		// An incomplete record never satisfies a submission.
		const views = await service.viewRenderInputs()
		const digest = views.find(view => view.key === VIEW_TRANSLATED_ID)!.renderInputDigest
		const [item] = await service.listEvidence(VIEW_TRANSLATED_ID)
		expect(isCompleteEvidenceForRenderInput(item!.record, VIEW_TRANSLATED_ID, digest)).toBe(false)
	})
})
