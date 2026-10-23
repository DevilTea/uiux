import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readVersionBlobForHttp, resolveVersionAssetsForHttp } from '../src/server/history-http'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { HUMAN_OWNER, scoped, testMember } from './support/access'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * A version frame resolves the Assets its View binds as that version records them (Discussion #241
 * owner ruling 2 of 2026-10-23): the `url` is the version blob of the recorded content (Clause
 * 01a167f4-401d-7330-ac65-0a900adbccd6), one of the version reads for Preview (`history.read`).
 */

const ASSET_ID = '77777777-7777-4777-8777-777777777777'
const MISSING_ID = '88888888-8888-4888-8888-888888888888'
const FIRST = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const SECOND = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2])

let root: string
const previous = process.env.UIUX_WORKSPACE_ROOT
let versionId: string

function digestOf(bytes: Uint8Array): string {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-asset-version-')))
	process.env.UIUX_WORKSPACE_ROOT = root
	const runtime = getSelectedWorkspaceServerRuntime()
	await createCurrentWorkspace(runtime.persistence, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	await runtime.persistence.locales.create('en-US', {})
	expect(await runtime.historyRecorder.start()).toMatchObject({ enabled: true })
	const owner = scoped(runtime.app, HUMAN_OWNER)
	const created = await owner.createAsset({ id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png', contentBase64: Buffer.from(FIRST).toString('base64') })
	expect(created).toMatchObject({ status: 'created' })
	const checkpoint = await owner.createCheckpoint({ name: 'First logo' })
	expect(checkpoint).toMatchObject({ status: 'created' })
	versionId = (checkpoint as { versionId: string }).versionId
	const replaced = await owner.replaceAsset({ assetId: ASSET_ID, expectedRevision: (created as { revision: string }).revision, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png', contentBase64: Buffer.from(SECOND).toString('base64') })
	expect(replaced).toMatchObject({ status: 'updated' })
})

afterAll(async () => {
	await closeSelectedWorkspaceServerRuntime()
	if (previous === undefined) delete process.env.UIUX_WORKSPACE_ROOT
	else process.env.UIUX_WORKSPACE_ROOT = previous
	await rm(root, { recursive: true, force: true })
})

describe('a version frame\'s Asset resolution', () => {
	it('resolves each bound Asset to the content the version records, served as its version blob', async () => {
		const runtime = getSelectedWorkspaceServerRuntime()
		const result = await resolveVersionAssetsForHttp(scoped(runtime.app, HUMAN_OWNER), versionId, `${ASSET_ID},${MISSING_ID}`)
		expect(result.status).toBe(200)
		expect(result.body).toEqual({
			status: 'found',
			versionId,
			assets: {
				[ASSET_ID]: { state: 'ready', value: { url: `/api/history/blobs/${digestOf(FIRST)}`, mediaType: 'image/png', contentDigest: digestOf(FIRST) } },
				[MISSING_ID]: { state: 'blocked', diagnostics: [expect.objectContaining({ code: 'asset.missing_reference' })] },
			},
		})
		// The URL serves those recorded bytes, not the current content.
		const blob = await readVersionBlobForHttp(scoped(runtime.app, HUMAN_OWNER), digestOf(FIRST))
		expect(blob).toMatchObject({ status: 200, body: FIRST })
		// Served as the image its signature shows, so an `<img>` renders it; still sandboxed and never sniffed.
		expect(blob.headers).toMatchObject({ 'Content-Type': 'image/png', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': expect.stringContaining('sandbox') })
	})

	it('is a version read for Preview: it needs `history.read`, and refuses malformed IDs', async () => {
		const runtime = getSelectedWorkspaceServerRuntime()
		const noHistory = testMember({ nickname: 'noah', kind: 'human', keys: ['workspace.read'], credential: 'session' })
		expect(await resolveVersionAssetsForHttp(scoped(runtime.app, noHistory), versionId, ASSET_ID)).toMatchObject({ status: 403 })
		expect(await resolveVersionAssetsForHttp(scoped(runtime.app, HUMAN_OWNER), versionId, 'logo')).toMatchObject({ status: 400, body: { code: 'invalid_asset_ids' } })
		expect(await resolveVersionAssetsForHttp(scoped(runtime.app, HUMAN_OWNER), MISSING_ID, ASSET_ID)).toMatchObject({ status: 404 })
	})
})
