import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Workbench restore (Part 11, issue #132, B10) against the built Workbench and a private copy of
 * the frozen fixture Workspace:
 *
 * - "Restore this version" on a resource's diff writes the selected version's content after an
 *   explicit confirmation (Rule 01a11a5e-18f2-7991-8f7d-aa4c8015d14a); a View keeps its current
 *   Decisions (Rule 01a11a5e-1645-…) and the restore is a version of its own that names its source
 *   (Rules 01a11a5e-14ce-… and 01a11e0d-d911-…);
 * - with impact, the dialog lists it and writes only after "Restore anyway" (Rules 01a11a5e-16f7-…
 *   and 174b-…);
 * - a change made after the dialog opened conflicts and can be reloaded (Rule 01a11a5e-1520-…), and
 *   an edit lease held by someone else is named;
 * - compared with its parent, Restore still restores the selected version, its content right after
 *   that change; a View that already matches it is not restored again, since that would only
 *   write an empty version;
 * - Restore is offered only on a desktop layout (Rule 01a11a5e-1bfa-…), only to an Editor or above
 *   (Clause 01a11485-fa44-…), and only for the kinds this build restores.
 *
 * Every test seeds its own View through the API, so the tests run in any order.
 */

let server: WorkbenchServer
let browser: Browser

type Read<T> = { revision: string; resource: T }
type ViewResource = { name: string; ir: unknown; spec: { intent: string; decisions?: { id: string; question: string }[] } & Record<string, unknown> }
type ListedVersion = { id: string; type: string; restoredFrom?: string; summary: { kind: string; key: string; status: string }[] }

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

const unique = () => randomUUID().slice(0, 8)
const button = (id: string, label: string) => ({ type: 'Button', id, config: { label } })
const tree = (...content: unknown[]) => ({ type: 'RootShell', id: 'root', slots: { content: [{ type: 'Stack', id: 'page', config: { direction: 'vertical', gap: 16, padding: 16 }, slots: { content } }] } })

async function readView(key: string): Promise<Read<ViewResource>> {
	return await api<Read<ViewResource>>(`/api/resources/view/${key}`)
}

async function setStructure(key: string, ir: unknown): Promise<void> {
	await api(`/api/views/${key}/structure`, { expectedRevision: (await readView(key)).revision, ir, variants: {} }, 'PUT')
}

async function setIntent(key: string, intent: string): Promise<void> {
	const read = await readView(key)
	const spec = { ...read.resource.spec }
	delete spec.decisions
	await api(`/api/views/${key}/spec`, { expectedRevision: read.revision, spec: { ...spec, intent } }, 'PUT')
}

/** A View of its own with one Button. */
async function seedView(name: string): Promise<string> {
	const spec = { intent: name, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	const view = await api<{ key: string }>('/api/views', { name, spec })
	await setStructure(view.key, tree(button('pay', 'Pay')))
	return view.key
}

/** A Widget thread with its first message. */
async function seedThread(viewId: string, widgetId: string, body: string): Promise<{ key: string; revision: string }> {
	const created = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId, widgetId } })
	return await api<{ key: string; revision: string }>(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body })
}

/** A Checkpoint through `POST /api/history/checkpoints`; it closes the open autosave first. */
async function checkpoint(name: string): Promise<string> {
	return (await api<{ versionId: string }>('/api/history/checkpoints', { name })).versionId
}

async function versions(query = 'limit=20'): Promise<ListedVersion[]> {
	return (await api<{ versions: ListedVersion[] }>(`/api/history/versions?${query}`)).versions
}

type Device = 'desktop' | 'tablet' | 'phone'
const VIEWPORTS: Record<Device, { width: number; height: number }> = {
	desktop: { width: 1440, height: 900 },
	tablet: { width: 1024, height: 768 },
	phone: { width: 390, height: 844 },
}

async function open(path: string, options: Readonly<{ device?: Device; cookie?: { name: string; value: string } }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const device = options.device ?? 'desktop'
	const context = await browser.newContext({ viewport: VIEWPORTS[device], colorScheme: 'light', ...(device === 'phone' ? { hasTouch: true, isMobile: true } : {}) })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...(options.cookie ?? server.cookie), url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

/** Overview › Activity comparing a version with the current state (or its parent), narrowed to one View. */
const comparisonPath = (version: string, viewKey: string, compare: 'current' | 'parent' = 'current') => `/?tab=activity&version=${version}&compare=${compare}&resource=view:${viewKey}`

/** The closed autosave that last changed the View. */
async function lastAutosave(key: string): Promise<string> {
	const found = (await versions()).find(version => version.type === 'autosave' && version.summary.some(row => row.kind === 'view' && row.key === key))
	if (!found) throw new Error(`no autosave changed view:${key}`)
	return found.id
}

/** The View's open diff in the comparison, once its semantic diff has loaded. */
async function viewDiff(page: Page, viewKey: string) {
	const block = page.locator(`[data-version-comparison] [data-resource-diff="view:${viewKey}"][data-open]`)
	await block.locator('[data-diff-section]').first().waitFor({ timeout: 15_000 })
	return block
}

const dialog = (page: Page) => page.locator('[data-restore-dialog]')
const focused = (page: Page, selector: string) => page.evaluate(target => !!document.activeElement?.matches(target), selector)

/** Opens the restore dialog and waits until the current revision is read (Restore is enabled). */
async function openRestore(page: Page, viewKey: string): Promise<void> {
	const block = await viewDiff(page, viewKey)
	await block.locator('[data-restore-version]').click()
	await dialog(page).waitFor()
	await expect.poll(() => page.locator('[data-restore-confirm]').isEnabled(), { timeout: 10_000 }).toBe(true)
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

describe('restoring from a resource\'s diff', () => {
	it('restores a View after confirmation, keeps its Decisions, and shows the restore as its own version naming its source', async () => {
		const key = await seedView(`b10 restore ${unique()}`)
		const earlier = await checkpoint(`b10 before ${unique()}`)
		const earlierView = (await readView(key)).resource
		await setStructure(key, tree(button('pay', 'Pay now')))
		await setIntent(key, 'Pay quickly')
		// A Decision promoted from a thread on the RootShell, which every version of the View has.
		const thread = await seedThread(key, 'root', 'Show the total before tax?')
		const promoted = await api<{ status: string }>(`/api/reviews/${thread.key}/promote`, {
			expectedReviewRevision: thread.revision,
			viewId: key,
			expectedViewRevision: (await readView(key)).revision,
			question: 'Show the total before tax?',
			outcome: { summary: 'Yes', rationale: 'Asked for in the copy review.' },
		})
		expect(promoted.status).not.toBe('invalid')
		const decisions = (await readView(key)).resource.spec.decisions ?? []
		expect(decisions.length).toBe(1)

		const { context, page } = await open(comparisonPath(earlier, key))
		try {
			await openRestore(page, key)
			// Focus starts on Cancel, never on Restore; the dialog names the View and keeps its Decisions.
			await expect.poll(() => focused(page, '[data-restore-cancel]')).toBe(true)
			await dialog(page).locator('[data-restore-decisions]').waitFor()
			// Cancel writes nothing.
			await page.locator('[data-restore-cancel]').click()
			await dialog(page).waitFor({ state: 'detached' })
			expect((await readView(key)).resource.spec.intent).toBe('Pay quickly')

			await openRestore(page, key)
			await page.locator('[data-restore-confirm]').click()
			await dialog(page).waitFor({ state: 'detached', timeout: 15_000 })

			const after = (await readView(key)).resource
			expect(after.ir).toEqual(earlierView.ir)
			expect(after.spec.intent).toBe(earlierView.spec.intent)
			expect(after.spec.decisions).toEqual(decisions)

			const restore = (await versions()).find(version => version.restoredFrom === earlier)!
			expect(restore).toBeDefined()
			expect(restore.summary).toEqual([expect.objectContaining({ kind: 'view', key })])
			// The timeline is read again at once: the restore is its own row, naming and linking its source.
			const row = page.locator(`[data-version-timeline] [data-version-row="${restore.id}"]`)
			await row.waitFor({ timeout: 15_000 })
			const source = row.locator(`[data-restored-from="${earlier}"] [data-restored-from-link]`)
			await source.waitFor()
			expect(await source.getAttribute('href')).toContain(`version=${earlier}`)
		}
		finally { await context.close() }
	}, 90_000)

	it('lists the impact, writes nothing until confirmed, then restores once confirmed', async () => {
		const key = await seedView(`b10 impact ${unique()}`)
		const earlier = await checkpoint(`b10 before ${unique()}`)
		await setStructure(key, tree(button('pay', 'Pay'), { type: 'Text', id: 'note', config: { text: 'Taxes included' } }))
		const thread = await seedThread(key, 'note', 'Is this note needed?')
		const before = await readView(key)

		const { context, page } = await open(comparisonPath(earlier, key))
		try {
			await openRestore(page, key)
			await page.locator('[data-restore-confirm]').click()
			await expect.poll(() => dialog(page).getAttribute('data-stage'), { timeout: 15_000 }).toBe('impact')
			const item = dialog(page).locator('[data-impact-group="anchors"] [data-impact-item][data-category="review_anchor_invalidated"]')
			await item.waitFor()
			expect(await item.textContent()).toContain('note')
			expect(await item.getAttribute('title')).toContain(thread.key)
			// The impact list moved focus to itself, and nothing was written.
			await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-restore-dialog]'))).toBe(true)
			expect((await readView(key)).revision).toBe(before.revision)

			await page.locator('[data-restore-acknowledge]').click()
			await dialog(page).waitFor({ state: 'detached', timeout: 15_000 })
			expect(JSON.stringify((await readView(key)).resource.ir)).not.toContain('"note"')
			expect((await versions()).some(version => version.restoredFrom === earlier)).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('shows a conflict when the View changed after the dialog opened, and restores after reloading', async () => {
		const key = await seedView(`b10 conflict ${unique()}`)
		const earlier = await checkpoint(`b10 before ${unique()}`)
		const earlierIntent = (await readView(key)).resource.spec.intent
		await setIntent(key, `Changed ${unique()}`)

		const { context, page } = await open(comparisonPath(earlier, key))
		try {
			await openRestore(page, key)
			await setIntent(key, `Changed again ${unique()}`)
			const changed = await readView(key)
			await page.locator('[data-restore-confirm]').click()
			await dialog(page).locator('[data-restore-conflict]').waitFor({ timeout: 15_000 })
			expect((await readView(key)).revision).toBe(changed.revision)

			await page.locator('[data-restore-reload]').click()
			await expect.poll(() => dialog(page).getAttribute('data-stage')).toBe('confirm')
			await expect.poll(() => page.locator('[data-restore-confirm]').isEnabled(), { timeout: 10_000 }).toBe(true)
			await page.locator('[data-restore-confirm]').click()
			await dialog(page).waitFor({ state: 'detached', timeout: 15_000 })
			expect((await readView(key)).resource.spec.intent).toBe(earlierIntent)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('restoring from a comparison with the parent', () => {
	it('offers no Restore while the View already matches the version, and otherwise restores the content right after that change', async () => {
		const key = await seedView(`b10 parent ${unique()}`)
		await checkpoint(`b10 seeded ${unique()}`)
		const seededIntent = (await readView(key)).resource.spec.intent
		const changedIntent = `After the change ${unique()}`
		await setIntent(key, changedIntent)
		await checkpoint(`b10 changed ${unique()}`)
		const change = await lastAutosave(key)

		const { context, page } = await open(comparisonPath(change, key, 'parent'))
		try {
			// The View is still as this change left it: restoring would change nothing.
			const block = await viewDiff(page, key)
			await block.locator('[data-restore-version]').click()
			await dialog(page).locator('[data-restore-unchanged]').waitFor({ timeout: 15_000 })
			expect(await dialog(page).locator('[data-restore-unchanged]').textContent()).toContain('already matches this version')
			expect(await page.locator('[data-restore-confirm]').isDisabled()).toBe(true)
			await page.locator('[data-restore-cancel]').click()
			await dialog(page).waitFor({ state: 'detached' })
			expect((await versions()).some(version => version.restoredFrom === change)).toBe(false)

			// After a later edit, Restore brings back the content right after the change, not before it.
			await setIntent(key, `Later ${unique()}`)
			await page.reload({ waitUntil: 'networkidle' })
			await openRestore(page, key)
			expect(await dialog(page).locator('[data-restore-unchanged]').count()).toBe(0)
			const summary = dialog(page).locator('[data-restore-summary][data-after-change]')
			expect(await summary.textContent()).toContain('right after this change')
			await page.locator('[data-restore-confirm]').click()
			await dialog(page).waitFor({ state: 'detached', timeout: 15_000 })
			const intent = (await readView(key)).resource.spec.intent
			expect(intent).toBe(changedIntent)
			expect(intent).not.toBe(seededIntent)
			expect((await versions()).some(version => version.restoredFrom === change)).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('a refused restore', () => {
	it('names the holder of an edit lease, writes nothing, and goes back to the confirmation on Retry', async () => {
		const key = await seedView(`b10 locked ${unique()}`)
		const earlier = await checkpoint(`b10 before ${unique()}`)
		await setIntent(key, `Locked ${unique()}`)
		const before = await readView(key)
		const { context, page } = await open(comparisonPath(earlier, key))
		try {
			// The lease is answered by the route as the server answers it (`423 resource.locked`).
			const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
			await page.route('**/api/history/versions/*/restore', route => route.fulfill({
				status: 423,
				json: { status: 'locked', key, code: 'resource.locked', message: 'View is locked.', lock: { kind: 'view', key, holder: { nickname: 'b10-holder', kind: 'agent' }, expiresAt } },
			}))
			await openRestore(page, key)
			await page.locator('[data-restore-confirm]').click()
			const locked = dialog(page).locator('[data-restore-locked]')
			await locked.waitFor({ timeout: 15_000 })
			expect(await dialog(page).getAttribute('data-stage')).toBe('locked')
			expect(await locked.textContent()).toContain('b10-holder')
			await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-restore-dialog]'))).toBe(true)
			expect((await readView(key)).revision).toBe(before.revision)

			await page.unroute('**/api/history/versions/*/restore')
			await page.locator('[data-restore-reload]').click()
			await expect.poll(() => dialog(page).getAttribute('data-stage')).toBe('confirm')
			await expect.poll(() => page.locator('[data-restore-confirm]').isEnabled(), { timeout: 10_000 }).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('where Restore is offered', () => {
	it('is not offered on a tablet or a phone, where the diff is still shown', async () => {
		const key = await seedView(`b10 tiers ${unique()}`)
		const earlier = await checkpoint(`b10 before ${unique()}`)
		await setIntent(key, `Tiers ${unique()}`)
		for (const device of ['tablet', 'phone'] as const) {
			const { context, page } = await open(comparisonPath(earlier, key), { device })
			try {
				await viewDiff(page, key)
				expect(await page.locator('[data-restore-version]').count(), device).toBe(0)
			}
			finally { await context.close() }
		}
	}, 90_000)

	it('is not offered to a Viewer or a Reviewer, and is offered to an Editor', async () => {
		const key = await seedView(`b10 roles ${unique()}`)
		const earlier = await checkpoint(`b10 before ${unique()}`)
		await setIntent(key, `Roles ${unique()}`)
		for (const role of ['viewer', 'reviewer', 'editor'] as const) {
			const token = await provisionToken(server.workspaceRoot, { nickname: `b10-${role}-${unique()}`, kind: 'human', role })
			const { context, page } = await open(comparisonPath(earlier, key), { cookie: await sessionCookieFor(server.origin, token) })
			try {
				await viewDiff(page, key)
				await expect.poll(() => page.locator('[data-restore-version]').count(), { message: role }).toBe(role === 'editor' ? 1 : 0)
			}
			finally { await context.close() }
		}
	}, 90_000)

	it('offers no action for a kind this build cannot restore', async () => {
		const key = await seedView(`b10 kinds ${unique()}`)
		const earlier = await checkpoint(`b10 before ${unique()}`)
		await setIntent(key, `Kinds ${unique()}`)
		const { context, page } = await open('/?tab=activity')
		try {
			// A comparison that also names a Product Kit, as a later schema records one: it is diffed
			// as a kind this build cannot read, and offers no Restore.
			await page.route('**/api/history/diff?*', async (route) => {
				const response = await route.fetch()
				const body = await response.json() as { summary: unknown[]; changes?: unknown[] }
				const unknown = { kind: 'product-kit', key: 'product-kit', status: 'modified' }
				body.summary = [...body.summary, unknown]
				if (body.changes) body.changes = [...body.changes, { ...unknown, diff: { type: 'unsupported_kind' } }]
				await route.fulfill({ response, json: body })
			})
			await page.goto(`${server.origin}/?tab=activity&version=${earlier}&compare=current`, { waitUntil: 'networkidle' })
			const comparison = page.locator('[data-version-comparison]')
			for (const resource of [`view:${key}`, 'product-kit:product-kit']) {
				const block = comparison.locator(`[data-resource-diff="${resource}"]`)
				await block.waitFor({ timeout: 15_000 })
				if (await block.getAttribute('data-open') === null) await block.locator('[data-resource-diff-toggle]').click()
			}
			await comparison.locator('[data-resource-diff="product-kit:product-kit"] [data-diff-unsupported]').waitFor({ timeout: 15_000 })
			await comparison.locator(`[data-resource-diff="view:${key}"] [data-restore-version]`).waitFor({ timeout: 15_000 })
			expect(await comparison.locator('[data-resource-diff="product-kit:product-kit"] [data-restore-version]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('comparison reads (B8 follow-up)', () => {
	it('reads a comparison with the current state once on a cold start', async () => {
		const key = await seedView(`b10 cold ${unique()}`)
		const earlier = await checkpoint(`b10 before ${unique()}`)
		await setIntent(key, `Cold ${unique()}`)
		const context = await browser.newContext({ viewport: VIEWPORTS.desktop, colorScheme: 'light' })
		await context.addInitScript(() => localStorage.setItem('uiux.workbench.locale', 'en-US'))
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const page = await context.newPage()
		const summaries: string[] = []
		page.on('request', (request) => {
			const url = new URL(request.url())
			if (url.pathname === '/api/history/diff' && url.searchParams.get('detail') === 'summary') summaries.push(url.search)
		})
		try {
			await page.goto(`${server.origin}/?tab=activity&version=${earlier}&compare=current`, { waitUntil: 'networkidle' })
			await page.locator(`[data-version-comparison] [data-summary-row="view:${key}"]`).waitFor({ timeout: 15_000 })
			// The timeline and the Workbench have both arrived by now.
			await page.locator(`[data-version-timeline] [data-version-row="${earlier}"]`).waitFor({ timeout: 15_000 })
			await page.waitForLoadState('networkidle')
			expect(summaries).toHaveLength(1)
		}
		finally { await context.close() }
	}, 90_000)
})
