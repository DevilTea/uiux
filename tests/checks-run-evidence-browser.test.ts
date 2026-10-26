import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Page } from 'playwright'

import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { FileNativePersistence } from '../src/persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Run Checks writes its result as one immutable `checks_run` Evidence record (Rule
 * 01a115cd-bc2c-795f-babe-0d19eb80de96, Clauses 01a17670-d442-7068-8a08-c6e4ab9c09ae and
 * 01a17671-11bf-7711-887b-121a02602cf4) against the built server and a real browser, and shows the last
 * recorded run in Overview › Checks. A member without `evidence.capture` still gets the run, and is told
 * it was not recorded.
 */

let server: WorkbenchServer

beforeAll(async () => {
	server = await startWorkbenchServer()
}, 120_000)

afterAll(async () => {
	await server?.close()
})

async function checksRuns(): Promise<readonly Readonly<{ identity: string; value: FormalEvidenceRecord }>[]> {
	const persistence = new FileNativePersistence({ root: server.workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	return persistence.artifacts.readAllCandidateJson<FormalEvidenceRecord>({ tolerateErrors: true, select: value => value?.kind === 'checks_run' ? value : undefined })
}

async function digestAfterRun(page: Page, previous: string | null): Promise<string> {
	await page.locator('[data-run-checks]').click()
	const recorded = page.locator('[data-checks-recorded]')
	await recorded.waitFor({ timeout: 60_000 })
	// The state after this click is a record that is not the previous one.
	await page.waitForFunction(
		previousDigest => document.querySelector('[data-checks-recorded]')?.getAttribute('data-evidence-digest') !== previousDigest,
		previous,
		{ timeout: 60_000 },
	)
	return (await recorded.getAttribute('data-evidence-digest'))!
}

describe('Run Checks as Evidence in the Workbench', () => {
	it('records one checks_run record per run, two for two runs with identical results, and shows the last one', async () => {
		const browser = await chromium.launch({ headless: true })
		try {
			const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
			await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
			const page = await context.newPage()
			const posts: string[] = []
			page.on('request', (request) => {
				if (request.method() === 'POST' && request.url().endsWith('/api/checks/runs')) posts.push(request.url())
			})
			await page.goto(`${server.origin}/?tab=checks`, { waitUntil: 'load' })
			expect(await checksRuns()).toEqual([])
			expect(await page.locator('[data-checks-recorded]').count()).toBe(0)

			const first = await digestAfterRun(page, null)
			expect(posts).toHaveLength(1)
			const afterFirst = await checksRuns()
			expect(afterFirst.map(entry => entry.identity)).toEqual([first])
			const firstRecord = afterFirst[0]!.value
			expect(firstRecord).toMatchObject({ schemaVersion: 1, kind: 'checks_run', artifactRefs: [] })
			// The record carries the four sources of the run, never the live Preview's two.
			expect((firstRecord.data as { sources: { source: string }[] }).sources.map(entry => entry.source)).toEqual(['validation', 'translation', 'catalog', 'product-kit'])
			const shown = await page.locator('[data-checks-recorded]').textContent()
			expect(shown).toContain(first.replace(/^sha256:/u, '').slice(0, 12))
			// The record reads back through the artifact route as the stored bytes.
			const read = await fetch(`${server.origin}/api/artifacts/${encodeURIComponent(first)}`, { headers: server.headers })
			expect(read.status).toBe(200)

			const second = await digestAfterRun(page, first)
			expect(posts).toHaveLength(2)
			expect(second).not.toBe(first)
			const afterSecond = await checksRuns()
			expect(afterSecond.map(entry => entry.identity).sort()).toEqual([first, second].sort())
			const [a, b] = [firstRecord, afterSecond.find(entry => entry.identity === second)!.value]
			// The same Workspace gives the same result; only ranAt tells the two records apart.
			expect(b.data).toEqual(a.data)
			expect(b.coverage).toEqual(a.coverage)
			expect((b.executionContext as { ranAt: string }).ranAt).not.toBe((a.executionContext as { ranAt: string }).ranAt)
			expect(await page.locator('[data-checks-recorded]').getAttribute('data-evidence-digest')).toBe(second)
		}
		finally {
			await browser.close()
		}
	}, 180_000)

	it('runs for a member without evidence.capture, says the run was not recorded, and writes nothing', async () => {
		const viewer = await sessionCookieFor(server.origin, await provisionToken(server.workspaceRoot, { nickname: 'checks-run-viewer', preset: 'viewer' }))
		const before = (await checksRuns()).length
		const browser = await chromium.launch({ headless: true })
		try {
			const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
			await context.addCookies([{ ...viewer, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
			const page = await context.newPage()
			const posts: string[] = []
			page.on('request', (request) => {
				if (request.url().endsWith('/api/checks/runs')) posts.push(request.url())
			})
			await page.goto(`${server.origin}/?tab=checks`, { waitUntil: 'load' })
			await page.locator('[data-run-checks]').click()
			const note = page.locator('[data-checks-record-note="not_permitted"]')
			await note.waitFor({ timeout: 60_000 })
			expect(await note.textContent()).toContain('evidence.capture')
			// The run itself still reported its sources.
			expect(await page.locator('[data-check-source="validation"]').getAttribute('data-check-source-state')).toBe('completed')
			expect(await page.locator('[data-checks-recorded]').count()).toBe(0)
			expect(posts).toEqual([])
		}
		finally {
			await browser.close()
		}
		expect((await checksRuns()).length).toBe(before)
		// The route refuses the same member, and still writes nothing.
		const refused = await fetch(`${server.origin}/api/checks/runs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `${viewer.name}=${viewer.value}` }, body: '{}' })
		expect(refused.status).toBe(403)
		expect((await checksRuns()).length).toBe(before)
	}, 120_000)
})
