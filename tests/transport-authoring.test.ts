import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { decodeStrictBase64 } from '../src/domain/assets/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { FileNativePersistence } from '../src/persistence'
import { reviewRelativePath } from '../src/persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { isCaseSensitiveDirectory } from './support/filesystem'
import { AGENT_EDITOR, HUMAN_OWNER, connectMcp, scoped } from './support/access'
import type { MemberPrincipal } from '../src/application/access/principal'
import {
	appendReviewMessageForHttp,
	createAssetForHttp,
	createFlowForHttp,
	createLocaleForHttp,
	createReviewThreadForHttp,
	createViewForHttp,
	promoteReviewToDecisionForHttp,
	readAssetContentForHttp,
	reanchorReviewThreadForHttp,
	reopenReviewThreadForHttp,
	resolveReviewThreadForHttp,
	submitReadyForReviewForHttp,
	updateFlowForHttp,
	updateLocaleForHttp,
	updateViewSpecForHttp,
	updateViewStructureForHttp,
	updateWorkspaceSettingsForHttp,
} from '../src/server/authoring-http'
import { listResourcesForHttp } from '../src/server/resource-discovery'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const DECISION_ID = '22222222-2222-4222-8222-222222222222'
const FLOW_ID = '33333333-3333-4333-8333-333333333333'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const ASSET_ID = '55555555-5555-4555-8555-555555555555'
const OTHER_VIEW_ID = '66666666-6666-4666-8666-666666666666'
const SECOND_REVIEW_ID = '77777777-7777-4777-8777-777777777777'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MCP View authoring', () => {
	it('creates a spec-first View, returns its stable Resource URI, and updates the Spec with revision CAS', async () => {
		const { app } = await emptySession()
		const { client, close } = await connectedClient(app)
		try {
			const created = await client.callTool({
				name: 'create_view',
				arguments: {
					id: VIEW_ID,
					name: 'Workbench overview',
					feature: 'workbench',
					spec: spec('Browse the selected Workspace.'),
				},
			})
			expect(created.isError).not.toBe(true)
			const createResult = created.structuredContent as { status: string; key: string; revision: string; resourceUri: string }
			expect(createResult).toMatchObject({
				status: 'created',
				key: VIEW_ID,
				resourceUri: `uiux://view/${VIEW_ID}`,
			})

			const readAfterCreate = await app.readPointResource('view', VIEW_ID)
			expect(readAfterCreate?.kind).toBe('view')
			if (readAfterCreate?.kind !== 'view') return
			expect(readAfterCreate.resource.ir).toEqual({ type: 'RootShell', id: 'root', slots: { content: [] } })
			expect(readAfterCreate.resource.variants).toEqual({})
			expect(readAfterCreate.resource.spec.decisions).toEqual([])

			const updated = await client.callTool({
				name: 'update_view_spec',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: createResult.revision,
					spec: spec('Browse and inspect canonical UIUX specs.', ['Workspace is selected.']),
				},
			})
			expect(updated.isError).not.toBe(true)
			const updateResult = updated.structuredContent as { status: string; revision: string }
			expect(updateResult.status).toBe('updated')
			expect(updateResult.revision).not.toBe(createResult.revision)

			const stale = await client.callTool({
				name: 'update_view_spec',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: createResult.revision,
					spec: spec('This stale write must not win.'),
				},
			})
			expect(stale.isError).toBe(true)
			expect(stale.structuredContent).toMatchObject({ status: 'conflict', key: VIEW_ID, currentRevision: updateResult.revision })

			const finalRead = await app.readPointResource('view', VIEW_ID)
			expect(finalRead?.kind === 'view' ? finalRead.resource.spec.intent : undefined)
				.toBe('Browse and inspect canonical UIUX specs.')
		}
		finally { await close() }
	})

	it('keeps Decisions outside the direct MCP Spec replacement boundary', async () => {
		const { persistence, app } = await emptySession()
		const resource: ViewResource = {
			id: VIEW_ID,
			name: 'Decision-bearing View',
			ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
			variants: {},
			spec: {
				...spec('Original'),
				decisions: [{
					id: DECISION_ID,
					question: 'Keep the split-pane layout?',
					status: 'pending',
					history: [],
				}],
			},
		}
		const revision = await persistence.views.create(VIEW_ID, resource)
		const { client, close } = await connectedClient(app)
		try {
			const updated = await client.callTool({
				name: 'update_view_spec',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: revision,
					spec: spec('Changed descriptive content.'),
				},
			})
			expect(updated.isError).not.toBe(true)
			const read = await app.readPointResource('view', VIEW_ID)
			expect(read?.kind === 'view' ? read.resource.spec.decisions : undefined).toEqual(resource.spec.decisions)

			const triesToWriteDecisions = await client.callTool({
				name: 'update_view_spec',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: (updated.structuredContent as { revision: string }).revision,
					spec: { ...spec('Rejected shape.'), decisions: [] },
				},
			})
			expect(triesToWriteDecisions.isError).toBe(true)
			const unchanged = await app.readPointResource('view', VIEW_ID)
			expect(unchanged?.kind === 'view' ? unchanged.resource.spec.intent : undefined).toBe('Changed descriptive content.')
		}
		finally { await close() }
	})

	it('returns a structured invalid result for a malformed update View id instead of leaking a persistence exception', async () => {
		const { app } = await emptySession()
		const { client, close } = await connectedClient(app)
		try {
			const invalid = await client.callTool({
				name: 'update_view_spec',
				arguments: {
					viewId: 'workbench-overview',
					expectedRevision: 'r_observed',
					spec: spec('Must fail cleanly.'),
				},
			})
			expect(invalid.isError).toBe(true)
			expect(invalid.structuredContent).toMatchObject({
				status: 'invalid',
				key: 'workbench-overview',
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/viewId' }],
			})
		}
		finally { await close() }
	})

	it('fails invalid canonical View input before creating a file', async () => {
		const { app } = await emptySession()
		const { client, close } = await connectedClient(app)
		try {
			const invalid = await client.callTool({
				name: 'create_view',
				arguments: {
					id: VIEW_ID,
					name: 'Invalid references',
					spec: {
						...spec('Must fail.'),
						references: [{ type: 'view', viewId: 'not-a-uuid' }],
					},
				},
			})
			expect(invalid.isError).toBe(true)
			expect(invalid.structuredContent).toMatchObject({ status: 'invalid', key: VIEW_ID })
			expect(await app.readPointResource('view', VIEW_ID)).toBeUndefined()
		}
		finally { await close() }
	})

	it('updates View render structure (IR + variants) atomically with revision CAS', async () => {
		const { app } = await emptySession()
		const { client, close } = await connectedClient(app)
		try {
			const created = await client.callTool({
				name: 'create_view',
				arguments: {
					id: VIEW_ID,
					name: 'Structure authoring view',
					feature: 'workbench',
					spec: spec('Inspect structure updates.'),
				},
			})
			expect(created.isError).not.toBe(true)
			const createResult = created.structuredContent as { revision: string }

			const newIr = {
				type: 'RootShell',
				id: 'root',
				slots: {
					content: [
						{
							type: 'Section',
							id: 'section-1',
							props: { heading: 'Hello World' },
						},
					],
				},
			}
			const newVariants = {
				compact: {
					state: {
						'section-1': {
							collapsed: true,
						},
					},
				},
			}

			const updated = await client.callTool({
				name: 'update_view_structure',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: createResult.revision,
					ir: newIr,
					variants: newVariants,
				},
			})
			expect(updated.isError).not.toBe(true)
			const updateResult = updated.structuredContent as { status: string; revision: string; resourceUri: string }
			expect(updateResult).toMatchObject({
				status: 'updated',
				key: VIEW_ID,
				resourceUri: `uiux://view/${VIEW_ID}`,
			})
			expect(updateResult.revision).not.toBe(createResult.revision)

			const read = await app.readPointResource('view', VIEW_ID)
			expect(read?.kind).toBe('view')
			if (read?.kind !== 'view') return
			expect(read.resource.ir).toEqual(newIr)
			expect(read.resource.variants).toEqual(newVariants)
			expect(read.revision).toBe(updateResult.revision)
		}
		finally { await close() }
	})

	it('preserves immutable identity, name, feature, and Spec including Decisions when updating structure', async () => {
		const { persistence, app } = await emptySession()
		const resource: ViewResource = {
			id: VIEW_ID,
			name: 'Preserved View',
			feature: 'workbench',
			ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
			variants: {},
			spec: {
				...spec('Original intent', ['Condition 1']),
				decisions: [{
					id: DECISION_ID,
					question: 'Decision to preserve?',
					status: 'decided',
					outcome: { summary: 'Preserved as-is.', rationale: 'Documented.' },
					history: [],
				}],
			},
		}
		const revision = await persistence.views.create(VIEW_ID, resource)
		const { client, close } = await connectedClient(app)
		try {
			const updated = await client.callTool({
				name: 'update_view_structure',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: revision,
					ir: {
						type: 'RootShell',
						id: 'root',
						slots: {
							content: [{ type: 'Panel', id: 'p1' }],
						},
					},
					variants: {
						expanded: {
							state: { p1: { open: true } },
						},
					},
				},
			})
			expect(updated.isError).not.toBe(true)
			const read = await app.readPointResource('view', VIEW_ID)
			expect(read?.kind).toBe('view')
			if (read?.kind !== 'view') return
			expect(read.resource.id).toBe(VIEW_ID)
			expect(read.resource.name).toBe('Preserved View')
			expect(read.resource.feature).toBe('workbench')
			expect(read.resource.spec).toEqual(resource.spec)
			expect(read.resource.spec.decisions).toEqual(resource.spec.decisions)
		}
		finally { await close() }
	})

	it('rejects stale revision CAS conflict when updating structure without mutating persistence', async () => {
		const { app } = await emptySession()
		const { client, close } = await connectedClient(app)
		try {
			const created = await client.callTool({
				name: 'create_view',
				arguments: {
					id: VIEW_ID,
					name: 'CAS conflict view',
					spec: spec('Base view.'),
				},
			})
			const createRev = (created.structuredContent as { revision: string }).revision

			const firstUpdate = await client.callTool({
				name: 'update_view_structure',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: createRev,
					ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'A', id: 'a' }] } },
					variants: {},
				},
			})
			expect(firstUpdate.isError).not.toBe(true)
			const latestRev = (firstUpdate.structuredContent as { revision: string }).revision

			const stale = await client.callTool({
				name: 'update_view_structure',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: createRev,
					ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'B', id: 'b' }] } },
					variants: {},
				},
			})
			expect(stale.isError).toBe(true)
			expect(stale.structuredContent).toMatchObject({
				status: 'conflict',
				key: VIEW_ID,
				currentRevision: latestRev,
			})

			const read = await app.readPointResource('view', VIEW_ID)
			expect(read?.kind === 'view' ? read.resource.ir : undefined).toEqual({
				type: 'RootShell',
				id: 'root',
				slots: { content: [{ type: 'A', id: 'a' }] },
			})
		}
		finally { await close() }
	})

	it('rejects invalid RootShell and invalid variant structures without mutating persistence', async () => {
		const { app } = await emptySession()
		const { client, close } = await connectedClient(app)
		try {
			const created = await client.callTool({
				name: 'create_view',
				arguments: {
					id: VIEW_ID,
					name: 'Validation test view',
					spec: spec('Base view.'),
				},
			})
			const initialRev = (created.structuredContent as { revision: string }).revision
			const baselineRead = await app.readPointResource('view', VIEW_ID)

			// 1. Invalid RootShell: wrong type
			const invalidRootType = await client.callTool({
				name: 'update_view_structure',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: initialRev,
					ir: { type: 'CustomShell', id: 'root', slots: { content: [] } },
					variants: {},
				},
			})
			expect(invalidRootType.isError).toBe(true)
			expect(invalidRootType.structuredContent).toMatchObject({
				status: 'invalid',
				key: VIEW_ID,
				diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'view.invalid_root_type' })]),
			})

			// 2. Invalid RootShell: nested RootShell
			const nestedRoot = await client.callTool({
				name: 'update_view_structure',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: initialRev,
					ir: {
						type: 'RootShell',
						id: 'root',
						slots: {
							content: [{ type: 'RootShell', id: 'nested' }],
						},
					},
					variants: {},
				},
			})
			expect(nestedRoot.isError).toBe(true)
			expect(nestedRoot.structuredContent).toMatchObject({
				status: 'invalid',
				key: VIEW_ID,
				diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'view.nested_root_shell' })]),
			})

			// 3. Invalid variant: empty variant name
			const invalidVariantName = await client.callTool({
				name: 'update_view_structure',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: initialRev,
					ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
					variants: {
						'': { state: {} },
					},
				},
			})
			expect(invalidVariantName.isError).toBe(true)
			expect(invalidVariantName.structuredContent).toMatchObject({
				status: 'invalid',
				key: VIEW_ID,
				diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'variant.empty_name' })]),
			})

			// 4. Invalid variant: empty widget id in state
			const invalidWidgetId = await client.callTool({
				name: 'update_view_structure',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: initialRev,
					ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
					variants: {
						compact: { state: { '': {} } },
					},
				},
			})
			expect(invalidWidgetId.isError).toBe(true)
			expect(invalidWidgetId.structuredContent).toMatchObject({
				status: 'invalid',
				key: VIEW_ID,
				diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'variant.empty_widget_id' })]),
			})

			// Ensure persistence was never touched across all invalid attempts
			const afterRead = await app.readPointResource('view', VIEW_ID)
			expect(afterRead).toEqual(baselineRead)
		}
		finally { await close() }
	})

	it('returns structured invalid result for malformed update view id in structure authoring', async () => {
		const { app } = await emptySession()
		const { client, close } = await connectedClient(app)
		try {
			const invalid = await client.callTool({
				name: 'update_view_structure',
				arguments: {
					viewId: 'not-a-uuid',
					expectedRevision: 'r_dummy',
					ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
					variants: {},
				},
			})
			expect(invalid.isError).toBe(true)
			expect(invalid.structuredContent).toMatchObject({
				status: 'invalid',
				key: 'not-a-uuid',
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/viewId' }],
			})
		}
		finally { await close() }
	})

	it('rejects unrelated fields at MCP transport due to strict schema', async () => {
		const { app } = await emptySession()
		const { client, close } = await connectedClient(app)
		try {
			const created = await client.callTool({
				name: 'create_view',
				arguments: {
					id: VIEW_ID,
					name: 'Strict schema view',
					spec: spec('Base view.'),
				},
			})
			const rev = (created.structuredContent as { revision: string }).revision

			const rejected = await client.callTool({
				name: 'update_view_structure',
				arguments: {
					viewId: VIEW_ID,
					expectedRevision: rev,
					ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
					variants: {},
					unrelatedField: 'must-fail',
				},
			})
			expect(rejected.isError).toBe(true)
		}
		finally { await close() }
	})
})

describe('Workspace manifest authoring', () => {
	it('updates workspace settings atomically with revision CAS, preserves schemaVersion, and reflects in point read', async () => {
		const { app } = await emptySession()
		const initialRead = await app.readPointResource('workspace', 'workspace')
		expect(initialRead?.kind).toBe('workspace')
		if (initialRead?.kind !== 'workspace') return
		const initialRev = initialRead.revision
		expect(initialRead.resource.schemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)

		const { client, close } = await connectedClient(app)
		try {
			const updated = await client.callTool({
				name: 'update_workspace_settings',
				arguments: {
					expectedRevision: initialRev,
					settings: {
						i18n: { defaultLocale: 'zh-TW' },
						adapters: [{ moduleSpecifier: '@deviltea/widget-vue' }],
						viewports: { mobile: { dimensions: { width: 375, height: 667 } } },
						themes: { dark: { mode: 'dark' } },
					},
				},
			})
			expect(updated.isError).not.toBe(true)
			const result = updated.structuredContent as { status: string; revision: string; resourceUri: string }
			expect(result).toMatchObject({
				status: 'updated',
				key: 'workspace',
				resourceUri: 'uiux://workspace',
			})
			expect(result.revision).not.toBe(initialRev)

			const readAfter = await app.readPointResource('workspace', 'workspace')
			expect(readAfter?.kind === 'workspace' ? readAfter.resource.schemaVersion : undefined).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)
			expect(readAfter?.kind === 'workspace' ? readAfter.resource.i18n.defaultLocale : undefined).toBe('zh-TW')
			expect(readAfter?.kind === 'workspace' ? readAfter.resource.adapters : undefined).toEqual([{ moduleSpecifier: '@deviltea/widget-vue' }])
		}
		finally { await close() }
	})

	it('rejects stale revision CAS conflict without mutating persistence', async () => {
		const { app } = await emptySession()
		const initialRead = await app.readPointResource('workspace', 'workspace')
		if (initialRead?.kind !== 'workspace') return

		const firstUpdate = await app.updateWorkspaceSettings({
			expectedRevision: initialRead.revision,
			settings: {
				i18n: { defaultLocale: 'en-US' },
				adapters: [],
				viewports: {},
				themes: { light: {} },
			},
		})
		expect(firstUpdate.status).toBe('updated')

		const { client, close } = await connectedClient(app)
		try {
			const stale = await client.callTool({
				name: 'update_workspace_settings',
				arguments: {
					expectedRevision: initialRead.revision,
					settings: {
						i18n: { defaultLocale: 'fr-FR' },
						adapters: [],
						viewports: {},
						themes: {},
					},
				},
			})
			expect(stale.isError).toBe(true)
			expect(stale.structuredContent).toMatchObject({ status: 'conflict', key: 'workspace' })

			const afterRead = await app.readPointResource('workspace', 'workspace')
			expect(afterRead?.kind === 'workspace' ? afterRead.resource.themes : undefined).toEqual({ light: {} })
		}
		finally { await close() }
	})

	it('rejects invalid workspace settings before atomic compare-and-swap', async () => {
		const { app } = await emptySession()
		const initialRead = await app.readPointResource('workspace', 'workspace')
		if (initialRead?.kind !== 'workspace') return

		const { client, close } = await connectedClient(app)
		try {
			const invalid = await client.callTool({
				name: 'update_workspace_settings',
				arguments: {
					expectedRevision: initialRead.revision,
					settings: {
						i18n: { defaultLocale: 'not_a_locale' },
						adapters: [],
						viewports: {},
						themes: {},
					},
				},
			})
			expect(invalid.isError).toBe(true)
			expect(invalid.structuredContent).toMatchObject({ status: 'invalid', key: 'workspace' })
		}
		finally { await close() }
	})

	it('provides HTTP transport parity for updating workspace settings', async () => {
		const { app } = await emptySession()
		const initialRead = await app.readPointResource('workspace', 'workspace')
		if (initialRead?.kind !== 'workspace') return

		const http = await updateWorkspaceSettingsForHttp(scoped(app), {
			expectedRevision: initialRead.revision,
			settings: {
				i18n: { defaultLocale: 'de-DE' },
				adapters: [],
				viewports: {},
				themes: {},
			},
		})
		expect(http.status).toBe(200)
		expect(http.body).toMatchObject({ status: 'updated', key: 'workspace' })

		const read = await app.readPointResource('workspace', 'workspace')
		expect(read?.kind === 'workspace' ? read.resource.i18n.defaultLocale : undefined).toBe('de-DE')
	})
})

describe('Locale authoring', () => {
	it('creates a canonical flat locale and updates it with revision CAS across MCP and HTTP', async () => {
		const { app } = await emptySession()
		const { client, close } = await connectedClient(app)
		try {
			const created = await client.callTool({
				name: 'create_locale',
				arguments: {
					locale: 'zh-TW',
					messages: { greeting: '你好', confirm: '確認' },
				},
			})
			expect(created.isError).not.toBe(true)
			const createResult = created.structuredContent as { status: string; key: string; revision: string; resourceUri: string }
			expect(createResult).toMatchObject({
				status: 'created',
				key: 'zh-TW',
				resourceUri: 'uiux://locale/zh-TW',
			})

			const read = await app.readPointResource('locale', 'zh-TW')
			expect(read).toMatchObject({
				kind: 'locale',
				key: 'zh-TW',
				resource: { greeting: '你好', confirm: '確認' },
			})

			// HTTP update parity
			const httpUpdated = await updateLocaleForHttp(scoped(app), 'zh-TW', {
				expectedRevision: createResult.revision,
				messages: { greeting: '您好', confirm: '確定' },
			})
			expect(httpUpdated.status).toBe(200)
			expect(httpUpdated.body).toMatchObject({ status: 'updated', key: 'zh-TW' })

			const readAfterUpdate = await app.readPointResource('locale', 'zh-TW')
			expect(readAfterUpdate?.kind === 'locale' ? readAfterUpdate.resource : undefined).toEqual({ greeting: '您好', confirm: '確定' })
		}
		finally { await close() }
	})

	it('fails creation if locale already exists without overwriting', async () => {
		const { app } = await emptySession()
		const first = await app.createLocale({ locale: 'en-US', messages: { title: 'First' } })
		expect(first.status).toBe('created')

		const { client, close } = await connectedClient(app)
		try {
			const duplicate = await client.callTool({
				name: 'create_locale',
				arguments: {
					locale: 'en-US',
					messages: { title: 'Overwritten?' },
				},
			})
			expect(duplicate.isError).toBe(true)
			expect(duplicate.structuredContent).toMatchObject({ status: 'already_exists', key: 'en-US' })

			const read = await app.readPointResource('locale', 'en-US')
			expect(read?.kind === 'locale' ? read.resource.title : undefined).toBe('First')
		}
		finally { await close() }
	})

	it('reports a case-variant locale file instead of aliasing it on create and update', async () => {
		const { root, app } = await emptySession()
		await mkdir(join(root, 'i18n'), { recursive: true })
		await writeFile(join(root, 'i18n', 'ja-jp.json'), '{"title":"variant"}')
		const caseSensitive = await isCaseSensitiveDirectory(root)

		const updated = await app.updateLocale({ locale: 'ja-JP', expectedRevision: `r_${'a'.repeat(43)}`, messages: { title: 'Updated' } })
		expect(updated.status).toBe('not_found')

		const created = await app.createLocale({ locale: 'ja-JP', messages: { title: 'Canonical' } })
		if (caseSensitive) {
			expect(created.status).toBe('created')
		}
		else {
			expect(created).toMatchObject({
				status: 'invalid',
				key: 'ja-JP',
				diagnostics: [expect.objectContaining({ code: 'i18n.invalid_locale_filename', path: '/i18n/ja-jp.json' })],
			})
			expect(await app.readPointResource('locale', 'ja-JP')).toBeUndefined()
		}
		expect(await readFile(join(root, 'i18n', 'ja-jp.json'), 'utf8')).toBe('{"title":"variant"}')
	})

	it('rejects stale revision CAS conflict on update without mutating persistence', async () => {
		const { app } = await emptySession()
		const created = await app.createLocale({ locale: 'ja-JP', messages: { title: 'Original' } })
		if (created.status !== 'created') return

		const updated = await app.updateLocale({
			locale: 'ja-JP',
			expectedRevision: created.revision,
			messages: { title: 'Updated' },
		})
		expect(updated.status).toBe('updated')

		const stale = await app.updateLocale({
			locale: 'ja-JP',
			expectedRevision: created.revision,
			messages: { title: 'Stale write' },
		})
		expect(stale.status).toBe('conflict')

		const read = await app.readPointResource('locale', 'ja-JP')
		expect(read?.kind === 'locale' ? read.resource.title : undefined).toBe('Updated')
	})

	it('rejects non-flat values and malformed BCP47 tags before touching disk', async () => {
		const { app } = await emptySession()
		const invalidTag = await app.createLocale({ locale: 'invalid_tag', messages: { title: 'Test' } })
		expect(invalidTag.status).toBe('invalid')

		const nonFlat = await app.createLocale({ locale: 'fr-FR', messages: { nested: { a: 'b' } } as unknown as Record<string, string> })
		expect(nonFlat.status).toBe('invalid')
	})
})

describe('UX Flow authoring', () => {
	it('creates a canonical UX Flow and updates it with revision CAS preserving immutable ID', async () => {
		const { app } = await emptySession()
		const step1 = '11111111-2222-4333-8444-555555555555'
		const step2 = '22222222-3333-4444-8555-666666666666'

		const { client, close } = await connectedClient(app)
		try {
			const created = await client.callTool({
				name: 'create_flow',
				arguments: {
					id: FLOW_ID,
					name: 'Checkout Flow',
					entryStepId: step1,
					steps: {
						[step1]: {
							target: { viewId: VIEW_ID },
							transitions: [
								{ trigger: { widgetId: 'submit-btn', event: 'click' }, targetStepId: step2 },
							],
						},
						[step2]: {
							target: { viewId: VIEW_ID },
							transitions: [],
						},
					},
				},
			})
			expect(created.isError).not.toBe(true)
			const createResult = created.structuredContent as { status: string; key: string; revision: string; resourceUri: string }
			expect(createResult).toMatchObject({
				status: 'created',
				key: FLOW_ID,
				resourceUri: `uiux://flow/${FLOW_ID}`,
			})

			const read = await app.readPointResource('flow', FLOW_ID)
			expect(read?.kind).toBe('flow')
			if (read?.kind !== 'flow') return
			expect(read.resource.name).toBe('Checkout Flow')

			// Update flow with revision CAS via HTTP
			const httpUpdated = await updateFlowForHttp(scoped(app), FLOW_ID, {
				expectedRevision: createResult.revision,
				name: 'Updated Checkout Flow',
				entryStepId: step1,
				steps: read.resource.steps,
			})
			expect(httpUpdated.status).toBe(200)
			expect(httpUpdated.body).toMatchObject({ status: 'updated', key: FLOW_ID })

			const readAfterUpdate = await app.readPointResource('flow', FLOW_ID)
			expect(readAfterUpdate?.kind === 'flow' ? readAfterUpdate.resource.name : undefined).toBe('Updated Checkout Flow')
		}
		finally { await close() }
	})

	it('rejects top-level transitions array and dangling entryStepId', async () => {
		const { app } = await emptySession()
		const invalid = await app.createFlow({
			id: FLOW_ID,
			name: 'Invalid Flow',
			entryStepId: 'dangling-step',
			steps: {},
		})
		expect(invalid.status).toBe('invalid')

		const { client, close } = await connectedClient(app)
		try {
			const rejected = await client.callTool({
				name: 'create_flow',
				arguments: {
					id: FLOW_ID,
					name: 'Bad Graph Flow',
					entryStepId: '11111111-1111-4111-8111-111111111111',
					transitions: [],
					steps: {},
				},
			})
			expect(rejected.isError).toBe(true)
		}
		finally { await close() }
	})

	it('rejects stale revision CAS on update without mutating persistence', async () => {
		const { app } = await emptySession()
		const step = '11111111-2222-4333-8444-555555555555'
		const created = await app.createFlow({
			id: FLOW_ID,
			name: 'Flow',
			entryStepId: step,
			steps: { [step]: { target: { viewId: VIEW_ID }, transitions: [] } },
		})
		if (created.status !== 'created') return

		const updated = await app.updateFlow({
			flowId: FLOW_ID,
			expectedRevision: created.revision,
			name: 'New Name',
			entryStepId: step,
			steps: { [step]: { target: { viewId: VIEW_ID }, transitions: [] } },
		})
		expect(updated.status).toBe('updated')

		const stale = await app.updateFlow({
			flowId: FLOW_ID,
			expectedRevision: created.revision,
			name: 'Stale Name',
			entryStepId: step,
			steps: { [step]: { target: { viewId: VIEW_ID }, transitions: [] } },
		})
		expect(stale.status).toBe('conflict')

		const read = await app.readPointResource('flow', FLOW_ID)
		expect(read?.kind === 'flow' ? read.resource.name : undefined).toBe('New Name')
	})
})

describe('Review thread domain authoring', () => {
	it('creates an open review thread, appends messages, re-anchors, submits ready, and resolves with human actor', async () => {
		const { app, persistence } = await emptySession()
		const createdView = await app.createView({ id: VIEW_ID, name: 'Reviewed View', spec: spec('Review target') })
		expect(createdView.status).toBe('created')
		if (createdView.status !== 'created') return
		const { client, close } = await connectedClient(app)
		try {
			// 1. Create thread
			const created = await client.callTool({
				name: 'create_review_thread',
				arguments: {
					id: REVIEW_ID,
					anchor: { viewId: VIEW_ID, widgetId: 'root' },
					variantNames: ['compact'],
				},
			})
			expect(created.isError).not.toBe(true)
			const createResult = created.structuredContent as { status: string; key: string; revision: string; resourceUri: string }
			expect(createResult).toMatchObject({
				status: 'created',
				key: REVIEW_ID,
				resourceUri: `uiux://review/${REVIEW_ID}`,
			})

			const read1 = await app.readPointResource('review', REVIEW_ID)
			expect(read1?.kind).toBe('review')
			if (read1?.kind !== 'review') return
			expect(read1.resource.status).toBe('open')
			expect(read1.resource.messages).toEqual([])
			expect(read1.resource.history).toEqual([])
			expect(read1.resource.submissions).toEqual([])

			// 2. Append message
			const msgResult = await client.callTool({
				name: 'append_review_message',
				arguments: {
					reviewId: REVIEW_ID,
					expectedRevision: createResult.revision,
					actor: { type: 'human', displayName: 'Designer' },
					body: 'Please adjust padding on the header.',
				},
			})
			expect(msgResult.isError).not.toBe(true)
			const msgRev = (msgResult.structuredContent as { revision: string }).revision
			expect(msgRev).not.toBe(createResult.revision)

			const read2 = await app.readPointResource('review', REVIEW_ID)
			expect(read2?.kind === 'review' ? read2.resource.messages : undefined).toHaveLength(1)
			expect(read2?.kind === 'review' ? read2.resource.messages[0]?.body : undefined).toBe('Please adjust padding on the header.')

			// 3. Re-anchor thread
			const reanchorResult = await client.callTool({
				name: 'reanchor_review_thread',
				arguments: {
					reviewId: REVIEW_ID,
					expectedRevision: msgRev,
					anchor: { viewId: VIEW_ID, widgetId: 'header-widget' },
					variantNames: ['compact'],
					actor: { type: 'human', displayName: 'Designer' },
					reason: 'Narrow scope to header',
				},
			})
			expect(reanchorResult.isError).not.toBe(true)
			const reanchorRev = (reanchorResult.structuredContent as { revision: string }).revision

			const read3 = await app.readPointResource('review', REVIEW_ID)
			expect(read3?.kind === 'review' ? read3.resource.anchor : undefined).toEqual({ viewId: VIEW_ID, widgetId: 'header-widget' })
			expect(read3?.kind === 'review' ? read3.resource.history : undefined).toHaveLength(1)
			expect(read3?.kind === 'review' ? read3.resource.history[0]?.kind : undefined).toBe('reanchor')

			// 4. A syntactically valid but nonexistent digest cannot satisfy the evidence gate.
			const missingEvidence = await client.callTool({
				name: 'submit_ready_for_review',
				arguments: {
					reviewId: REVIEW_ID,
					expectedRevision: reanchorRev,
					actor: { type: 'agent', displayName: 'CoderAgent' },
					changeDomains: ['view-structure'],
					resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: createdView.revision }],
					evidenceRefs: [{ kind: 'screenshot', evidence: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }],
					reason: 'Applied padding fix',
				},
			})
			expect(missingEvidence.isError).toBe(true)
			expect(missingEvidence.structuredContent).toMatchObject({
				status: 'invalid',
				diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'review.evidence_not_found' })]),
			})
			const stillOpen = await app.readPointResource('review', REVIEW_ID)
			expect(stillOpen?.kind === 'review' ? stillOpen.resource.status : undefined).toBe('open')

			const evidenceArtifact = await persistence.artifacts.put(new TextEncoder().encode('review-evidence'))
			const submitResult = await client.callTool({
				name: 'submit_ready_for_review',
				arguments: {
					reviewId: REVIEW_ID,
					expectedRevision: reanchorRev,
					actor: { type: 'agent', displayName: 'CoderAgent' },
					changeDomains: ['view-structure'],
					resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: createdView.revision }],
					evidenceRefs: [{ kind: 'screenshot', evidence: evidenceArtifact.identity }],
					reason: 'Applied padding fix',
				},
			})
			expect(submitResult.isError).not.toBe(true)
			const submitRev = (submitResult.structuredContent as { revision: string }).revision

			const read4 = await app.readPointResource('review', REVIEW_ID)
			expect(read4?.kind === 'review' ? read4.resource.status : undefined).toBe('ready-for-review')
			expect(read4?.kind === 'review' ? read4.resource.submissions : undefined).toHaveLength(1)

			// 5. Negative: resolve by non-human actor must fail (and /mcp never resolves)
			const agentResolve = await client.callTool({
				name: 'resolve_review_thread',
				arguments: {
					reviewId: REVIEW_ID,
					expectedRevision: submitRev,
					actor: { type: 'agent', displayName: 'CoderAgent' },
				},
			})
			expect(agentResolve.isError).toBe(true)
			expect(agentResolve.structuredContent).toMatchObject({
				status: 'blocked',
				key: REVIEW_ID,
				code: 'review.resolve_requires_human',
				diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'review.resolve_requires_human' })]),
			})

			// 6. A human member on /mcp is refused too: resolution is Workbench-only.
			const human = await connectedClient(app, HUMAN_OWNER)
			const mcpHumanResolve = await human.client.callTool({
				name: 'resolve_review_thread',
				arguments: {
					reviewId: REVIEW_ID,
					expectedRevision: submitRev,
					actor: { type: 'human', displayName: 'Lead Designer' },
					reason: 'Looks great!',
				},
			})
			expect(mcpHumanResolve.isError).toBe(true)
			expect(mcpHumanResolve.structuredContent).toMatchObject({ status: 'blocked', code: 'review.resolve_requires_workbench' })
			await human.close()
			expect((await app.readPointResource('review', REVIEW_ID))?.revision).toBe(submitRev)

			// The Workbench surface (/api) resolves; an omitted resolution from ready-for-review is `verified`.
			const resolveResult = await resolveReviewThreadForHttp(scoped(app), REVIEW_ID, {
				expectedRevision: submitRev,
				actor: { type: 'human', displayName: 'Lead Designer' },
				reason: 'Looks great!',
			})
			expect(resolveResult.status).toBe(200)
			const resolveRev = (resolveResult.body as { revision: string }).revision

			const read5 = await app.readPointResource('review', REVIEW_ID)
			expect(read5?.kind === 'review' ? read5.resource.status : undefined).toBe('resolved')

			// 7. Reopen thread back to open
			const reopenResult = await client.callTool({
				name: 'reopen_review_thread',
				arguments: {
					reviewId: REVIEW_ID,
					expectedRevision: resolveRev,
					actor: { type: 'human', displayName: 'Tester' },
					reason: 'Found regression',
				},
			})
			expect(reopenResult.isError).not.toBe(true)

			const read6 = await app.readPointResource('review', REVIEW_ID)
			expect(read6?.kind === 'review' ? read6.resource.status : undefined).toBe('open')
		}
		finally { await close() }
	})

	it('promotes review to decision atomically, updating target View with Decision provenance and returning Review and View URIs, and handles idempotency', async () => {
		const { app } = await emptySession()
		const createdReview = await app.createReviewThread({
			id: REVIEW_ID,
			anchor: { viewId: VIEW_ID, widgetId: 'root' },
		})
		expect(createdReview.status).toBe('created')

		const createdView = await app.createView({
			id: VIEW_ID,
			name: 'Test View',
			spec: spec('Intent'),
		})
		expect(createdView.status).toBe('created')
		if (createdReview.status !== 'created' || createdView.status !== 'created') return

		const { client, close } = await connectedClient(app)
		try {
			// Fresh promotion via MCP tool
			const freshResult = await client.callTool({
				name: 'promote_review_to_decision',
				arguments: {
					reviewId: REVIEW_ID,
					expectedReviewRevision: createdReview.revision,
					viewId: VIEW_ID,
					expectedViewRevision: createdView.revision,
					question: 'Keep header padding?',
					outcome: { summary: 'Yes', rationale: 'Verified' },
				},
			})
			expect(freshResult.isError).not.toBe(true)
			const content = freshResult.structuredContent as Record<string, unknown>
			expect(content.status).toBe('updated')
			expect(content.key).toBe(REVIEW_ID)
			expect(content.resourceUri).toBe(`uiux://review/${REVIEW_ID}`)
			expect(content.resourceUri).not.toBe(`uiux://review/${VIEW_ID}`)
			const targetView = content.targetView as Record<string, unknown>
			expect(targetView).toBeDefined()
			expect(targetView.key).toBe(VIEW_ID)
			expect(targetView.resourceUri).toBe(`uiux://view/${VIEW_ID}`)

			// Verify Decision was appended to View spec
			const viewAfterFresh = await app.readPointResource('view', VIEW_ID)
			expect(viewAfterFresh?.kind === 'view' ? viewAfterFresh.resource.spec.decisions?.length : 0).toBe(1)
			const decision = viewAfterFresh?.kind === 'view' ? viewAfterFresh.resource.spec.decisions?.[0] : undefined
			expect(decision?.question).toBe('Keep header padding?')
			expect(decision?.status).toBe('decided')
			expect(decision?.provenance).toMatchObject({
				reviewId: REVIEW_ID,
			})

			// Verify Review thread remains valid and unchanged
			const reviewAfterFresh = await app.readPointResource('review', REVIEW_ID)
			expect(reviewAfterFresh?.kind === 'review' ? reviewAfterFresh.resource.status : undefined).toBe('open')

			// Idempotent retry uses the original pre-commit revisions, as a network retry would.
			const idempotentResult = await client.callTool({
				name: 'promote_review_to_decision',
				arguments: {
					reviewId: REVIEW_ID,
					expectedReviewRevision: createdReview.revision,
					viewId: VIEW_ID,
					expectedViewRevision: createdView.revision,
					question: 'Keep header padding?',
				},
			})
			expect(idempotentResult.isError).not.toBe(true)
			const idempContent = idempotentResult.structuredContent as Record<string, unknown>
			expect(idempContent.status).toBe('updated')
			expect(idempContent.resourceUri).toBe(`uiux://review/${REVIEW_ID}`)
			expect((idempContent.targetView as Record<string, unknown>).resourceUri).toBe(`uiux://view/${VIEW_ID}`)

			// Verify still exactly 1 decision
			const viewAfterIdempotent = await app.readPointResource('view', VIEW_ID)
			expect(viewAfterIdempotent?.kind === 'view' ? viewAfterIdempotent.resource.spec.decisions?.length : 0).toBe(1)

			// A different, not-yet-promoted Review still enforces stale revision CAS.
			const secondReview = await app.createReviewThread({
				id: SECOND_REVIEW_ID,
				anchor: { viewId: VIEW_ID, widgetId: 'root' },
			})
			expect(secondReview.status).toBe('created')
			const conflictResult = await client.callTool({
				name: 'promote_review_to_decision',
				arguments: {
					reviewId: SECOND_REVIEW_ID,
					expectedReviewRevision: 'stale-review-rev',
					viewId: VIEW_ID,
					expectedViewRevision: targetView.revision as string,
					question: 'Separate stale request',
				},
			})
			expect(conflictResult.isError).toBe(true)
			const conflictContent = conflictResult.structuredContent as Record<string, unknown>
			expect(conflictContent.status).toBe('conflict')
		}
		finally { await close() }
	})

	it('rejects Decision promotion into a View different from the Review anchor', async () => {
		const { app } = await emptySession()
		const review = await app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		const anchoredView = await app.createView({ id: VIEW_ID, name: 'Anchored View', spec: spec('A') })
		const otherView = await app.createView({ id: OTHER_VIEW_ID, name: 'Other View', spec: spec('B') })
		expect(review.status).toBe('created')
		expect(anchoredView.status).toBe('created')
		expect(otherView.status).toBe('created')
		if (review.status !== 'created' || otherView.status !== 'created') return

		const result = await app.promoteReviewToDecision({
			reviewId: REVIEW_ID,
			expectedReviewRevision: review.revision,
			viewId: OTHER_VIEW_ID,
			expectedViewRevision: otherView.revision,
			question: 'This must not leak across Views',
		})
		expect(result).toMatchObject({
			status: 'invalid',
			key: REVIEW_ID,
			diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'review.decision_target_mismatch' })]),
		})
		const unchanged = await app.readPointResource('view', OTHER_VIEW_ID)
		expect(unchanged?.kind === 'view' ? unchanged.resource.spec.decisions : undefined).toEqual([])
	})
})

/**
 * Review render context write path over both transports (Clause 01a1170f-bba0-7982-bc92-7eef91459828,
 * persisted shape 01a1170f-baf0-7eea-a904-7367227c10b3; owner rulings, Discussion #7, 2026-10-09):
 * only Workspace-authored keys, an object sets, null clears, omitted keeps, the Workspace arm clears.
 */
describe('Review renderContext over MCP and HTTP', () => {
	const WIDGET = { viewId: VIEW_ID, widgetId: 'submit' }
	const ROOT = { viewId: VIEW_ID, widgetId: 'root' }
	const ZH_MOBILE_DARK = { locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' }

	/** A Workspace with one authored viewport and theme, a default Locale and one i18n file. */
	async function renderContextSession() {
		const root = await mkdtemp(join(tmpdir(), 'uiux-render-context-'))
		roots.push(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await persistence.workspace.create({
			schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
			i18n: { defaultLocale: 'en-US' },
			adapters: [],
			viewports: { mobile: { label: 'Mobile', dimensions: { width: 390, height: 844 } } },
			themes: { dark: { label: 'Dark' } },
		})
		const app = createWorkspaceApplicationSession(persistence)
		expect((await app.createLocale({ locale: 'zh-TW', messages: { title: '結帳' } })).status).toBe('created')
		expect((await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })).status).toBe('created')
		return { root, persistence, app }
	}

	async function stored(app: ReturnType<typeof createWorkspaceApplicationSession>, key = REVIEW_ID) {
		const read = await app.readPointResource('review', key)
		if (read?.kind !== 'review') throw new Error(`Review ${key} is missing.`)
		expect(read.diagnostics).toEqual([])
		return read
	}

	function diagnosticsOf(value: unknown): Array<[string, string]> {
		return ((value as { diagnostics?: { code: string; path: string }[] }).diagnostics ?? []).map(item => [item.code, item.path])
	}

	async function reviewFiles(root: string): Promise<string[]> {
		return (await readdir(join(root, 'reviews')).catch(() => [])).sort()
	}

	it('creates with renderContext, then sets, keeps and clears it on re-anchor over MCP, and list and search summaries carry it', async () => {
		const { app } = await renderContextSession()
		const { client, close } = await connectedClient(app)
		try {
			const tools = await client.listTools()
			expect(tools.tools.find(tool => tool.name === 'create_review_thread')!.description).toContain('renderContext')
			expect(tools.tools.find(tool => tool.name === 'reanchor_review_thread')!.description).toContain('null clears it')

			const created = await client.callTool({ name: 'create_review_thread', arguments: { id: REVIEW_ID, anchor: WIDGET, renderContext: ZH_MOBILE_DARK } })
			expect(created.isError).not.toBe(true)
			expect((await stored(app)).resource.renderContext).toEqual(ZH_MOBILE_DARK)

			const listed = await client.callTool({ name: 'list_resources', arguments: { kinds: ['review'], limit: 10 } })
			expect((listed.structuredContent as { items: { key: string; summary: Record<string, unknown> }[] }).items[0]!.summary)
				.toMatchObject({ anchor: WIDGET, renderContext: ZH_MOBILE_DARK })
			const searched = await client.callTool({ name: 'search_resources', arguments: { kinds: ['review'], query: 'submit', limit: 10 } })
			expect((searched.structuredContent as { items: { summary: Record<string, unknown> }[] }).items[0]!.summary.renderContext).toEqual(ZH_MOBILE_DARK)

			const reanchor = async (args: Record<string, unknown>) => {
				const result = await client.callTool({ name: 'reanchor_review_thread', arguments: { reviewId: REVIEW_ID, expectedRevision: (await stored(app)).revision, ...args } })
				expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true)
				return (await stored(app)).resource
			}
			let thread = await reanchor({ anchor: WIDGET, renderContext: { locale: 'en-US', themeId: 'dark' } })
			expect(thread.renderContext).toEqual({ locale: 'en-US', themeId: 'dark' })
			expect(thread.history.at(-1)).toMatchObject({ kind: 'reanchor', before: { renderContext: ZH_MOBILE_DARK }, after: { renderContext: { locale: 'en-US', themeId: 'dark' } } })

			thread = await reanchor({ anchor: ROOT })
			expect(thread.renderContext).toEqual({ locale: 'en-US', themeId: 'dark' })
			expect(thread.history.at(-1)).toMatchObject({ before: { anchor: WIDGET, renderContext: { locale: 'en-US', themeId: 'dark' } }, after: { anchor: ROOT, renderContext: { locale: 'en-US', themeId: 'dark' } } })

			thread = await reanchor({ anchor: ROOT, renderContext: null })
			expect(thread).not.toHaveProperty('renderContext')
			expect(thread.history.at(-1)!.before).toMatchObject({ renderContext: { locale: 'en-US', themeId: 'dark' } })
			expect(thread.history.at(-1)!.after).toEqual({ anchor: ROOT, variantNames: [] })
			const relisted = await client.callTool({ name: 'list_resources', arguments: { kinds: ['review'], limit: 10 } })
			expect((relisted.structuredContent as { items: { summary: Record<string, unknown> }[] }).items[0]!.summary).not.toHaveProperty('renderContext')
		}
		finally { await close() }
	})

	it('creates with renderContext, then sets, keeps and clears it on re-anchor over HTTP, and the list summary carries it', async () => {
		const { app } = await renderContextSession()
		const created = await createReviewThreadForHttp(scoped(app), { id: REVIEW_ID, anchor: ROOT, renderContext: { viewportId: 'mobile' } })
		expect(created.status).toBe(201)
		expect((await stored(app)).resource.renderContext).toEqual({ viewportId: 'mobile' })
		const listed = await listResourcesForHttp(app, { kinds: ['review'], limit: 10 })
		expect((listed.body as { items: { summary: Record<string, unknown> }[] }).items[0]!.summary.renderContext).toEqual({ viewportId: 'mobile' })

		const reanchor = async (body: Record<string, unknown>) => {
			const result = await reanchorReviewThreadForHttp(scoped(app), REVIEW_ID, { expectedRevision: (await stored(app)).revision, ...body })
			expect(result.status, JSON.stringify(result.body)).toBe(200)
			return (await stored(app)).resource
		}
		let thread = await reanchor({ anchor: WIDGET, renderContext: ZH_MOBILE_DARK })
		expect(thread.renderContext).toEqual(ZH_MOBILE_DARK)
		expect(thread.history.at(-1)).toMatchObject({ before: { anchor: ROOT, renderContext: { viewportId: 'mobile' } }, after: { anchor: WIDGET, renderContext: ZH_MOBILE_DARK } })
		thread = await reanchor({ anchor: WIDGET, variantNames: ['compact'] })
		expect(thread.renderContext).toEqual(ZH_MOBILE_DARK)
		thread = await reanchor({ anchor: WIDGET, renderContext: null })
		expect(thread).not.toHaveProperty('renderContext')
		expect(thread.history.at(-1)!.after).toEqual({ anchor: WIDGET, variantNames: [] })
	})

	it('refuses unknown keys, unauthored built-in fallbacks included, on both transports and writes nothing', async () => {
		const { root, app } = await renderContextSession()
		const unknown = { locale: 'fr-FR', viewportId: 'tablet', themeId: 'sepia' }
		const fallbacks = { viewportId: 'default', themeId: 'light' }
		const everyKey = [
			['review.render_context_unknown_key', '/renderContext/locale'],
			['review.render_context_unknown_key', '/renderContext/viewportId'],
			['review.render_context_unknown_key', '/renderContext/themeId'],
		]
		const fallbackKeys = everyKey.slice(1)

		for (const [renderContext, expected] of [[unknown, everyKey], [fallbacks, fallbackKeys]] as const) {
			const http = await createReviewThreadForHttp(scoped(app), { id: REVIEW_ID, anchor: WIDGET, renderContext })
			expect(http.status).toBe(400)
			expect(http.body).toMatchObject({ status: 'invalid' })
			expect(diagnosticsOf(http.body)).toEqual(expected)
		}
		const { client, close } = await connectedClient(app)
		try {
			for (const [renderContext, expected] of [[unknown, everyKey], [fallbacks, fallbackKeys]] as const) {
				const mcp = await client.callTool({ name: 'create_review_thread', arguments: { id: REVIEW_ID, anchor: WIDGET, renderContext } })
				expect(mcp.isError).toBe(true)
				expect(diagnosticsOf(mcp.structuredContent)).toEqual(expected)
			}
			expect(await reviewFiles(root)).toEqual([])

			// Re-anchor with an unknown key leaves the thread byte-identical on both transports.
			const created = await app.createReviewThread({ id: REVIEW_ID, anchor: WIDGET, renderContext: ZH_MOBILE_DARK })
			if (created.status !== 'created') throw new Error('Thread fixture failed.')
			const bytes = await readFile(join(root, reviewRelativePath(REVIEW_ID)), 'utf8')
			const viaHttp = await reanchorReviewThreadForHttp(scoped(app), REVIEW_ID, { expectedRevision: created.revision, anchor: ROOT, renderContext: { locale: 'ja-JP' } })
			expect(viaHttp.status).toBe(400)
			expect(diagnosticsOf(viaHttp.body)).toEqual([['review.render_context_unknown_key', '/renderContext/locale']])
			const viaMcp = await client.callTool({ name: 'reanchor_review_thread', arguments: { reviewId: REVIEW_ID, expectedRevision: created.revision, anchor: ROOT, renderContext: { themeId: 'light' } } })
			expect(viaMcp.isError).toBe(true)
			expect(diagnosticsOf(viaMcp.structuredContent)).toEqual([['review.render_context_unknown_key', '/renderContext/themeId']])
			expect(await readFile(join(root, reviewRelativePath(REVIEW_ID)), 'utf8')).toBe(bytes)
		}
		finally { await close() }
		// The transport stays strict about members; key existence is the service's diagnostic.
		expect((await createReviewThreadForHttp(scoped(app), { anchor: WIDGET, renderContext: { variant: 'empty' } })).body).toMatchObject({ code: 'malformed_payload' })
	})

	it('refuses renderContext on a Workspace anchor and clears it on a re-anchor to the Workspace, on both transports', async () => {
		const { root, app } = await renderContextSession()
		const http = await createReviewThreadForHttp(scoped(app), { anchor: { scope: 'workspace' }, renderContext: { locale: 'en-US' } })
		expect(http.status).toBe(400)
		expect(diagnosticsOf(http.body)).toEqual([['review.render_context_without_widget', '/renderContext']])
		const { client, close } = await connectedClient(app)
		try {
			const mcp = await client.callTool({ name: 'create_review_thread', arguments: { anchor: { scope: 'workspace' }, renderContext: { themeId: 'dark' } } })
			expect(mcp.isError).toBe(true)
			expect(diagnosticsOf(mcp.structuredContent)).toEqual([['review.render_context_without_widget', '/renderContext']])
			expect(await reviewFiles(root)).toEqual([])

			const created = await app.createReviewThread({ id: REVIEW_ID, anchor: WIDGET, renderContext: ZH_MOBILE_DARK })
			const second = await app.createReviewThread({ id: SECOND_REVIEW_ID, anchor: WIDGET, renderContext: ZH_MOBILE_DARK })
			if (created.status !== 'created' || second.status !== 'created') throw new Error('Thread fixtures failed.')
			const refused = await reanchorReviewThreadForHttp(scoped(app), REVIEW_ID, { expectedRevision: created.revision, anchor: { scope: 'workspace' }, renderContext: ZH_MOBILE_DARK })
			expect(diagnosticsOf(refused.body)).toEqual([['review.render_context_without_widget', '/renderContext']])

			const viaHttp = await reanchorReviewThreadForHttp(scoped(app), REVIEW_ID, { expectedRevision: created.revision, anchor: { scope: 'workspace' } })
			expect(viaHttp.status).toBe(200)
			const viaMcp = await client.callTool({ name: 'reanchor_review_thread', arguments: { reviewId: SECOND_REVIEW_ID, expectedRevision: second.revision, anchor: { scope: 'workspace' } } })
			expect(viaMcp.isError).not.toBe(true)
			for (const key of [REVIEW_ID, SECOND_REVIEW_ID]) {
				const thread = (await stored(app, key)).resource
				expect(thread).not.toHaveProperty('renderContext')
				expect(thread.history.at(-1)!.before).toMatchObject({ anchor: WIDGET, renderContext: ZH_MOBILE_DARK })
				expect(thread.history.at(-1)!.after).toEqual({ anchor: { scope: 'workspace' }, variantNames: [] })
			}
		}
		finally { await close() }
	})
})

describe('Authored Assets authoring and content transport', () => {
	it('creates authored asset via base64, persists native binary bytes, and reads safe descriptor without raw bytes', async () => {
		const { app, persistence } = await emptySession()
		const testBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG header bytes
		const base64 = Buffer.from(testBytes).toString('base64')

		const { client, close } = await connectedClient(app)
		try {
			const created = await client.callTool({
				name: 'create_asset',
				arguments: {
					id: ASSET_ID,
					name: 'App Logo',
					contentFilename: 'logo.png',
					mediaType: 'image/png',
					contentBase64: base64,
				},
			})
			expect(created.isError).not.toBe(true)
			const createResult = created.structuredContent as { status: string; key: string; revision: string; resourceUri: string }
			expect(createResult).toMatchObject({
				status: 'created',
				key: ASSET_ID,
				resourceUri: `uiux://asset/${ASSET_ID}`,
			})

			// Verify native binary bytes persisted on disk (not base64)
			const onDisk = await persistence.assets.readInspected(ASSET_ID)
			expect(onDisk?.resource.content).toEqual(testBytes)

			// Point read exposes safe descriptor without raw byte arrays
			const pointRead = await app.readPointResource('asset', ASSET_ID)
			expect(pointRead).toMatchObject({
				kind: 'asset',
				key: ASSET_ID,
				content: {
					mediaType: 'image/png',
					size: testBytes.byteLength,
					contentUrl: `/api/assets/${ASSET_ID}/content`,
				},
			})
			expect(pointRead?.kind === 'asset' ? pointRead.content.digest : undefined).toMatch(/^sha256:[0-9a-f]{64}$/u)

			// HTTP content serving endpoint serves exact raw binary bytes with safe headers
			const contentHttp = await readAssetContentForHttp(persistence, ASSET_ID)
			expect(contentHttp.status).toBe(200)
			expect(contentHttp.body).toEqual(testBytes)
			expect(contentHttp.headers).toMatchObject({
				'Content-Type': 'image/png',
				'Content-Length': '8',
				'Content-Disposition': 'inline; filename="logo.png"; filename*=UTF-8\'\'logo.png',
				'X-Content-Type-Options': 'nosniff',
			})

			// Replace asset with revision CAS
			const newBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
			const newBase64 = Buffer.from(newBytes).toString('base64')
			const replaced = await client.callTool({
				name: 'replace_asset',
				arguments: {
					assetId: ASSET_ID,
					expectedRevision: createResult.revision,
					name: 'App Logo v2',
					contentFilename: 'logo_v2.png',
					mediaType: 'image/png',
					contentBase64: newBase64,
				},
			})
			expect(replaced.isError).not.toBe(true)
			const replaceResult = replaced.structuredContent as { status: string; revision: string }
			expect(replaceResult.status).toBe('updated')
			expect(replaceResult.revision).not.toBe(createResult.revision)

			const readAfterReplace = await app.readPointResource('asset', ASSET_ID)
			expect(readAfterReplace?.kind === 'asset' ? readAfterReplace.content.size : undefined).toBe(9)
		}
		finally { await close() }
	})

	it('fails creation if asset already exists and rejects path traversal', async () => {
		const { app, persistence } = await emptySession()
		const testBytes = new Uint8Array([1, 2, 3])
		const base64 = Buffer.from(testBytes).toString('base64')

		const first = await app.createAsset({
			id: ASSET_ID,
			name: 'Initial',
			contentFilename: 'file.bin',
			mediaType: 'application/octet-stream',
			contentBase64: base64,
		})
		expect(first.status).toBe('created')

		const duplicate = await app.createAsset({
			id: ASSET_ID,
			name: 'Duplicate',
			contentFilename: 'file.bin',
			mediaType: 'application/octet-stream',
			contentBase64: base64,
		})
		expect(duplicate.status).toBe('already_exists')

		// Path traversal rejection on content read
		const traversal = await readAssetContentForHttp(persistence, '../etc/passwd')
		expect(traversal.status).toBe(400)
		expect(traversal.body).toMatchObject({ code: 'invalid_resource_address' })
	})
})

describe('HTTP authoring strict transport boundary and malformed payload rejection', () => {
	it('rejects malformed non-object bodies returning structured HTTP 400', async () => {
		const { app } = await emptySession()
		for (const invalidBody of [null, 'a string', 12345, true, [1, 2, 3]]) {
			const viewRes = await createViewForHttp(scoped(app), invalidBody)
			expect(viewRes.status).toBe(400)
			expect(viewRes.body).toMatchObject({ code: 'malformed_payload' })

			const localeRes = await createLocaleForHttp(scoped(app), invalidBody)
			expect(localeRes.status).toBe(400)
			expect(localeRes.body).toMatchObject({ code: 'malformed_payload' })

			const flowRes = await createFlowForHttp(scoped(app), invalidBody)
			expect(flowRes.status).toBe(400)
			expect(flowRes.body).toMatchObject({ code: 'malformed_payload' })

			const reviewRes = await createReviewThreadForHttp(scoped(app), invalidBody)
			expect(reviewRes.status).toBe(400)
			expect(reviewRes.body).toMatchObject({ code: 'malformed_payload' })

			const assetRes = await createAssetForHttp(scoped(app), invalidBody)
			expect(assetRes.status).toBe(400)
			expect(assetRes.body).toMatchObject({ code: 'malformed_payload' })
		}
	})

	it('rejects missing required fields with structured HTTP 400 without throwing TypeError', async () => {
		const { app } = await emptySession()

		const emptyView = await createViewForHttp(scoped(app), {})
		expect(emptyView.status).toBe(400)
		expect(emptyView.body.code).toBe('malformed_payload')
		expect(emptyView.body.diagnostics.length).toBeGreaterThan(0)

		const missingSpec = await createViewForHttp(scoped(app), { name: 'Only Name' })
		expect(missingSpec.status).toBe(400)
		expect(missingSpec.body.code).toBe('malformed_payload')

		const emptyLocale = await createLocaleForHttp(scoped(app), {})
		expect(emptyLocale.status).toBe(400)
		expect(emptyLocale.body.code).toBe('malformed_payload')

		const emptyFlow = await createFlowForHttp(scoped(app), {})
		expect(emptyFlow.status).toBe(400)
		expect(emptyFlow.body.code).toBe('malformed_payload')

		const emptyReview = await createReviewThreadForHttp(scoped(app), {})
		expect(emptyReview.status).toBe(400)
		expect(emptyReview.body.code).toBe('malformed_payload')

		const emptyAsset = await createAssetForHttp(scoped(app), {})
		expect(emptyAsset.status).toBe(400)
		expect(emptyAsset.body.code).toBe('malformed_payload')

		const emptyMessage = await appendReviewMessageForHttp(scoped(app), REVIEW_ID, {})
		expect(emptyMessage.status).toBe(400)
		expect(emptyMessage.body.code).toBe('malformed_payload')

		const emptyResolve = await resolveReviewThreadForHttp(scoped(app), REVIEW_ID, {})
		expect(emptyResolve.status).toBe(400)
		expect(emptyResolve.body.code).toBe('malformed_payload')
	})

	it('rejects string or object passed instead of array without type coercion or TypeError', async () => {
		const { app } = await emptySession()

		// string instead of array on reanchor variantNames
		const stringVariants = await reanchorReviewThreadForHttp(scoped(app), REVIEW_ID, {
			expectedRevision: 'rev-1',
			anchor: { viewId: VIEW_ID, widgetId: 'w1' },
			actor: { type: 'human' },
			variantNames: 'not-an-array',
		})
		expect(stringVariants.status).toBe(400)
		expect(stringVariants.body.code).toBe('malformed_payload')

		// string instead of array on submit ready changeDomains
		const stringDomains = await submitReadyForReviewForHttp(scoped(app), REVIEW_ID, {
			expectedRevision: 'rev-1',
			actor: { type: 'human' },
			changeDomains: 'all',
			resources: [],
			evidenceRefs: [],
		})
		expect(stringDomains.status).toBe(400)
		expect(stringDomains.body.code).toBe('malformed_payload')

		// object instead of array on submit ready changeDomains
		const objectDomains = await submitReadyForReviewForHttp(scoped(app), REVIEW_ID, {
			expectedRevision: 'rev-1',
			actor: { type: 'human' },
			changeDomains: { domain: 'views' },
			resources: [],
			evidenceRefs: [],
		})
		expect(objectDomains.status).toBe(400)
		expect(objectDomains.body.code).toBe('malformed_payload')

		// object instead of array on createReviewThread variantNames
		const objectVariants = await createReviewThreadForHttp(scoped(app), {
			anchor: { viewId: VIEW_ID, widgetId: 'w1' },
			variantNames: { name: 'mobile' },
		})
		expect(objectVariants.status).toBe(400)
		expect(objectVariants.body.code).toBe('malformed_payload')
	})

	it('rejects malformed nested objects with structured HTTP 400', async () => {
		const { app } = await emptySession()

		// anchor as string instead of object
		const badAnchor = await createReviewThreadForHttp(scoped(app), {
			anchor: 'not-an-object',
		})
		expect(badAnchor.status).toBe(400)
		expect(badAnchor.body.code).toBe('malformed_payload')

		// spec as string instead of object
		const badSpec = await updateViewSpecForHttp(scoped(app), VIEW_ID, {
			expectedRevision: 'rev-1',
			spec: 'intent only',
		})
		expect(badSpec.status).toBe(400)
		expect(badSpec.body.code).toBe('malformed_payload')

		// ir as string instead of object
		const badIr = await updateViewStructureForHttp(scoped(app), VIEW_ID, {
			expectedRevision: 'rev-1',
			ir: 'not-an-object',
			variants: {},
		})
		expect(badIr.status).toBe(400)
		expect(badIr.body.code).toBe('malformed_payload')

		// outcome as string instead of object in promotion
		const badOutcome = await promoteReviewToDecisionForHttp(scoped(app), REVIEW_ID, {
			expectedReviewRevision: 'rev-1',
			viewId: VIEW_ID,
			expectedViewRevision: 'rev-1',
			question: 'Keep header?',
			outcome: 'approved',
		})
		expect(badOutcome.status).toBe(400)
		expect(badOutcome.body.code).toBe('malformed_payload')
	})

	it('rejects unknown extra properties on strict HTTP endpoints with HTTP 400', async () => {
		const { app } = await emptySession()

		const unknownViewProp = await createViewForHttp(scoped(app), {
			name: 'Valid Name',
			spec: spec('Intent'),
			unrecognizedExtraField: 1234,
		})
		expect(unknownViewProp.status).toBe(400)
		expect(unknownViewProp.body.code).toBe('malformed_payload')

		const unknownSettingsProp = await updateWorkspaceSettingsForHttp(scoped(app), {
			expectedRevision: 'rev-1',
			settings: { i18n: { defaultLocale: 'en-US' } },
			unrecognizedSetting: true,
		})
		expect(unknownSettingsProp.status).toBe(400)
		expect(unknownSettingsProp.body.code).toBe('malformed_payload')

		const unknownReopenProp = await reopenReviewThreadForHttp(scoped(app), REVIEW_ID, {
			expectedRevision: 'rev-1',
			actor: { type: 'human' },
			extraUnexpected: 'data',
		})
		expect(unknownReopenProp.status).toBe(400)
		expect(unknownReopenProp.body.code).toBe('malformed_payload')
	})
})

describe('Strict RFC 4648 Base64 asset encoding validation', () => {
	it('enforces strict RFC 4648 format, rejecting interior padding, bad length, unused bits, and whitespace', () => {
		// Valid base64 strings
		const valid1 = decodeStrictBase64('aQ==')
		expect(valid1.ok).toBe(true)
		if (valid1.ok) expect(Array.from(valid1.bytes)).toEqual([0x69])

		const valid2 = decodeStrictBase64('AQID')
		expect(valid2.ok).toBe(true)
		if (valid2.ok) expect(Array.from(valid2.bytes)).toEqual([1, 2, 3])

		const valid3 = decodeStrictBase64('AAAA')
		expect(valid3.ok).toBe(true)
		if (valid3.ok) expect(Array.from(valid3.bytes)).toEqual([0, 0, 0])

		// Interior padding
		const interiorPad = decodeStrictBase64('aa=b')
		expect(interiorPad.ok).toBe(false)

		// Bad length (not multiple of 4)
		const badLen1 = decodeStrictBase64('aa')
		expect(badLen1.ok).toBe(false)
		const badLen2 = decodeStrictBase64('aaa')
		expect(badLen2.ok).toBe(false)

		// Noncanonical unused bits (aa== decodes to 0x69, which re-encodes to aQ==)
		const noncanonical = decodeStrictBase64('aa==')
		expect(noncanonical.ok).toBe(false)

		// Whitespace and newlines
		expect(decodeStrictBase64('aQ==\n').ok).toBe(false)
		expect(decodeStrictBase64(' aQ==').ok).toBe(false)
		expect(decodeStrictBase64('aQ== ').ok).toBe(false)
		expect(decodeStrictBase64('aQ\r\n==').ok).toBe(false)
		expect(decodeStrictBase64('a Q==').ok).toBe(false)

		// Empty string
		expect(decodeStrictBase64('').ok).toBe(false)

		// Invalid characters
		expect(decodeStrictBase64('??!!').ok).toBe(false)
	})

	it('rejects malformed Base64 at HTTP boundary with structured HTTP 400', async () => {
		const { app } = await emptySession()

		for (const badBase64 of ['aa=b', 'aa', 'aaa', 'aa==', 'AAAA\n', '', '?!@#']) {
			const res = await createAssetForHttp(scoped(app), {
				name: 'Test Asset',
				contentFilename: 'test.bin',
				mediaType: 'application/octet-stream',
				contentBase64: badBase64,
			})
			expect(res.status).toBe(400)
			expect(res.body.status).toBe('invalid')
			expect(res.body.diagnostics.length).toBeGreaterThan(0)
		}
	})
})

describe('Asset content HTTP serving and header security', () => {
	it('serves exact bytes with RFC 6266 Content-Disposition and nosniff headers', async () => {
		const { app, persistence } = await emptySession()
		const testBytes = new Uint8Array([1, 2, 3, 4])
		const base64 = Buffer.from(testBytes).toString('base64')

		const created = await createAssetForHttp(scoped(app), {
			id: ASSET_ID,
			name: 'Test Icon',
			contentFilename: 'app icon.png',
			mediaType: 'image/png',
			contentBase64: base64,
		})
		expect(created.status).toBe(201)

		const contentRes = await readAssetContentForHttp(persistence, ASSET_ID)
		expect(contentRes.status).toBe(200)
		expect(contentRes.body).toEqual(testBytes)
		expect(contentRes.headers).toMatchObject({
			'Content-Type': 'image/png',
			'Content-Length': '4',
			'Content-Disposition': 'inline; filename="app_icon.png"; filename*=UTF-8\'\'app%20icon.png',
			'X-Content-Type-Options': 'nosniff',
		})
		// Verify no CRLF injection in headers
		for (const [key, value] of Object.entries(contentRes.headers)) {
			expect(key).not.toMatch(/[\r\n]/)
			expect(value).not.toMatch(/[\r\n]/)
		}
	})

	it('returns HTTP 404 when declared content file is missing on disk', async () => {
		const { app, persistence, root } = await emptySession()
		const testBytes = new Uint8Array([1, 2, 3])
		const base64 = Buffer.from(testBytes).toString('base64')

		const created = await createAssetForHttp(scoped(app), {
			id: ASSET_ID,
			name: 'Missing File Asset',
			contentFilename: 'missing.bin',
			mediaType: 'application/octet-stream',
			contentBase64: base64,
		})
		expect(created.status).toBe(201)

		// Delete the content file from disk
		await rm(join(root, 'assets', ASSET_ID, 'missing.bin'), { force: true })

		const contentRes = await readAssetContentForHttp(persistence, ASSET_ID)
		expect(contentRes.status).toBe(404)
		expect(contentRes.body).toMatchObject({ code: 'asset_content_missing' })
	})

	it('returns HTTP 409 when multiple or ambiguous content files exist on disk', async () => {
		const { app, persistence, root } = await emptySession()
		const testBytes = new Uint8Array([1, 2, 3])
		const base64 = Buffer.from(testBytes).toString('base64')

		const created = await createAssetForHttp(scoped(app), {
			id: ASSET_ID,
			name: 'Ambiguous Asset',
			contentFilename: 'primary.bin',
			mediaType: 'application/octet-stream',
			contentBase64: base64,
		})
		expect(created.status).toBe(201)

		// Place an unexpected extra file in the asset directory
		await writeFile(join(root, 'assets', ASSET_ID, 'unexpected.bin'), Buffer.from('extra'))

		const contentRes = await readAssetContentForHttp(persistence, ASSET_ID)
		expect(contentRes.status).toBe(409)
		expect(contentRes.body).toMatchObject({ code: 'asset_content_ambiguous' })
	})
})

function spec(intent: string, entryConditions: readonly string[] = []): ViewSpecContent {
	return {
		intent,
		entryConditions,
		interactionRules: [],
		constraints: [],
		accessibility: [],
		references: [],
	}
}

async function emptySession() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-authoring-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.workspace.create({
		schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		i18n: { defaultLocale: 'en-US' },
		adapters: [],
		viewports: {},
		themes: {},
	})
	return { root, persistence, app: createWorkspaceApplicationSession(persistence) }
}

async function connectedClient(app: ReturnType<typeof createWorkspaceApplicationSession>, principal: MemberPrincipal = AGENT_EDITOR) {
	return connectMcp(app, principal)
}
