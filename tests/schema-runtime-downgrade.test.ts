import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { appendReviewMessageForHttp } from '../src/server/authoring-http'
import { scoped, testMember } from './support/access'
import { createCurrentWorkspace, writeManifest } from './support/workspace-layout'

/**
 * Discussion #231 (Part 17), Change 1.2: a Workspace whose manifest changes to an older
 * `schemaVersion` while the server runs is `unsupported` (Rule 01a1144e-4fcf-7b8a-8978-73b1a0cc31f4),
 * so a Review reply and a formal capture are refused with `workspace.schema_unsupported` and nothing
 * is written. Handoff, Checkpoints, restore and the Product Kit have their own tests.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Every file under `root` with its content, to show that nothing was written. */
async function tree(root: string): Promise<Readonly<Record<string, string>>> {
	const files: Record<string, string> = {}
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue
		const path = join(entry.parentPath, entry.name)
		files[path.slice(root.length)] = await readFile(path, 'base64')
	}
	return files
}

/** A running session over a current Workspace with one View and one Review thread, then a manifest downgraded to 5. */
async function downgradedWhileRunning() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-schema-downgrade-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: { light: {} } })
	const app = createWorkspaceApplicationSession(persistence)
	const view = await app.createView({ id: VIEW_ID, name: 'Checkout', spec: { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] } })
	const review = await app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
	if (view.status !== 'created' || review.status !== 'created') throw new Error('fixture')
	await writeManifest(root, { schemaVersion: 5, i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: { light: {} } })
	return { root, app, reviewRevision: review.revision }
}

describe('a manifest downgraded while the server runs (Discussion #231, Change 1.2)', () => {
	it('refuses a Review reply with workspace.schema_unsupported over HTTP (422) and writes nothing', async () => {
		const { root, app, reviewRevision } = await downgradedWhileRunning()
		const before = await tree(root)
		const reply = await appendReviewMessageForHttp(scoped(app, testMember({ nickname: 'rita', preset: 'reviewer' })), REVIEW_ID, { expectedRevision: reviewRevision, body: 'Still here?' })
		expect(reply.status).toBe(422)
		expect(JSON.stringify(reply.body)).toContain('workspace.schema_unsupported')
		expect(JSON.stringify(reply.body)).not.toContain('migrat')
		expect(await tree(root)).toEqual(before)
	})

	it('refuses a formal capture with workspace.schema_unsupported before launching a browser, and writes nothing', async () => {
		const { root, app } = await downgradedWhileRunning()
		const before = await tree(root)
		const captured = await scoped(app, testMember({ nickname: 'ed', preset: 'editor' })).captureFormalEvidence({
			contexts: [{ viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }],
		})
		// `POST /api/evidence/capture` answers a `failed` result with 422.
		expect(captured).toMatchObject({ status: 'failed', summary: { total: 1, captured: 0, failed: 1 } })
		const diagnostics = 'results' in captured ? captured.results[0]?.diagnostics : undefined
		expect(diagnostics).toEqual([expect.objectContaining({ code: 'workspace.schema_unsupported' })])
		expect(JSON.stringify(captured)).not.toContain('migrat')
		expect(await tree(root)).toEqual(before)
	})
})
