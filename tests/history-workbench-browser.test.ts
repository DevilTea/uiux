import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { bearer, provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Workbench version timeline, history panel, comparison and Checkpoints (Part 11, issue #132,
 * B8) against the built Workbench and a private copy of the frozen fixture Workspace:
 *
 * - Overview's Activity tab is the timeline: day groups, autosave and Checkpoint rows that expand to
 *   their changes and write events (Rule 01a11a5e-1946), with filters (Rule 01a11a5e-199c), and the
 *   Review events in a separate list (Rule 01a11e0d-db86);
 * - a comparison shows its summary, then the diff per resource (Rule 01a11a5e-11e0), with the parent
 *   or the current state, and the address reopens it (Rule 01a11a5e-1afd; Clauses 01a11e0d-d74b and
 *   01a11e0d-d7f5);
 * - the View page's history panel lists the versions that changed the View (Rule 01a11a5e-1aa5);
 * - the changes since this browser last looked link to a comparison (Rule 01a11a5e-1a4b);
 * - Create Checkpoint, with the lease warning (Rules 01a11a5e-0c71 and 0cc5), and the Owner's Delete
 *   with confirmation (Rule 01a11e0d-da2f);
 * - device tiers: timeline and diff everywhere, Create on desktop and tablet, Delete on desktop only
 *   (Rules 01a11a5e-1b52, 1ba5 and 01a11e0d-dada).
 *
 * Every test seeds its own versions through the API (Locale and View writes, then a Checkpoint,
 * which closes the open autosave first), so the tests run in any order.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

let server: WorkbenchServer
let browser: Browser

type Read<T> = { revision: string; resource: T }
type ListedVersion = { id: string; type: string; name: string | null; note?: string; summary: { kind: string; key: string; status: string }[] }

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = server.headers): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

const unique = () => randomUUID().slice(0, 8)

/** Adds one message to the en-US Locale as the Owner (an autosave event). */
async function editLocale(key: string, value: string): Promise<void> {
	const read = await api<Read<Record<string, string>>>('/api/resources/locale/en-US')
	await api('/api/locales/en-US', { expectedRevision: read.revision, messages: { ...read.resource, [key]: value } }, 'PUT')
}

/** Changes the View's Spec intent as the Owner. */
async function editViewIntent(intent: string): Promise<void> {
	const read = await api<Read<{ spec: Record<string, unknown> }>>(`/api/resources/view/${VIEW_ID}`)
	// The Spec write takes the authored sections; Decisions have their own operations.
	const spec = { ...read.resource.spec }
	delete spec.decisions
	await api(`/api/views/${VIEW_ID}/spec`, { expectedRevision: read.revision, spec: { ...spec, intent } }, 'PUT')
}

/** A Checkpoint through `POST /api/history/checkpoints`; it closes the open autosave first. */
async function checkpoint(name: string, note?: string): Promise<string> {
	const created = await api<{ status: string; versionId: string }>('/api/history/checkpoints', { name, ...(note ? { note } : {}) })
	return created.versionId
}

async function versions(query = 'limit=20'): Promise<ListedVersion[]> {
	return (await api<{ versions: ListedVersion[] }>(`/api/history/versions?${query}`)).versions
}

/** An Owner edit of en-US closed by a Checkpoint: the autosave's and the Checkpoint's IDs. */
async function seedLocaleVersion(key: string, name: string): Promise<{ autosave: string; checkpoint: string }> {
	await checkpoint(`b8-before-${unique()}`)
	await editLocale(key, `Value of ${key}`)
	const id = await checkpoint(name)
	const listed = await versions()
	const autosave = listed.find(version => version.type === 'autosave' && version.summary.some(row => row.kind === 'locale' && row.key === 'en-US'))!
	return { autosave: autosave.id, checkpoint: id }
}

type Device = 'desktop' | 'tablet' | 'phone' | 'landscape'
const VIEWPORTS: Record<Device, { width: number; height: number }> = {
	desktop: { width: 1440, height: 900 },
	tablet: { width: 1024, height: 768 },
	phone: { width: 390, height: 844 },
	landscape: { width: 844, height: 390 },
}

async function open(path: string, options: Readonly<{ device?: Device; locale?: string; cookie?: { name: string; value: string } }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const device = options.device ?? 'desktop'
	const context = await browser.newContext({ viewport: VIEWPORTS[device], colorScheme: 'light', ...(device === 'phone' || device === 'landscape' ? { hasTouch: true, isMobile: true } : {}) })
	const workbenchLocale = options.locale ?? 'en-US'
	await context.addInitScript((value) => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', value)
	}, workbenchLocale)
	await context.addCookies([{ ...(options.cookie ?? server.cookie), url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

const row = (page: Page, id: string) => page.locator(`[data-version-timeline] [data-version-row="${id}"]`).first()
const query = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams)

/** Picks an option of a Nuxt UI select, then waits for its own list to go so focus is back (PR #162, #163). */
async function choose(page: Page, trigger: string, option: string): Promise<void> {
	await page.locator(trigger).click()
	const listbox = page.locator('[data-slot="content"][role="listbox"]')
	await listbox.getByRole('option', { name: option, exact: true }).click()
	await listbox.waitFor({ state: 'detached' })
}

/** A changed resource's diff in a comparison, opened if it is still collapsed. */
async function openDiff(page: Page, resource: string) {
	const block = page.locator(`[data-version-comparison] [data-resource-diff="${resource}"]`)
	await block.waitFor({ timeout: 15_000 })
	if (await block.getAttribute('data-open') === null) await block.locator('[data-resource-diff-toggle]').click()
	await block.locator('[data-diff-section]').first().waitFor({ timeout: 15_000 })
	return block
}

const focused = (page: Page, selector: string) => page.evaluate(target => !!document.activeElement?.matches(target), selector)

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

describe('version timeline in Activity', () => {
	it('lists seeded versions by day, expands a row to its changes and events, and keeps Review events apart', async () => {
		const key = `b8.timeline.${unique()}`
		const name = `b8 timeline ${unique()}`
		const seeded = await seedLocaleVersion(key, name)
		await api(`/api/history/checkpoints`, { name: `${name} note`, note: 'Before the copy review.' })
		const { context, page } = await open('/?tab=activity')
		try {
			await row(page, seeded.checkpoint).waitFor({ timeout: 15_000 })
			expect(await row(page, seeded.checkpoint).getAttribute('data-version-type')).toBe('checkpoint')
			expect(await row(page, seeded.checkpoint).locator('[data-version-title]').textContent()).toBe(name)
			expect(await page.locator('[data-timeline-day] h3').first().textContent()).toBe('Today')
			await expect.poll(() => page.locator('[data-version-note]').filter({ hasText: 'Before the copy review.' }).count()).toBe(1)

			// The autosave the Checkpoint closed expands to the resources it changed and its write events.
			const autosave = row(page, seeded.autosave)
			expect(await autosave.getAttribute('data-version-type')).toBe('autosave')
			await autosave.locator('[data-version-expand]').click()
			await expect.poll(() => autosave.locator('[data-version-expand]').getAttribute('aria-expanded')).toBe('true')
			await autosave.locator('[data-changed-resource="locale:en-US"][data-status="modified"]').waitFor()
			await autosave.locator('[data-version-event]').filter({ hasText: 'Edited the Locale' }).first().waitFor()

			// Review events are a separate, secondary list after the timeline (Rule 01a11e0d-db86).
			const order = await page.evaluate(() => {
				const timeline = document.querySelector('[data-version-timeline]')!
				const reviews = document.querySelector('[data-review-activity]')!
				return !!(timeline.compareDocumentPosition(reviews) & Node.DOCUMENT_POSITION_FOLLOWING) && !timeline.contains(reviews)
			})
			expect(order).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('filters by actor, by resource kind and to Checkpoints only', async () => {
		const agentNickname = `b8-agent-${unique()}`
		const agentToken = await provisionToken(server.workspaceRoot, { nickname: agentNickname, kind: 'agent', role: 'editor' })
		const name = `b8 filters ${unique()}`
		await checkpoint(`b8-before-${unique()}`)
		await editViewIntent(`Filters ${unique()}`)
		// The Agent's write closes the Owner's autosave (a new actor) and takes the Locale's lease.
		await api('/api/locales', { locale: 'de', messages: { greeting: 'Hallo' } }, 'POST', bearer(agentToken))
		const checkpointId = await checkpoint(name)
		const listed = await versions()
		const agentVersion = listed.find(version => version.summary.some(item => item.kind === 'locale' && item.key === 'de'))!
		const ownerVersion = listed.find(version => version.type === 'autosave' && version.id !== agentVersion.id && version.summary.some(item => item.kind === 'view'))!
		const { context, page } = await open('/?tab=activity')
		try {
			await row(page, checkpointId).waitFor({ timeout: 15_000 })
			await row(page, agentVersion.id).waitFor()
			await row(page, ownerVersion.id).waitFor()

			await page.getByRole('switch', { name: 'Checkpoints only' }).click()
			// A filter change empties the list and reads it again (the server applies the type and actor
			// filters). A row count of 0 also holds while the list is empty, so each step polls for a state
			// that neither the old list nor the empty one shows: only Checkpoint rows, or [excluded, kept] = [0, 1].
			await expect.poll(() => row(page, checkpointId).count()).toBe(1)
			const types = () => page.locator('[data-version-timeline] [data-version-row]').evaluateAll(rows => rows.map(item => item.getAttribute('data-version-type')))
			await expect.poll(async () => [...new Set(await types())]).toEqual(['checkpoint'])
			await page.getByRole('switch', { name: 'Checkpoints only' }).click()
			await row(page, agentVersion.id).waitFor()

			const ownerAndAgent = () => Promise.all([row(page, ownerVersion.id).count(), row(page, agentVersion.id).count()])
			await choose(page, '[data-history-filter="actor"]', agentNickname)
			await expect.poll(ownerAndAgent).toEqual([0, 1])
			await choose(page, '[data-history-filter="actor"]', 'Anyone')
			await row(page, ownerVersion.id).waitFor()

			await choose(page, '[data-history-filter="kind"]', 'Locale')
			await expect.poll(ownerAndAgent).toEqual([0, 1])
		}
		finally {
			await context.close()
			await api('/api/locks/locale/de', undefined, 'DELETE')
		}
	}, 90_000)
})

describe('timeline rows', () => {
	it('folds an autosave whose changes cancelled out into one quiet row', async () => {
		const key = `b8.quiet.${unique()}`
		await checkpoint(`b8-before-${unique()}`)
		await editLocale(key, 'Added, then removed')
		const read = await api<Read<Record<string, string>>>('/api/resources/locale/en-US')
		const messages = { ...read.resource }
		delete messages[key]
		await api('/api/locales/en-US', { expectedRevision: read.revision, messages }, 'PUT')
		const id = await checkpoint(`b8 quiet ${unique()}`)
		const quiet = (await versions()).find(version => version.type === 'autosave' && version.summary.length === 0)!
		const { context, page } = await open('/?tab=activity')
		try {
			await row(page, id).waitFor({ timeout: 15_000 })
			const run = page.locator('[data-version-timeline] [data-quiet-run]').filter({ has: page.locator(`[data-version-row="${quiet.id}"]`) })
			await page.locator('[data-quiet-run] [data-quiet-toggle]').first().waitFor()
			// The run is collapsed: its version is not shown as a row of its own.
			expect(await page.locator(`[data-version-timeline] > section [data-version-row="${quiet.id}"]:visible`).count()).toBe(0)
			const toggle = page.locator('[data-quiet-run]').locator('[data-quiet-toggle]')
			for (let index = 0; index < await toggle.count(); index++) {
				if (await run.count()) break
				await toggle.nth(index).click()
			}
			await expect.poll(() => run.count()).toBe(1)
			await expect.poll(() => run.locator('[data-quiet-toggle]').getAttribute('aria-expanded')).toBe('true')
		}
		finally { await context.close() }
	}, 90_000)

	it('lists a history file it cannot read with an explanation and no Delete', async () => {
		const directory = join(server.workspaceRoot, '.uiux', 'history', 'checkpoints')
		const file = join(directory, `${randomUUID()}.json`)
		await mkdir(directory, { recursive: true })
		await writeFile(file, '{"historySchemaVersion": 99}\n')
		const { context, page } = await open('/?tab=activity')
		try {
			const section = page.locator('[data-invalid-records]')
			await section.waitFor({ timeout: 15_000 })
			await section.getByText('so they are left out of the timeline and can\'t be deleted here').waitFor()
			expect(await section.locator('[data-invalid-record]').filter({ hasText: file.slice(server.workspaceRoot.length + 1) }).count()).toBe(1)
			expect(await section.locator('[data-version-delete]').count()).toBe(0)
		}
		finally {
			await context.close()
			await rm(file, { force: true })
		}
	}, 90_000)
})

describe('comparison', () => {
	it('compares with the parent and with the current state, and a copied address reopens the same comparison', async () => {
		const key = `b8.compare.${unique()}`
		const seeded = await seedLocaleVersion(key, `b8 compare ${unique()}`)
		const { context, page } = await open('/?tab=activity')
		try {
			await row(page, seeded.autosave).locator('[data-version-compare]').click()
			await page.waitForURL(url => new URL(url).searchParams.get('version') === seeded.autosave)
			// Only `version` is written: the parent is the default, never added to the address.
			expect(query(page)).toEqual({ tab: 'activity', version: seeded.autosave })
			const comparison = page.locator('[data-version-comparison]')
			await expect.poll(() => comparison.getAttribute('data-from')).toBe('parent')
			await expect.poll(() => comparison.getAttribute('data-to')).toBe(seeded.autosave)
			// Summary first, then the diff per resource.
			const summary = comparison.locator('[data-summary-row="locale:en-US"]')
			await summary.waitFor({ timeout: 15_000 })
			expect(await summary.getAttribute('data-status')).toBe('modified')
			const diff = await openDiff(page, 'locale:en-US')
			await diff.locator('[data-diff-item][data-op="added"]').filter({ hasText: key }).waitFor()
			// Choosing a version moves focus to the comparison's heading.
			await expect.poll(() => focused(page, '[data-comparison-heading]')).toBe(true)
			expect(await comparison.evaluate((element) => {
				const first = element.querySelector('[data-comparison-summary]')!
				const second = element.querySelector('[data-resource-diff]')!
				return !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
			})).toBe(true)
			expect(await comparison.locator('[data-compare-target="parent"]').getAttribute('aria-current')).toBe('true')

			// With the current state: the version is the older side.
			await editLocale(`${key}.later`, 'Later')
			await comparison.locator('[data-compare-target="current"]').click()
			await page.waitForURL(url => new URL(url).searchParams.get('compare') === 'current')
			await expect.poll(() => comparison.getAttribute('data-from')).toBe(seeded.autosave)
			await expect.poll(() => comparison.getAttribute('data-to')).toBe('current')
			await (await openDiff(page, 'locale:en-US')).locator('[data-diff-item]').filter({ hasText: `${key}.later` }).waitFor({ timeout: 15_000 })

			// Narrow to one resource, then reopen the copied address in a fresh page.
			await comparison.locator('[data-summary-row="locale:en-US"] a').click()
			await page.waitForURL(url => new URL(url).searchParams.get('resource') === 'locale:en-US')
			const copied = page.url()
			expect(query(page)).toEqual({ tab: 'activity', version: seeded.autosave, compare: 'current', resource: 'locale:en-US' })
			const reopened = await context.newPage()
			await reopened.goto(copied, { waitUntil: 'networkidle' })
			const again = reopened.locator('[data-version-comparison]')
			await again.locator('[data-resource-diff="locale:en-US"][data-open] [data-diff-section]').waitFor({ timeout: 15_000 })
			expect(await again.getAttribute('data-from')).toBe(seeded.autosave)
			expect(await again.getAttribute('data-to')).toBe('current')
			expect(await again.locator('[data-compare-target="current"]').getAttribute('aria-current')).toBe('true')
			expect(await again.locator('[data-summary-row="locale:en-US"] a').getAttribute('aria-current')).toBe('true')
			expect(await reopened.locator('[data-version-timeline] [data-version-row][data-selected]').getAttribute('data-version-row')).toBe(seeded.autosave)
			expect(query(reopened)).toEqual(query(page))
		}
		finally { await context.close() }
	}, 90_000)

	it('links a View changed since this browser last looked to a comparison from the version holding that revision to now', async () => {
		await checkpoint(`b8-before-${unique()}`)
		const seen = (await api<Read<unknown>>(`/api/resources/view/${VIEW_ID}`)).revision
		await editViewIntent(`Since ${unique()}`)
		await checkpoint(`b8 since ${unique()}`)
		const context = await browser.newContext({ viewport: VIEWPORTS.desktop, colorScheme: 'light' })
		await context.addInitScript(({ viewId, revision }) => {
			localStorage.setItem('uiux.workbench.locale', 'en-US')
			localStorage.setItem('uiux.workbench.lastSeen', JSON.stringify({ [`view:${viewId}`]: revision }))
		}, { viewId: VIEW_ID, revision: seen })
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const page = await context.newPage()
		try {
			await page.goto(`${server.origin}/?tab=activity`, { waitUntil: 'networkidle' })
			const link = page.locator(`[data-since-view="${VIEW_ID}"] [data-since-compare]`)
			await link.waitFor({ timeout: 15_000 })
			await link.click()
			await page.waitForURL(url => new URL(url).searchParams.get('compare') === 'current')
			const { version, compare, resource } = query(page)
			expect({ compare, resource }).toEqual({ compare: 'current', resource: `view:${VIEW_ID}` })
			const holding = await api<{ version: { resources: { kind: string; key: string; revision: string }[] } }>(`/api/history/versions/${version}`)
			expect(holding.version.resources.find(item => item.kind === 'view' && item.key === VIEW_ID)?.revision).toBe(seen)
			await page.locator(`[data-version-comparison] [data-resource-diff="view:${VIEW_ID}"][data-open] [data-diff-section="spec"]`).waitFor({ timeout: 15_000 })
		}
		finally { await context.close() }
	}, 90_000)

	it('orders a comparison with another version by time, even before either is listed', async () => {
		const older = await seedLocaleVersion(`b8.order.a.${unique()}`, `b8 order a ${unique()}`)
		const newer = await seedLocaleVersion(`b8.order.b.${unique()}`, `b8 order b ${unique()}`)
		const requests: string[] = []
		const { context, page } = await open('/', {})
		try {
			page.on('request', (request) => { if (request.url().includes('/api/history/diff')) requests.push(request.url()) })
			// Cold start on the address with the newer version selected and the older one to compare.
			await page.goto(`${server.origin}/?tab=activity&version=${newer.autosave}&compare=${older.autosave}`, { waitUntil: 'networkidle' })
			const comparison = page.locator('[data-version-comparison]')
			await expect.poll(() => comparison.getAttribute('data-from'), { timeout: 15_000 }).toBe(older.autosave)
			await expect.poll(() => comparison.getAttribute('data-to')).toBe(newer.autosave)
			// No diff was ever asked for the wrong way round.
			expect(requests.length).toBeGreaterThan(0)
			expect(requests.every(url => new URL(url).searchParams.get('from') === older.autosave)).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('View history panel', () => {
	it('lists the versions that changed the View and keeps its selection in the address', async () => {
		const intent = `History panel ${unique()}`
		await checkpoint(`b8-before-${unique()}`)
		await editViewIntent(intent)
		await checkpoint(`b8 panel ${unique()}`)
		const projected = await versions(`resource=view:${VIEW_ID}&limit=5`)
		const changed = projected[0]!
		expect(changed.type).toBe('autosave')
		const { context, page } = await open(`/views/${VIEW_ID}?panel=history`)
		try {
			const panel = page.locator('[data-view-history]')
			await panel.locator(`[data-version-row="${changed.id}"]`).waitFor({ timeout: 15_000 })
			// Only versions in which the View changed: the Checkpoints after it are not listed.
			const listed = await panel.locator('[data-version-timeline] [data-version-row]').evaluateAll(rows => rows.map(item => item.getAttribute('data-version-row')))
			expect(listed.slice(0, projected.length)).toEqual(projected.map(version => version.id))

			await panel.locator(`[data-version-row="${changed.id}"] [data-version-compare]`).click()
			await page.waitForURL(url => new URL(url).searchParams.get('version') === changed.id)
			expect(query(page)).toMatchObject({ panel: 'history', version: changed.id })
			expect(query(page)).not.toHaveProperty('compare')
			const diff = panel.locator(`[data-version-comparison] [data-resource-diff="view:${VIEW_ID}"][data-open]`)
			await diff.locator('[data-diff-section="spec"] [data-diff-item]').filter({ hasText: intent }).waitFor({ timeout: 15_000 })

			// The render context written by the page keeps the history keys; a reload shows the same.
			await page.reload({ waitUntil: 'networkidle' })
			await panel.locator(`[data-version-comparison] [data-resource-diff="view:${VIEW_ID}"][data-open] [data-diff-section="spec"]`).waitFor({ timeout: 15_000 })
			expect(query(page)).toMatchObject({ panel: 'history', version: changed.id })
			expect(await panel.locator('[data-comparison-full]').getAttribute('href')).toContain(`version=${changed.id}`)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('Checkpoints', () => {
	it('creates a Checkpoint from the toolbar and the command palette, warning while an Agent holds a lease', async () => {
		const agentToken = await provisionToken(server.workspaceRoot, { nickname: `b8-lease-${unique()}`, kind: 'agent', role: 'editor' })
		await api('/api/locales', { locale: 'fr', messages: { greeting: 'Bonjour' } }, 'POST', bearer(agentToken))
		const name = `b8 created ${unique()}`
		const { context, page } = await open('/?tab=activity')
		try {
			await page.locator('[data-create-checkpoint]').click()
			const dialog = page.locator('[data-checkpoint-dialog]')
			await dialog.waitFor()
			await dialog.locator('[data-checkpoint-lease-warning]').filter({ hasText: 'b8-lease-' }).waitFor({ timeout: 10_000 })
			expect(await dialog.locator('[data-checkpoint-lease-warning]').textContent()).toContain('fr')

			// An empty name is refused in place; nothing is sent.
			await page.locator('[data-checkpoint-submit]').click()
			await dialog.getByText('Enter a name.').waitFor()

			await dialog.locator('input[data-checkpoint-name]').fill(name)
			await dialog.locator('textarea[data-checkpoint-note]').fill('Copy review sign-off.')
			await page.locator('[data-checkpoint-submit]').click()
			await dialog.waitFor({ state: 'detached' })
			const created = (await versions('type=checkpoint&limit=5')).find(version => version.name === name)!
			expect(created.note).toBe('Copy review sign-off.')
			await row(page, created.id).waitFor({ timeout: 15_000 })

			// ⌘K → Create Checkpoint opens the same dialog.
			await page.keyboard.press('ControlOrMeta+k')
			await page.getByRole('option', { name: 'Create Checkpoint' }).click()
			await page.locator('[data-checkpoint-dialog]').waitFor()
		}
		finally {
			await context.close()
			await api('/api/locks/locale/fr', undefined, 'DELETE')
		}
	}, 90_000)

	it('offers a 503 history.boundary_failed again as retryable', async () => {
		const name = `b8 retry ${unique()}`
		const { context, page } = await open('/?tab=activity')
		try {
			let refused = false
			await page.route('**/api/history/checkpoints', async (route) => {
				if (refused || route.request().method() !== 'POST') return await route.fallback()
				refused = true
				await route.fulfill({
					status: 503,
					contentType: 'application/json',
					headers: { 'Retry-After': '1' },
					body: JSON.stringify({ status: 'unavailable', code: 'history.boundary_failed', retryable: true, retryAfterSeconds: 1, message: 'The open autosave could not be closed before the Checkpoint, so no Checkpoint was created. Nothing was changed; retry shortly.', diagnostics: [] }),
				})
			})
			await page.locator('[data-create-checkpoint]').click()
			const dialog = page.locator('[data-checkpoint-dialog]')
			await dialog.locator('input[data-checkpoint-name]').fill(name)
			await page.locator('[data-checkpoint-submit]').click()
			const retry = dialog.locator('[data-checkpoint-retry]')
			await retry.waitFor()
			await retry.getByRole('button', { name: 'Retry' }).click()
			await dialog.waitFor({ state: 'detached' })
			expect((await versions('type=checkpoint&limit=5')).some(version => version.name === name)).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('lets the Owner delete a Checkpoint only after confirmation; another member sees no Delete', async () => {
		const name = `b8 delete ${unique()}`
		const id = await checkpoint(name)
		const { context, page } = await open('/?tab=activity')
		try {
			const target = row(page, id)
			await target.waitFor({ timeout: 15_000 })
			await target.locator('[data-version-delete]').click()
			const dialog = page.locator('[data-delete-checkpoint-dialog]')
			await dialog.waitFor()
			expect(await dialog.textContent()).toContain(name)
			// Focus starts on Cancel, never on Delete or the close button.
			await expect.poll(() => focused(page, '[data-delete-cancel]')).toBe(true)
			// Cancel keeps it.
			await page.locator('[data-delete-cancel]').click()
			await dialog.waitFor({ state: 'detached' })
			expect((await versions('type=checkpoint&limit=50')).some(version => version.id === id)).toBe(true)

			await target.locator('[data-version-delete]').click()
			await page.locator('[data-delete-confirm]').click()
			await dialog.waitFor({ state: 'detached' })
			await expect.poll(() => row(page, id).count()).toBe(0)
			expect((await versions('type=checkpoint&limit=50')).some(version => version.id === id)).toBe(false)
		}
		finally { await context.close() }

		const editorToken = await provisionToken(server.workspaceRoot, { nickname: `b8-editor-${unique()}`, kind: 'human', role: 'editor' })
		const cookie = await sessionCookieFor(server.origin, editorToken)
		const other = await checkpoint(`b8 kept ${unique()}`)
		const editor = await open('/?tab=activity', { cookie })
		try {
			await row(editor.page, other).waitFor({ timeout: 15_000 })
			expect(await editor.page.locator('[data-version-delete]').count()).toBe(0)
			// An Editor may still create one.
			await expect.poll(() => editor.page.locator('[data-create-checkpoint]').count()).toBe(1)
		}
		finally { await editor.context.close() }

		// A Viewer reads the timeline but is offered neither Create nor Delete.
		const viewerToken = await provisionToken(server.workspaceRoot, { nickname: `b8-viewer-${unique()}`, kind: 'human', role: 'viewer' })
		const viewer = await open('/?tab=activity', { cookie: await sessionCookieFor(server.origin, viewerToken) })
		try {
			await row(viewer.page, other).waitFor({ timeout: 15_000 })
			expect(await viewer.page.locator('[data-create-checkpoint]').count()).toBe(0)
			expect(await viewer.page.locator('[data-version-delete]').count()).toBe(0)
		}
		finally { await viewer.context.close() }
	}, 90_000)
})

describe('device tiers and zh-TW', () => {
	it('shows the timeline and diff on a phone without Create or Delete, and Create without Delete on a tablet', async () => {
		const seeded = await seedLocaleVersion(`b8.tiers.${unique()}`, `b8 tiers ${unique()}`)
		const phone = await open(`/?tab=activity&version=${seeded.autosave}`, { device: 'phone' })
		try {
			await row(phone.page, seeded.checkpoint).waitFor({ timeout: 15_000 })
			await phone.page.locator('[data-version-comparison] [data-resource-diff="locale:en-US"][data-open] [data-diff-section]').waitFor({ timeout: 15_000 })
			expect(await phone.page.locator('[data-create-checkpoint]').count()).toBe(0)
			expect(await phone.page.locator('[data-version-delete]').count()).toBe(0)
		}
		finally { await phone.context.close() }

		const phoneView = await open(`/views/${VIEW_ID}?panel=history`, { device: 'phone' })
		try {
			await phoneView.page.locator('[data-view-history] [data-version-timeline]').waitFor({ timeout: 15_000 })
			expect(await phoneView.page.locator('[data-create-checkpoint]').count()).toBe(0)
		}
		finally { await phoneView.context.close() }

		// A phone in landscape is still a handset: no Create (Rule 01a11a5e-1ba5).
		const landscape = await open('/?tab=activity', { device: 'landscape' })
		try {
			await row(landscape.page, seeded.checkpoint).waitFor({ timeout: 15_000 })
			expect(await landscape.page.locator('[data-create-checkpoint]').count()).toBe(0)
			expect(await landscape.page.locator('[data-version-delete]').count()).toBe(0)
		}
		finally { await landscape.context.close() }

		const tablet = await open('/?tab=activity', { device: 'tablet' })
		try {
			await row(tablet.page, seeded.checkpoint).waitFor({ timeout: 15_000 })
			await expect.poll(() => tablet.page.locator('[data-create-checkpoint]').count()).toBe(1)
			expect(await tablet.page.locator('[data-version-delete]').count()).toBe(0)
		}
		finally { await tablet.context.close() }
	}, 90_000)

	it('shows the timeline, comparison and Create Checkpoint dialog in zh-TW', async () => {
		const seeded = await seedLocaleVersion(`b8.zh.${unique()}`, `b8 zh ${unique()}`)
		const { context, page } = await open(`/?tab=activity&version=${seeded.autosave}`, { locale: 'zh-TW' })
		try {
			await page.getByRole('heading', { name: '版本歷程' }).waitFor({ timeout: 15_000 })
			await page.locator('[data-version-comparison]').getByText('前一個版本').waitFor()
			await page.getByRole('switch', { name: '只顯示 Checkpoint' }).waitFor()
			await page.locator('[data-create-checkpoint]').filter({ hasText: '建立 Checkpoint' }).click()
			await page.getByRole('dialog').getByText('將整個 Workspace 目前的狀態儲存為具名版本。Workspace 中的內容不會有任何變更。').waitFor()
		}
		finally { await context.close() }
	}, 90_000)
})
