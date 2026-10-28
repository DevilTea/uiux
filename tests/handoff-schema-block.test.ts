import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { FileNativePersistence } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { artifactShardsPath, CURRENT_TEST_LAYOUT, writeCurrentWorkspace, writeManifest } from './support/workspace-layout'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const ASSET_ID = '55555555-5555-4555-8555-555555555555'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const view = {
	id: VIEW_ID,
	name: 'Checkout',
	ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
	variants: {},
	spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
}

async function seedWorkspace(schemaVersion: number): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-handoff-block-'))
	roots.push(root)
	await mkdir(join(root, 'views'), { recursive: true })
	await mkdir(join(root, 'assets', ASSET_ID), { recursive: true })
	await writeCurrentWorkspace(root)
	if (schemaVersion !== CURRENT_WORKSPACE_SCHEMA_VERSION) await writeManifest(root, { schemaVersion, i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {} })
	await writeFile(join(root, 'views', `${VIEW_ID}.view.json`), `${JSON.stringify(view)}\n`)
	await writeFile(join(root, 'assets', ASSET_ID, 'asset.json'), `${JSON.stringify({ id: ASSET_ID, name: 'icon', contentFilename: 'icon.svg', mediaType: 'image/svg+xml' })}\n`)
	await writeFile(join(root, 'assets', ASSET_ID, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
	return root
}

function open(root: string): FileNativePersistence {
	return new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
}

async function artifactFiles(root: string): Promise<string[]> {
	return readdir(artifactShardsPath(root, CURRENT_TEST_LAYOUT)).catch(() => [])
}

describe('read-only Handoff assessment on a Workspace at an older schemaVersion', () => {
	it('returns blocked workspace.schema_unsupported for assess and export instead of throwing, and writes nothing', async () => {
		const root = await seedWorkspace(5)
		const app = createWorkspaceApplicationSession(open(root))
		const assessed = await app.assessHandoffReadiness({ roots: [{ type: 'view', viewId: VIEW_ID }] })
		expect(assessed).toMatchObject({ status: 'blocked', key: 'handoff', code: 'workspace.schema_unsupported' })
		// Clause 01a14928-275b-74d5-ad43-c82932e39cb3: the version read, the current one and `uiux init`, never `uiux migrate`.
		const message = (assessed as { message?: string }).message
		expect(message).toContain('schemaVersion 5')
		expect(message).toContain(`schemaVersion ${CURRENT_WORKSPACE_SCHEMA_VERSION}`)
		expect(message).toContain('uiux init')
		expect(JSON.stringify(assessed)).not.toContain('migrat')
		expect(assessed.diagnostics?.[0]).toMatchObject({ code: 'workspace.schema_unsupported', path: '/schemaVersion' })
		const exported = await app.exportHandoff({ roots: [{ type: 'workspace' }] })
		expect(exported).toMatchObject({ status: 'blocked', code: 'workspace.schema_unsupported' })
		expect(await artifactFiles(root)).toEqual([])
	})

	it('assesses a current Workspace without materializing closure artifacts, which export still stores', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const app = createWorkspaceApplicationSession(open(root))
		const assessed = await app.assessHandoffReadiness({ roots: [{ type: 'workspace' }] })
		expect(assessed.status).toBe('ok')
		expect(JSON.stringify(assessed)).not.toContain('persistence.')
		expect(await artifactFiles(root)).toEqual([])
		const exported = await app.exportHandoff({ roots: [{ type: 'workspace' }] })
		expect(exported.status).toBe('exported')
		const stored = await artifactFiles(root)
		expect(stored.length).toBeGreaterThan(0)
		// Export stored the Asset content under the same identity the read-only assessment computed.
		const assetSnapshot = exported.status === 'exported' ? exported.manifest?.resources.find(resource => resource.type === 'asset') : undefined
		const digest = (assetSnapshot as { contentDigest?: string } | undefined)?.contentDigest
		expect(digest).toMatch(/^sha256:/u)
		expect(await open(root).artifacts.read(digest!)).toBeDefined()
	})
})
