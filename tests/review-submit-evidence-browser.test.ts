import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

import { CHECKS_RUN_SOURCES } from '../src/domain/evidence/checks-run'
import { currentInteractionReplayRecord, flowTraceRecord, putRecordInWorkspace } from './support/evidence-record'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * "Submit for review" can cite any Evidence kind (issue #61; Rules 01a11544-55b0-…, 01a115cd-2ddd-… and
 * 01a11544-55fa-…): a Run Checks record, a Flow trace and an interaction replay are listed beside the
 * formal captures, a change domain preselects the kind that proves it (owner ruling 6 of Discussion #241),
 * a Flow trace is shown as current or stale and never refused, and the submission declares each record's
 * own kind. Against the built server and a real browser.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const FLOW_ID = 'de4668fc-aa5b-4a1d-ac44-ab134f858a55'
const STEP_ID = 'c6a724f2-5da0-4651-a693-24eebbcd494f'

let server: WorkbenchServer
let browser: Browser
let olderRun: string
let newestRun: string
let staleTrace: string
let passingReplay: string
let failingReplay: string
let staleReplay: string
let otherViewTrace: string

async function api<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'content-type': 'application/json', ...server.headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

async function recordRun(ranAt: string): Promise<string> {
	const recorded = await api<{ evidenceDigest: string }>('/api/checks/runs', { ranAt, sources: CHECKS_RUN_SOURCES.map(source => ({ source, state: 'completed' })), findings: [] })
	return recorded.evidenceDigest
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	olderRun = await recordRun('2026-10-26T08:00:00.000Z')
	newestRun = await recordRun('2026-10-26T09:00:00.000Z')
	// The Flow changed since this trace ran, so it is stale; it can still be cited.
	const capture = `sha256:${'c'.repeat(64)}`
	staleTrace = await putRecordInWorkspace(server.workspaceRoot, flowTraceRecord({ flowId: FLOW_ID, flowRevision: 'r_earlier', flowInputDigest: `sha256:${'d'.repeat(64)}`, stepId: STEP_ID, viewId: VIEW_ID }, capture))
	// A replay copies its capture's context and provenance, so these are current unless the View's render input changed since (Clause 01a14e30-2e43-…).
	passingReplay = await putRecordInWorkspace(server.workspaceRoot, await currentInteractionReplayRecord(server.workspaceRoot, VIEW_ID, { capture }))
	failingReplay = await putRecordInWorkspace(server.workspaceRoot, await currentInteractionReplayRecord(server.workspaceRoot, VIEW_ID, { result: 'fail', capture: `sha256:${'d'.repeat(64)}` }))
	// Every assertion passed, but the View's IR or Variants changed after the capture: stale.
	staleReplay = await putRecordInWorkspace(server.workspaceRoot, await currentInteractionReplayRecord(server.workspaceRoot, VIEW_ID, { capture: `sha256:${'f'.repeat(64)}`, staleRenderInput: true }))
	// A trace of a Flow that does not enter this View is not offered for it.
	otherViewTrace = await putRecordInWorkspace(server.workspaceRoot, flowTraceRecord({ flowId: FLOW_ID, flowRevision: 'r_earlier', flowInputDigest: `sha256:${'d'.repeat(64)}`, stepId: STEP_ID, viewId: '99999999-9999-4999-8999-999999999999' }, `sha256:${'e'.repeat(64)}`))
}, 120_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function seedThread(body: string): Promise<string> {
	const created = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: VIEW_ID, widgetId: 'root' } })
	await api(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body })
	return created.key
}

async function openSubmit(threadId: string): Promise<Page> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}/reviews?thread=${threadId}`, { waitUntil: 'networkidle' })
	await page.locator('[data-review-submit]').click()
	await page.locator('[data-submit-review]').waitFor({ timeout: 15_000 })
	return page
}

const row = (page: Page, digest: string) => page.locator(`[data-submit-evidence-digest="${digest}"]`)
const box = (page: Page, digest: string) => row(page, digest).locator('button[role="checkbox"]')
const checked = (page: Page, digest: string) => box(page, digest).getAttribute('aria-checked')

async function pickDomains(page: Page, labels: readonly string[]): Promise<void> {
	await page.locator('[data-submit-domains]').click()
	for (const label of labels) await page.getByRole('option', { name: label }).click()
	await page.keyboard.press('Escape')
}

async function submittedRefs(threadId: string): Promise<unknown> {
	const read = await api<{ resource: { status: string; submissions: { evidenceRefs: unknown[] }[] } }>(`/api/resources/review/${threadId}`)
	expect(read.resource.status).toBe('ready-for-review')
	return read.resource.submissions.at(-1)!.evidenceRefs
}

describe('Submit for review cites any Evidence kind (issue #61)', () => {
	it('lists the Run Checks records, the Flow trace and the interaction replays, and preselects the latest run for an i18n change', async () => {
		const threadId = await seedThread('The Locale copy changed.')
		const page = await openSubmit(threadId)
		try {
			await row(page, newestRun).waitFor({ timeout: 15_000 })
			for (const digest of [olderRun, staleTrace, passingReplay, failingReplay, staleReplay]) expect(await row(page, digest).count()).toBe(1)
			expect(await row(page, otherViewTrace).count()).toBe(0)
			expect(await page.locator('[data-submit-evidence-kind]').evaluateAll(lists => lists.map(list => list.getAttribute('data-submit-evidence-kind')))).toEqual(['checks_run', 'flow_trace', 'interaction_replay'])
			// Nothing is selected before a change domain is chosen.
			expect(await checked(page, newestRun)).toBe('false')
			// The trace says why it is not current; it is shown, not hidden.
			expect(await row(page, staleTrace).innerText()).toContain('The Flow changed after this trace.')
			// A replay is shown as current or stale the same way.
			expect(await row(page, passingReplay).innerText()).toContain('Current')
			expect(await row(page, staleReplay).innerText()).toContain('IR or Variants changed after capture')

			await pickDomains(page, ['i18n (Locale messages)'])
			// The ruling: i18n preselects the latest Run Checks record, point-in-time, never judged stale.
			await expect.poll(() => checked(page, newestRun), { timeout: 10_000 }).toBe('true')
			expect(await checked(page, olderRun)).toBe('false')
			expect(await checked(page, staleTrace)).toBe('false')
			await page.locator('[data-submit-send]').click()
			await page.locator('[data-submit-review]').waitFor({ state: 'detached', timeout: 15_000 })
			expect(await submittedRefs(threadId)).toEqual([{ kind: 'checks_run', evidence: newestRun }])
		}
		finally { await page.context().close() }
	}, 120_000)

	it('preselects the passing replay for an interaction change, and cites a stale Flow trace without being refused', async () => {
		const threadId = await seedThread('The Flow and the click handling changed.')
		const page = await openSubmit(threadId)
		try {
			await row(page, staleTrace).waitFor({ timeout: 15_000 })
			await pickDomains(page, ['UX Flow', 'Interaction (steps, Widget Events)'])
			await expect.poll(() => checked(page, passingReplay), { timeout: 10_000 }).toBe('true')
			// A trace that is not current is not preselected, and a replay with a failed assertion is not either.
			expect(await checked(page, staleTrace)).toBe('false')
			expect(await checked(page, failingReplay)).toBe('false')
			// A passing replay that is stale is not preselected either, and stays selectable, never refused.
			expect(await checked(page, staleReplay)).toBe('false')
			expect(await box(page, staleTrace).isEnabled()).toBe(true)
			expect(await box(page, staleReplay).isEnabled()).toBe(true)
			await box(page, staleTrace).click()
			await box(page, staleReplay).click()
			expect(await checked(page, staleTrace)).toBe('true')
			expect(await checked(page, staleReplay)).toBe('true')
			await page.locator('[data-submit-send]').click()
			await page.locator('[data-submit-review]').waitFor({ state: 'detached', timeout: 15_000 })
			const refs = await submittedRefs(threadId) as { kind: string; evidence: string }[]
			expect(refs.map(ref => `${ref.kind} ${ref.evidence}`).sort()).toEqual([`flow_trace ${staleTrace}`, `interaction_replay ${passingReplay}`, `interaction_replay ${staleReplay}`].sort())
		}
		finally { await page.context().close() }
	}, 120_000)
})
