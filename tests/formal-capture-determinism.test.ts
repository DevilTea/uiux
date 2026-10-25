import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Issue #344: two formal captures of the same View in the same render context, with nothing changed
 * in between, store the same screenshot bytes and so the same Evidence identity. Measured before
 * this test: 72 captures of the fixture View (3 Viewports, 4 captures in parallel per round)
 * produced one screenshot digest per Viewport.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
let server: WorkbenchServer | undefined

afterEach(async () => {
	await server?.close()
	server = undefined
})

describe('formal capture determinism (issue #344)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('stores the same screenshot and Evidence digests for consecutive captures of an unchanged context', async () => {
		server = await startWorkbenchServer()
		const persistence = new FileNativePersistence({ root: server.workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const app = createWorkspaceApplicationSession(persistence, { serverOrigin: server.origin, captureCookie: () => server!.cookie })
		const context = { viewId: VIEW_ID, locale: 'en-US', viewportId: 'tablet', viewport: { width: 1024, height: 768 }, themeId: 'light' }

		const identities: Array<{ evidenceDigest: string, screenshotDigest: string }> = []
		for (let round = 0; round < 3; round++) {
			const result = await app.captureFormalEvidence({ contexts: [context] })
			const captured = result.results[0]
			expect(captured, JSON.stringify(result)).toMatchObject({ status: 'captured' })
			if (captured?.status !== 'captured') return
			identities.push({ evidenceDigest: String(captured.evidenceDigest), screenshotDigest: String(captured.screenshotDigest) })
		}
		expect(new Set(identities.map(identity => identity.screenshotDigest)).size).toBe(1)
		expect(new Set(identities.map(identity => identity.evidenceDigest)).size).toBe(1)
	})
})
