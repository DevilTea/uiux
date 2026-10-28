import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { createSpecClient } from '@deviltea/spec-tool'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Requirement references in the Workbench (Feature 01a18120-f2dd-72a2-bc50-cea327cf1b4d), against the
 * built Workbench and a private copy of the fixture Workspace inside this repository's Git work tree:
 * the Overview Requirements tab (only with a `spec` provider, view-only), and the references on the
 * View page's Spec and on a UX Flow's page.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const FLOW_ID = 'de4668fc-aa5b-4a1d-ac44-ab134f858a55'
const VARIANT = 'error-state'
const UNKNOWN_ID = 'not-a-rule-of-the-source'

let server: WorkbenchServer
let browser: Browser
let specRoot = ''
/** The five Rules of the temporary Spec Tool workspace: via the View, via a Variant, via the Flow, unreferenced and `noUi`. */
let rules: readonly string[] = []

// A fixture file is patched member by member.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>

async function patchJson(path: string, mutate: (json: Loose) => void): Promise<void> {
	const json = JSON.parse(await readFile(path, 'utf8')) as Loose
	mutate(json)
	await writeFile(path, `${JSON.stringify(json)}\n`)
}

async function specWorkspace(root: string, count: number): Promise<readonly string[]> {
	await mkdir(root, { recursive: true })
	const client = createSpecClient(root)
	let response = await client.workspace.init()
	response = await client.feature.create({ expectedRevision: response.revision, title: 'Feature', summary: 'A feature.' })
	const feature = response.changedNodes[0]!.id
	const ids: string[] = []
	for (let index = 1; index <= count; index++) {
		response = await client.rule.create({ expectedRevision: response.revision, ownerId: feature, statement: `Rule ${index} states one behavior.` })
		ids.push(response.changedNodes.find(node => node.kind === 'rule')!.id)
	}
	return ids
}

beforeAll(async () => {
	server = await startWorkbenchServer({
		prepare: async (workspaceRoot) => {
			// A sibling of the private Workspace copy, so it lies in the same Git work tree.
			specRoot = `${workspaceRoot}-spec`
			rules = await specWorkspace(specRoot, 5)
			await patchJson(join(workspaceRoot, 'workspace.json'), (manifest) => {
				manifest.requirements = { provider: 'spec', path: `../${basename(specRoot)}`, noUi: { [rules[4]!]: 'Telemetry only; nothing to show.' } }
			})
			await patchJson(join(workspaceRoot, 'views', `${VIEW_ID}.view.json`), (view) => {
				view.spec.requirements = [rules[0], UNKNOWN_ID]
				view.variants[VARIANT] = { state: {}, requirements: [rules[1]] }
			})
			await patchJson(join(workspaceRoot, 'flows', `${FLOW_ID}.flow.json`), (flow) => { flow.requirements = [rules[2]] })
		},
	})
	browser = await chromium.launch({ headless: true })
}, 90_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
	if (specRoot) await rm(specRoot, { recursive: true, force: true })
})

async function open(path: string, locale = 'en-US', width = 1920, height = 1080): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' })
	await context.addInitScript((chosen: string) => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', chosen)
		localStorage.setItem('uiux.workbench.rightPanelHidden', '0')
	}, locale)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

describe('Overview Requirements tab (Rule 01a18120-feff-713c-b556-6511fad1a0d5)', () => {
	it('lists each requirement as referenced, unreferenced or noUi, the unresolved IDs and the coverage, linked to what references them', async () => {
		const { context, page } = await open('/?tab=requirements')
		try {
			const tab = page.locator('[data-overview-requirements]')
			await tab.waitFor()
			// Three of the four requirements outside noUi are referenced (View, Variant, Flow).
			await expect.poll(() => tab.locator('[data-requirements-coverage]').innerText()).toContain('Coverage 75% · 3 of 4 requirements referenced')

			const row = (id: string) => tab.locator(`[data-requirement="${id}"]`)
			await expect.poll(() => row(rules[0]!).getAttribute('data-requirement-state')).toBe('referenced')
			expect(await row(rules[0]!).innerText()).toContain('Rule 1 states one behavior.')
			expect(await row(rules[1]!).getAttribute('data-requirement-state')).toBe('referenced')
			expect(await row(rules[2]!).getAttribute('data-requirement-state')).toBe('referenced')
			expect(await row(rules[3]!).getAttribute('data-requirement-state')).toBe('unreferenced')
			expect(await row(rules[4]!).getAttribute('data-requirement-state')).toBe('noUi')
			expect(await row(rules[4]!).locator('[data-requirement-reason]').innerText()).toContain('Telemetry only; nothing to show.')

			// Each referenced requirement links to the resource that references it, the Variant behind a Variant reference included.
			expect(await row(rules[0]!).locator('[data-requirement-referrer]').first().getAttribute('href')).toContain(`/views/${VIEW_ID}`)
			const variantLink = row(rules[1]!).locator('[data-requirement-referrer]').first()
			expect(await variantLink.innerText()).toContain(VARIANT)
			expect(await variantLink.getAttribute('href')).toContain(`variant=${VARIANT}`)
			expect(await row(rules[2]!).locator('[data-requirement-referrer]').first().getAttribute('href')).toContain(`/flows/${FLOW_ID}`)

			// An ID the provider lacks is listed as unresolved, and stays linked to its View.
			const unresolved = tab.locator(`[data-requirement-unresolved="${UNKNOWN_ID}"]`)
			await unresolved.waitFor()
			expect(await unresolved.locator('a').first().getAttribute('href')).toContain(`/views/${VIEW_ID}`)

			// Filtering shows one state; the Workbench offers no editor for references.
			await tab.locator('[data-requirements-filter="unreferenced"]').click()
			await expect.poll(() => tab.locator('[data-requirements-list] > li').count()).toBe(1)
			expect(await tab.locator('input, textarea, [contenteditable="true"]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('is read by an Agent as the same coverage: GET /api/requirements', async () => {
		const response = await fetch(`${server.origin}/api/requirements`, { headers: server.headers })
		expect(response.status).toBe(200)
		const coverage = await response.json() as { status: string; counts: Record<string, number> }
		expect(coverage.status).toBe('ok')
		expect(coverage.counts).toEqual({ referenced: 3, unreferenced: 1, noUi: 1, unresolved: 1, unverified: 0 })
	})

	it('names the tab in Taiwan Traditional Chinese', async () => {
		const { context, page } = await open('/?tab=requirements', 'zh-TW')
		try {
			await page.locator('[data-overview-requirements]').waitFor()
			await expect.poll(() => page.getByRole('tab', { name: '需求' }).count()).toBe(1)
			await expect.poll(() => page.locator('[data-requirements-coverage]').innerText()).toContain('涵蓋率 75%')
		}
		finally { await context.close() }
	}, 60_000)
})

describe('references on View and Flow pages (Rule 01a18120-fe71-7c8c-a69e-5d74c152cb58)', () => {
	it('shows the View\'s references in its Spec, names the Variant behind one only a Variant lists and marks an unresolved ID', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?panel=spec`)
		try {
			const section = page.locator('[data-spec-section="requirements"]')
			await section.waitFor()
			const ref = (id: string) => section.locator(`[data-requirement-ref="${id}"]`)
			await expect.poll(() => ref(rules[0]!).count()).toBe(1)
			// Rule text from the provider, shown once the coverage is read.
			await expect.poll(() => ref(rules[0]!).innerText()).toContain('Rule 1 states one behavior.')
			expect(await ref(rules[0]!).locator('[data-requirement-variant]').count()).toBe(0)
			expect(await ref(rules[1]!).locator('[data-requirement-variant]').innerText()).toContain(VARIANT)
			await expect.poll(() => ref(UNKNOWN_ID).locator('[data-requirement-note="unresolved"]').count()).toBe(1)
		}
		finally { await context.close() }
	}, 60_000)

	it('shows the Flow\'s references in its inspector', async () => {
		const { context, page } = await open(`/flows/${FLOW_ID}`)
		try {
			const section = page.locator('[data-flow-requirements]')
			await section.waitFor()
			await expect.poll(() => section.locator(`[data-requirement-ref="${rules[2]!}"]`).innerText()).toContain('Rule 3 states one behavior.')
		}
		finally { await context.close() }
	}, 60_000)
})

describe('without a spec provider', () => {
	it('shows no Requirements tab, and a url provider turns each reference into a link', async () => {
		const read = await (await fetch(`${server.origin}/api/resources/workspace/workspace`, { headers: server.headers })).json() as { revision: string; resource: { i18n: unknown; viewports: unknown; themes: unknown } }
		const put = async (requirements: unknown, revision: string) => {
			const response = await fetch(`${server.origin}/api/workspace/settings`, {
				method: 'PUT',
				headers: { ...server.headers, 'content-type': 'application/json' },
				body: JSON.stringify({ expectedRevision: revision, settings: { i18n: read.resource.i18n, viewports: read.resource.viewports, themes: read.resource.themes, requirements } }),
			})
			expect(response.status, await response.clone().text()).toBe(200)
			return (await response.json() as { revision: string }).revision
		}
		await put({ provider: 'url', template: 'https://example.com/req/{id}' }, read.revision)
		const { context, page } = await open('/?tab=requirements')
		try {
			await page.locator('[data-views-table], [data-views-list]').first().waitFor()
			expect(await page.getByRole('tab', { name: 'Requirements' }).count()).toBe(0)

			const view = await open(`/views/${VIEW_ID}?panel=spec`)
			try {
				const link = view.page.locator(`[data-spec-section="requirements"] [data-requirement-ref="${rules[0]!}"] a`)
				await link.waitFor()
				expect(await link.getAttribute('href')).toBe(`https://example.com/req/${encodeURIComponent(rules[0]!)}`)
				expect(await view.page.locator('[data-spec-section="requirements"] [data-requirement-note="unverified"]').count()).toBeGreaterThan(0)
			}
			finally { await view.context.close() }
		}
		finally { await context.close() }
	}, 90_000)
})
