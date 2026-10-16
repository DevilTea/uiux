import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { bearer, provisionToken } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * A default Locale without its Locale file (issue #94) against the built server and a private copy
 * of the frozen fixture Workspace whose `i18n/en-US.json` is removed (`i18n.defaultLocale` stays
 * `en-US`; `zh-TW.json` remains, and never stands in for it, Rule 01a115cd-b24f-7bcd-acd8-6b00d0aceff2):
 *
 * - formal capture refuses every context over HTTP and MCP with `i18n.missing_default_locale`, and
 *   stores no Evidence, and the Product Kit capture checks do not run (Rule
 *   01a115cd-b30b-706e-b8a2-46e62259156e);
 * - Workspace settings and non-i18n View authoring stay usable (Rule 01a115cd-b33a-7c3e-ba1f-bed8759b67d6);
 * - the Preview reports a blocked state instead of rendering, and Checks shows the persistent error
 *   with a way to the create action (Rules 01a115cd-b2ad-7989-8faa-07d48bc8ee30, 01a115cd-b2dc-78a5-911b-a377bfcab278);
 * - once the file exists, the Preview renders and capture succeeds again.
 *
 * The tests run in order: the last one creates the file.
 */

let server: WorkbenchServer
let browser: Browser
let viewId: string

const MISSING = { code: 'i18n.missing_default_locale', path: '/i18n/en-US' }

type CaptureResult = Readonly<{ status: string; results: readonly Readonly<{ status: string; evidenceDigest?: string; diagnostics?: readonly Readonly<{ code: string; path: string }>[] }>[] }>

async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = server.headers): Promise<Response> {
	return await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
}

async function json<T>(response: Response): Promise<T> {
	return await response.json() as T
}

function contexts() {
	return [
		{ viewId, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1920, height: 1080 }, themeId: 'light' },
		{ viewId, locale: 'zh-TW', viewportId: 'mobile', viewport: { width: 390, height: 844 }, themeId: 'dark' },
	]
}

async function evidenceCount(): Promise<number> {
	return (await json<{ items: readonly unknown[] }>(await api(`/api/evidence/list?viewId=${viewId}`))).items.length
}

beforeAll(async () => {
	server = await startWorkbenchServer({
		prepare: async root => { await rm(join(root, 'i18n', 'en-US.json')) },
	})
	browser = await chromium.launch({ headless: true })
	const spec = { intent: 'Default Locale gate', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	const created = await api('/api/views', { name: 'Default Locale gate', spec })
	expect(created.ok).toBe(true)
	viewId = (await json<{ key: string }>(created)).key
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

async function previewFrame(page: Page): Promise<Frame> {
	const handle = await page.waitForSelector(`iframe[src*="/preview"][src*="viewId=${viewId}"]`, { timeout: 15_000 })
	return (await handle.contentFrame())!
}

describe('a default Locale without its Locale file', () => {
	it('refuses formal capture of every context over HTTP and MCP, and stores no Evidence', { timeout: 30_000 }, async () => {
		const http = await api('/api/evidence/capture', { contexts: contexts() })
		expect(http.status).toBe(422)
		const httpResult = await json<CaptureResult>(http)
		expect(httpResult.status).toBe('failed')
		expect(httpResult.results).toHaveLength(2)
		for (const result of httpResult.results) {
			expect(result.status).toBe('failed')
			expect(result.evidenceDigest).toBeUndefined()
			expect(result.diagnostics).toEqual([expect.objectContaining(MISSING)])
		}

		const agentToken = await provisionToken(server.workspaceRoot, { nickname: 'locale-gate-agent', kind: 'agent', role: 'editor' })
		const client = new Client({ name: 'missing-default-locale-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
		await client.connect(new StreamableHTTPClientTransport(new URL(`${server.origin}/mcp`), { requestInit: { headers: bearer(agentToken) } }))
		try {
			const tool = await client.callTool({ name: 'capture_formal_evidence', arguments: { contexts: contexts() } })
			expect(tool.isError).toBe(true)
			const structured = tool.structuredContent as CaptureResult
			expect(structured.status).toBe('failed')
			expect(structured.results.map(result => result.diagnostics)).toEqual([[expect.objectContaining(MISSING)], [expect.objectContaining(MISSING)]])
		}
		finally {
			await client.close()
		}
		expect(await evidenceCount()).toBe(0)
	})

	it('does not run the Product Kit capture checks', { timeout: 30_000 }, async () => {
		const response = await api('/api/product-kit/checks', {})
		expect(response.status).toBe(200)
		const result = await json<{ checks: Record<string, { state: string; diagnostics: readonly { code: string }[] }> }>(response)
		for (const check of ['repeat_capture', 'live_versus_fresh'] as const) {
			expect(result.checks[check]?.state).toBe('failed')
			expect(result.checks[check]?.diagnostics).toEqual([expect.objectContaining(MISSING)])
		}
	})

	it('keeps Workspace settings and non-i18n View authoring usable', async () => {
		const workspace = await json<{ revision: string; resource: Record<string, unknown> & { viewports: Record<string, { label: string }> } }>(await api('/api/resources/workspace/workspace'))
		const { i18n, themes, viewports } = workspace.resource
		const settings = await api('/api/workspace/settings', { expectedRevision: workspace.revision, settings: { i18n, themes, viewports: { ...viewports, desktop: { ...viewports.desktop!, label: 'Desktop (gate)' } } } }, 'PUT')
		expect(settings.status).toBe(200)

		const view = await json<{ revision: string; resource: { spec: Record<string, unknown> } }>(await api(`/api/resources/view/${viewId}`))
		// Decisions are recorded through promotion, not the spec operation.
		const { decisions: _decisions, ...authored } = view.resource.spec
		void _decisions
		const spec = await api(`/api/views/${viewId}/spec`, { expectedRevision: view.revision, spec: { ...authored, intent: 'Still authorable' } }, 'PUT')
		expect(spec.status, await spec.clone().text()).toBe(200)
	})

	it('blocks the Preview instead of rendering, and shows the persistent error in Checks', { timeout: 60_000 }, async () => {
		const canvas = await open(`/views/${viewId}`)
		try {
			const frame = await previewFrame(canvas.page)
			const blocked = frame.locator('[data-preview-status="blocked"]')
			await blocked.waitFor({ timeout: 15_000 })
			expect(await blocked.textContent()).toContain('i18n.missing_default_locale')
			expect(await frame.locator('[data-preview-ready="true"]').isVisible()).toBe(false)
			expect(await frame.locator('.preview-runtime-host').innerHTML()).toBe('')
		}
		finally { await canvas.context.close() }

		const checks = await open('/?tab=checks')
		try {
			const alert = checks.page.locator('[data-checks-persistent-error="i18n.missing_default_locale"]')
			await alert.waitFor({ timeout: 15_000 })
			expect(await alert.textContent()).toContain('en-US')

			// Run Checks lists it as an error of that Locale, and the alert stays.
			await checks.page.locator('[data-run-checks]').click()
			await checks.page.locator('[data-checks-tree]').getByText('i18n.missing_default_locale').waitFor({ timeout: 15_000 })
			expect(await alert.isVisible()).toBe(true)

			// The alert leads to the Locales page and its explicit create action.
			await alert.getByRole('button', { name: 'Open Locales' }).click()
			await checks.page.waitForURL(url => url.pathname === '/workspace/locales', { timeout: 15_000 })
			await checks.page.getByRole('button', { name: 'Create Locale' }).first().waitFor({ timeout: 15_000 })
		}
		finally { await checks.context.close() }
	})

	it('renders the Preview and captures again once the file exists', { timeout: 60_000 }, async () => {
		const created = await api('/api/locales', { locale: 'en-US', messages: {} })
		expect(created.ok, await created.clone().text()).toBe(true)

		const http = await api('/api/evidence/capture', { contexts: contexts().slice(0, 1) })
		const result = await json<CaptureResult>(http)
		expect(http.status, JSON.stringify(result)).toBe(200)
		expect(result.results[0]?.status).toBe('captured')
		expect(await evidenceCount()).toBe(1)

		const canvas = await open(`/views/${viewId}`)
		try {
			const frame = await previewFrame(canvas.page)
			await frame.waitForSelector('[data-preview-ready="true"]', { state: 'visible', timeout: 15_000 })
			expect(await frame.locator('[data-preview-status="blocked"]').count()).toBe(0)
		}
		finally { await canvas.context.close() }

		const checks = await open('/?tab=checks')
		try {
			await checks.page.locator('[data-run-checks]').waitFor()
			expect(await checks.page.locator('[data-checks-persistent-error]').count()).toBe(0)
		}
		finally { await checks.context.close() }
	})
})
