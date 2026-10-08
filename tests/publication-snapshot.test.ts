import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileNativePersistence } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import {
	createPublicationSnapshot,
	isPublicationSnapshot,
	sanitizePublicationAdapterDiagnostic,
} from '../src/application/services/publication-snapshot'
import type { ViewResource } from '../src/domain/views/schema'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

const roots: string[] = []
const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const ASSET_ID = '22222222-2222-4222-8222-222222222222'

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createWorkspace() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-publication-test-'))
	roots.push(root)
	await mkdir(join(root, '.uiux'), { recursive: true })
	await writeFile(join(root, '.uiux', 'workspace.json'), JSON.stringify({
		schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		i18n: { defaultLocale: 'en-US' },
		adapters: [],
		viewports: {
			desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } },
		},
		themes: { light: { label: 'Light' } },
	}))

	const persistence = new FileNativePersistence({
		root,
		schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
	})
	await persistence.locales.create('en-US', { 'app.title': 'Published UIUX' })

	const view: ViewResource = {
		id: VIEW_ID,
		name: 'Published View',
		feature: 'publication',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: {
			intent: 'Exercise static publication materialization.',
			entryConditions: [],
			interactionRules: [],
			constraints: [],
			accessibility: [],
			references: [],
			decisions: [],
		},
	}
	await persistence.views.create(VIEW_ID, view)

	const assetBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
	await persistence.assets.create(ASSET_ID, {
		metadata: {
			id: ASSET_ID,
			name: 'Published icon',
			contentFilename: 'icon.svg',
			mediaType: 'image/svg+xml',
		},
		content: assetBytes,
	})

	return {
		app: createWorkspaceApplicationSession(persistence),
	}
}

describe('Static Publication snapshot', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('materializes the whole Workspace through the shared application session', async () => {
		const { app } = await createWorkspace()
		const snapshot = await createPublicationSnapshot(app, {
			state: 'valid',
			hash: 'adapterhash',
		}, {
			generatedAt: '2026-10-05T00:00:00.000Z',
			sourceRevision: 'abc123',
		})

		expect(isPublicationSnapshot(snapshot)).toBe(true)
		expect(snapshot.schemaVersion).toBe(1)
		expect(snapshot.sourceRevision).toBe('abc123')
		expect(snapshot.workspace.resource.schemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)
		expect(snapshot.resources.view).toHaveLength(1)
		expect(snapshot.resources.locale).toHaveLength(1)
		expect(snapshot.resources.asset).toHaveLength(1)
		expect(snapshot.discovery.view[0]?.key).toBe(VIEW_ID)
		expect(snapshot.preview).toEqual({
			state: 'valid',
			hash: 'adapterhash',
			runtimeFile: '_uiux/preview-runtime-adapterhash.mjs',
		})
		expect(snapshot.files.assets[ASSET_ID]).toMatchObject({
			file: `_uiux/assets/${ASSET_ID}/icon.svg`,
			filename: 'icon.svg',
			mediaType: 'image/svg+xml',
		})
		expect(JSON.stringify(snapshot)).not.toContain(process.cwd())
	})

	it('sanitizes adapter diagnostics before they enter a public snapshot', () => {
		const diagnostic = sanitizePublicationAdapterDiagnostic({
			code: 'adapter.manifest_load_failed',
			path: '/adapters/0/moduleSpecifier',
			message: 'Cannot import /home/private/project/design/adapters/reference.ts',
		})
		expect(diagnostic).toEqual({
			code: 'adapter.manifest_load_failed',
			path: '/adapters/0/moduleSpecifier',
			message: 'Workspace adapter validation failed. Inspect the selected Workspace locally for details.',
		})
		expect(JSON.stringify(diagnostic)).not.toContain('/home/private')
	})

	it('keeps publication identity independent of generation time and source revision provenance', async () => {
		const { app } = await createWorkspace()
		const preview = {
			state: 'invalid' as const,
			diagnostics: [{ code: 'adapter.missing', path: '/adapters', message: 'No adapter.' }],
		}
		const first = await createPublicationSnapshot(app, preview, {
			generatedAt: '2026-10-05T00:00:00.000Z',
			sourceRevision: 'first',
		})
		const second = await createPublicationSnapshot(app, preview, {
			generatedAt: '2026-10-05T01:00:00.000Z',
			sourceRevision: 'second',
		})

		expect(second.publicationIdentity).toBe(first.publicationIdentity)
		expect(second.generatedAt).not.toBe(first.generatedAt)
		expect(second.sourceRevision).not.toBe(first.sourceRevision)
	})
})
