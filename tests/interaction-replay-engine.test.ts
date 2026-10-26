import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PREVIEW_LEFT_CODE, replayInteractions } from '../src/application/services/interaction-replay'

/**
 * The replay engine against a bare page standing in for the Preview (Clause 01a17762-b467-7da6-9a61-59c1af1ba6af):
 * a replay that leaves the Preview document fails the run with its own diagnostic, not with a missing-hooks error.
 */

let browser: Browser

beforeAll(async () => {
	browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
	await browser?.close()
})

const hooks = `window.__UIUX_CAPTURE_HARNESS__ = { watchWidgetEvent: async () => true, widgetEventOccurrences: async () => [], readWidgetState: async () => ({ found: false }) };`
const VIEW = '11111111-1111-4111-8111-111111111111'
const steps = [{ action: 'click' as const, target: { viewId: VIEW, widgetId: 'go' } }]
const assertions = [{ expect: { widgetEvent: { widgetId: 'go', name: 'click' } } }]

async function page(html: string, withHooks = true): Promise<Page> {
	const created = await browser.newPage()
	await created.setContent(`<script>${withHooks ? hooks : ''}</script>${html}`)
	return created
}

describe('replayInteractions leaving the Preview document', () => {
	it('replays a document that has the hooks', async () => {
		const target = await page('<button data-widget-id="go">Go</button>')
		try { expect(await replayInteractions(target, { steps, assertions })).toEqual({ status: 'replayed', results: ['fail'] }) }
		finally { await target.close() }
	})

	it('names a navigation as the replay leaving the Preview document', async () => {
		const target = await page('<button data-widget-id="go" onclick="location.href=\'about:blank\'">Go</button>')
		try {
			const outcome = await replayInteractions(target, { steps, assertions })
			expect(outcome).toMatchObject({ status: 'failed', diagnostics: [{ code: PREVIEW_LEFT_CODE }] })
			if (outcome.status === 'failed') expect(outcome.diagnostics[0]!.message).toContain('navigated away from the Preview document')
		}
		finally { await target.close() }
	})

	it('names a page the actions opened', async () => {
		const target = await page('<button data-widget-id="go" onclick="window.open(\'about:blank\')">Go</button>')
		try {
			const outcome = await replayInteractions(target, { steps, assertions })
			expect(outcome).toMatchObject({ status: 'failed', diagnostics: [{ code: PREVIEW_LEFT_CODE }] })
			if (outcome.status === 'failed') expect(outcome.diagnostics[0]!.message).toContain('opened another page')
		}
		finally {
			for (const open of target.context().pages()) await open.close()
		}
	})

	it('names a document without the harness hooks, not a missing-hooks error', async () => {
		const target = await page('<button data-widget-id="go">Go</button>', false)
		try {
			const outcome = await replayInteractions(target, { steps, assertions })
			expect(outcome).toMatchObject({ status: 'failed', diagnostics: [{ code: PREVIEW_LEFT_CODE }] })
			if (outcome.status === 'failed') expect(outcome.diagnostics[0]!.message).not.toContain('hooks are missing')
		}
		finally { await target.close() }
	})
})
