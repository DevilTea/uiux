import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ResourceNotFoundError } from '@modelcontextprotocol/server'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { AuthoredAssetResource } from '../src/domain/assets/schema'
import type { FlowResource } from '../src/domain/flows/schema'
import type { ReviewThread } from '../src/domain/reviews/schema'
import type { ViewResource } from '../src/domain/views/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { createUiuxMcpHttpHandler, principalAuthInfo } from '../src/mcp/server'
import { createLeaseManager } from '../src/application/access/leases'
import { AGENT_EDITOR } from './support/access'
import { parsePointResourceUri, pointResourceUri } from '../src/mcp/resource-uri'
import { FileNativePersistence } from '../src/persistence'
import { defineWorkspaceSchemaPolicy } from '../src/persistence/schema-policy'
import { readPointResourceForHttp } from '../src/server/point-resource'
import { listResourcesForHttp, searchResourcesForHttp } from '../src/server/resource-discovery'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const VIEW_ID_2 = '33333333-3333-4333-8333-333333333333'
const REVIEW_ID = '55555555-5555-4555-8555-555555555555'
const ASSET_ID = '66666666-6666-4666-8666-666666666666'
const MISSING_VIEW_ID = '99999999-9999-4999-8999-999999999999'
const MISMATCHED_VIEW_ID = '88888888-8888-4888-8888-888888888888'
const roots: string[] = []
const testSchemaPolicy = defineWorkspaceSchemaPolicy({ currentVersion: 2, recognizedVersions: [2], steps: [] })

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('shared HTTP/MCP point-resource reads', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('keeps resource URIs stable inside the selected Workspace namespace without embedding filesystem identity', () => {
		expect(pointResourceUri({ kind: 'workspace', key: 'workspace' })).toBe('uiux://workspace')
		expect(pointResourceUri({ kind: 'view', key: VIEW_ID })).toBe(`uiux://view/${VIEW_ID}`)
		expect(pointResourceUri({ kind: 'locale', key: 'zh-Hant-TW' })).toBe('uiux://locale/zh-Hant-TW')
		expect(parsePointResourceUri(`uiux://view/${VIEW_ID}`)).toEqual({ kind: 'view', key: VIEW_ID })
		expect(parsePointResourceUri('uiux://view/not-a-uuid')).toBeUndefined()
		expect(parsePointResourceUri('uiux://locale/EN-us')).toBeUndefined()
		expect(parsePointResourceUri('uiux://workspace')).toEqual({ kind: 'workspace', key: 'workspace' })
		expect(parsePointResourceUri('uiux://view/a/b')).toBeUndefined()
		expect(parsePointResourceUri(`uiux://view/${VIEW_ID}?path=/tmp/design`)).toBeUndefined()
	})

	it('serves the exact same View read model through application and HTTP adapters', async () => {
		const { app } = await seededSession()
		const application = await app.readPointResource('view', VIEW_ID)
		const http = await readPointResourceForHttp(app, 'view', VIEW_ID)
		expect(http.status).toBe(200)
		if (http.status !== 200) return
		expect(http.body).toEqual(application)
		expect(http.body.revision).toMatch(/^r_/u)
		expect(http.body.diagnostics).toEqual([])
	})

	it('preserves file-native inspection diagnostics across application, HTTP and MCP point reads', async () => {
		const { root, app } = await seededSession()
		await writeFile(join(root, 'views', `${VIEW_ID}.view.json`), `${JSON.stringify({ ...viewFixture(), id: MISMATCHED_VIEW_ID })}\n`)

		const application = await app.readPointResource('view', VIEW_ID)
		const http = await readPointResourceForHttp(app, 'view', VIEW_ID)
		expect(application?.diagnostics.some(item => item.code === 'identity.filename_id_mismatch')).toBe(true)
		const discovery = await app.listPointResources({ kinds: ['view'], limit: 10 })
		expect(discovery.status).toBe('ok')
		if (discovery.status === 'ok') expect(discovery.page.items.find(item => item.key === VIEW_ID)?.diagnosticCount).toBeGreaterThan(0)
		expect(http.status).toBe(200)
		if (http.status !== 200) return
		expect(http.body.diagnostics).toEqual(application?.diagnostics)

		const handler = createUiuxMcpHttpHandler(app, { leases: createLeaseManager() })
		const client = new Client({ name: 'uiux-inspection-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), { fetch: async (input, init) => handler.fetch(new Request(input, init), { authInfo: principalAuthInfo(AGENT_EDITOR) }) })
		try {
			await client.connect(transport)
			const read = await client.readResource({ uri: pointResourceUri({ kind: 'view', key: VIEW_ID }) })
			const content = read.contents[0]
			const mcp = content && 'text' in content ? JSON.parse(content.text) : undefined
			expect(mcp.diagnostics).toEqual(application?.diagnostics)
		}
		finally { await client.close(); await handler.close() }
	})

	it('maps bad/missing HTTP resource addresses without inventing fallback semantics', async () => {
		const { app } = await seededSession()
		expect(await readPointResourceForHttp(app, 'unknown', VIEW_ID)).toMatchObject({ status: 400 })
		expect(await readPointResourceForHttp(app, 'view', 'not-a-uuid')).toMatchObject({ status: 400 })
		expect(await readPointResourceForHttp(app, 'locale', 'EN-us')).toMatchObject({ status: 400 })
		expect(await readPointResourceForHttp(app, 'view', MISSING_VIEW_ID)).toEqual({
			status: 404,
			body: { code: 'resource_not_found', kind: 'view', key: MISSING_VIEW_ID },
		})
	})

	it('serves the same point resource over real MCP HTTP and exposes no generic write/patch tools', async () => {
		const { app } = await seededSession()
		const expected = await app.readPointResource('view', VIEW_ID)
		const handler = createUiuxMcpHttpHandler(app, { leases: createLeaseManager() })
		const client = new Client(
			{ name: 'uiux-transport-test', version: '1.0.0' },
			{ versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } },
		)
		const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), {
			fetch: async (input, init) => handler.fetch(new Request(input, init), { authInfo: principalAuthInfo(AGENT_EDITOR) }),
		})
		try {
			await client.connect(transport)
			const read = await client.readResource({ uri: pointResourceUri({ kind: 'view', key: VIEW_ID }) })
			expect(read.contents).toHaveLength(1)
			const content = read.contents[0]
			expect(content?.uri).toBe(`uiux://view/${VIEW_ID}`)
			expect(content && 'text' in content ? JSON.parse(content.text) : undefined).toEqual(expected)
			const tools = await client.listTools()
			expect(tools.tools.map(tool => tool.name).sort()).toEqual([
				'acquire_lock',
				'append_review_message',
				'assess_handoff_readiness',
				'capture_formal_evidence',
				'create_asset',
				'create_flow',
				'create_locale',
				'create_review_thread',
				'create_view',
				'export_handoff',
				'list_resources',
				'promote_review_to_decision',
				'reanchor_review_thread',
				'release_lock',
				'reopen_review_thread',
				'replace_asset',
				'resolve_review_thread',
				'search_resources',
				'set_review_display_hint',
				'submit_ready_for_review',
				'update_flow',
				'update_locale',
				'update_view_spec',
				'update_view_structure',
				'update_workspace_settings',
			])
			expect(tools.tools.find(tool => tool.name === 'list_resources')?.annotations?.readOnlyHint).toBe(true)
			expect(tools.tools.find(tool => tool.name === 'search_resources')?.annotations?.readOnlyHint).toBe(true)
			expect(tools.tools.find(tool => tool.name === 'create_view')?.annotations?.readOnlyHint).toBe(false)
			expect(tools.tools.find(tool => tool.name === 'update_view_spec')?.annotations?.destructiveHint).toBe(true)
			expect(tools.tools.find(tool => tool.name === 'update_view_structure')?.annotations?.destructiveHint).toBe(true)
			expect(tools.tools.some(tool => /write|patch|filesystem/iu.test(tool.name))).toBe(false)
		}
		finally {
			await client.close()
			await handler.close()
		}
	})

	it('shares deterministic compact discovery semantics across application and HTTP', async () => {
		const { app } = await seededSession()
		const application = await app.listPointResources({ limit: 2 })
		expect(application.status).toBe('ok')
		if (application.status !== 'ok') return
		expect(application.page.items.map(item => [item.kind, item.key])).toEqual([
			['view', VIEW_ID],
			['view', VIEW_ID_2],
		])
		expect(application.page.nextCursor).toBeTruthy()
		expect(application.page.items.every(item => !('resource' in item))).toBe(true)

		const http = await listResourcesForHttp(app, { limit: 2 })
		expect(http).toEqual({ status: 200, body: application.page })

		const second = await app.listPointResources({ limit: 2, cursor: application.page.nextCursor })
		expect(second.status).toBe('ok')
		if (second.status !== 'ok') return
		expect(second.page.items.map(item => [item.kind, item.key])).toEqual([
			['flow', FLOW_ID],
			['locale', 'en-US'],
		])
		expect(second.page.nextCursor).toBeTruthy()

		const third = await app.listPointResources({ limit: 2, cursor: second.page.nextCursor })
		expect(third).toEqual(expect.objectContaining({
			status: 'ok',
			page: { items: [expect.objectContaining({ kind: 'locale', key: 'zh-TW' })] },
		}))
	})

	it('keeps syntax-invalid canonical resources discoverable by identity and revision without inventing a summary', async () => {
		const { root, app } = await seededSession()
		const corruptId = '77777777-7777-4777-8777-777777777777'
		await writeFile(join(root, 'views', `${corruptId}.view.json`), '{broken-json')
		const result = await app.listPointResources({ kinds: ['view'], limit: 10 })
		expect(result.status).toBe('ok')
		if (result.status !== 'ok') return
		const item = result.page.items.find(candidate => candidate.key === corruptId)
		expect(item).toMatchObject({ kind: 'view', key: corruptId, summary: {} })
		expect(item?.revision).toMatch(/^r_/u)
		expect(item?.diagnosticCount).toBeGreaterThan(0)
	})

	it('searches only compact identity/summary fields and binds cursors to their query scope', async () => {
		const { app } = await seededSession()
		const search = await app.searchPointResources({ query: 'checkout', limit: 10 })
		expect(search).toEqual(expect.objectContaining({
			status: 'ok',
			page: { items: [expect.objectContaining({ kind: 'view', key: VIEW_ID_2, summary: { name: 'Checkout panel', feature: 'catalog' } })] },
		}))
		const http = await searchResourcesForHttp(app, { query: 'CHECKOUT', limit: 10 })
		expect(http.status).toBe(200)
		if (http.status !== 200) return
		expect(http.body.items.map(item => item.key)).toEqual([VIEW_ID_2])

		const first = await app.listPointResources({ limit: 1 })
		expect(first.status).toBe('ok')
		if (first.status !== 'ok') return
		const wrongScope = await app.searchPointResources({ query: 'checkout', limit: 1, cursor: first.page.nextCursor })
		expect(wrongScope.status).toBe('invalid')
		if (wrongScope.status === 'invalid') expect(wrongScope.diagnostics.some(item => item.code === 'discovery.invalid_cursor')).toBe(true)
		expect((await app.listPointResources({ limit: 0 })).status).toBe('invalid')
		expect((await app.searchPointResources({ query: '   ', limit: 10 })).status).toBe('invalid')
	})

	it('exposes paginated read-only MCP discovery tools with Resource refs instead of large bodies', async () => {
		const { app } = await seededSession()
		const handler = createUiuxMcpHttpHandler(app, { leases: createLeaseManager() })
		const client = new Client({ name: 'uiux-discovery-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), { fetch: async (input, init) => handler.fetch(new Request(input, init), { authInfo: principalAuthInfo(AGENT_EDITOR) }) })
		try {
			await client.connect(transport)
			const first = await client.callTool({ name: 'list_resources', arguments: { limit: 2 } })
			const firstPage = first.structuredContent as { items: Array<Record<string, unknown>>; nextCursor?: string }
			expect(firstPage.items).toHaveLength(2)
			expect(firstPage.items[0]).toMatchObject({ kind: 'view', key: VIEW_ID, resourceUri: `uiux://view/${VIEW_ID}` })
			expect(firstPage.items.every(item => !Object.hasOwn(item, 'resource') && !Object.hasOwn(item, 'ir') && !Object.hasOwn(item, 'spec') && !Object.hasOwn(item, 'steps'))).toBe(true)
			expect(firstPage.nextCursor).toBeTruthy()

			const next = await client.callTool({ name: 'list_resources', arguments: { limit: 2, cursor: firstPage.nextCursor } })
			const nextPage = next.structuredContent as { items: Array<Record<string, unknown>> }
			expect(nextPage.items.map(item => [item.kind, item.key])).toEqual([['flow', FLOW_ID], ['locale', 'en-US']])

			const search = await client.callTool({ name: 'search_resources', arguments: { query: 'catalog', kinds: ['view'], limit: 10 } })
			const searchPage = search.structuredContent as { items: Array<Record<string, unknown>> }
			expect(searchPage.items).toHaveLength(1)
			expect(searchPage.items[0]).toMatchObject({ kind: 'view', key: VIEW_ID_2, resourceUri: `uiux://view/${VIEW_ID_2}` })

			const wrongScope = await client.callTool({ name: 'search_resources', arguments: { query: 'catalog', limit: 1, cursor: firstPage.nextCursor } })
			expect(wrongScope.isError).toBe(true)
			expect(wrongScope.content).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('different query scope') }))
			const invalidLimit = await client.callTool({ name: 'list_resources', arguments: { limit: 101 } })
			expect(invalidLimit.isError).toBe(true)
		}
		finally { await client.close(); await handler.close() }
	})

	it('returns standard MCP error codes for malformed and missing point resources', async () => {
		const { app } = await seededSession()
		const handler = createUiuxMcpHttpHandler(app, { leases: createLeaseManager() })
		const client = new Client({ name: 'uiux-error-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), { fetch: async (input, init) => handler.fetch(new Request(input, init), { authInfo: principalAuthInfo(AGENT_EDITOR) }) })
		try {
			await client.connect(transport)
			await expect(client.readResource({ uri: 'uiux://view/not-a-uuid' })).rejects.toMatchObject({ code: -32602 })
			const missingUri = pointResourceUri({ kind: 'view', key: MISSING_VIEW_ID })
			let missingError: unknown
			try { await client.readResource({ uri: missingUri }) } catch (error) { missingError = error }
			expect(missingError).toBeInstanceOf(ResourceNotFoundError)
			expect(missingError).toMatchObject({ uri: missingUri })
		}
		finally { await client.close(); await handler.close() }
	})

	it('reads Workspace, Flow and locale through the same selected-Workspace facade', async () => {
		const { app } = await seededSession()
		const workspace = await app.readPointResource('workspace', 'workspace')
		const flow = await app.readPointResource('flow', FLOW_ID)
		const locale = await app.readPointResource('locale', 'en-US')
		expect(workspace?.kind).toBe('workspace')
		expect(flow).toMatchObject({ kind: 'flow', key: FLOW_ID, diagnostics: [] })
		expect(locale).toMatchObject({ kind: 'locale', key: 'en-US', resource: { title: 'Title' }, diagnostics: [] })
	})

	it('reads canonical Review thread and authored Asset through application, HTTP and MCP with safe descriptor and no raw bytes', async () => {
		const { app, persistence } = await seededSession()
		await persistence.reviews.create(REVIEW_ID, reviewFixture())
		await persistence.assets.create(ASSET_ID, assetFixture())

		// Application point reads
		const reviewApp = await app.readPointResource('review', REVIEW_ID)
		expect(reviewApp).toMatchObject({ kind: 'review', key: REVIEW_ID, diagnostics: [] })
		expect(reviewApp?.kind === 'review' ? reviewApp.resource.status : undefined).toBe('open')

		const assetApp = await app.readPointResource('asset', ASSET_ID)
		expect(assetApp).toMatchObject({
			kind: 'asset',
			key: ASSET_ID,
			diagnostics: [],
			content: {
				mediaType: 'application/octet-stream',
				size: 5,
				contentUrl: `/api/assets/${ASSET_ID}/content`,
			},
		})
		expect(assetApp?.kind === 'asset' ? assetApp.content.digest : undefined).toMatch(/^sha256:[0-9a-f]{64}$/u)
		// Ensure raw Uint8Array is NOT serialized into generic JSON
		const serializedAsset = JSON.stringify(assetApp)
		expect(serializedAsset).not.toContain('"0":')
		expect(serializedAsset).toContain('"contentUrl":')

		// HTTP transport reads
		const reviewHttp = await readPointResourceForHttp(app, 'review', REVIEW_ID)
		expect(reviewHttp.status).toBe(200)
		expect(reviewHttp.body).toEqual(reviewApp)

		const assetHttp = await readPointResourceForHttp(app, 'asset', ASSET_ID)
		expect(assetHttp.status).toBe(200)
		expect(assetHttp.body).toEqual(assetApp)

		// MCP transport reads
		const handler = createUiuxMcpHttpHandler(app, { leases: createLeaseManager() })
		const client = new Client({ name: 'uiux-review-asset-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), { fetch: async (input, init) => handler.fetch(new Request(input, init), { authInfo: principalAuthInfo(AGENT_EDITOR) }) })
		try {
			await client.connect(transport)
			const readReviewMcp = await client.readResource({ uri: pointResourceUri({ kind: 'review', key: REVIEW_ID }) })
			const mcpReview = JSON.parse(readReviewMcp.contents[0]?.text ?? '{}')
			expect(mcpReview).toEqual(reviewApp)

			const readAssetMcp = await client.readResource({ uri: pointResourceUri({ kind: 'asset', key: ASSET_ID }) })
			const mcpAsset = JSON.parse(readAssetMcp.contents[0]?.text ?? '{}')
			expect(mcpAsset).toEqual(assetApp)
		}
		finally {
			await client.close()
			await handler.close()
		}
	})

	it('summarizes Review anchor, status, and message count in list and search discovery', async () => {
		const { app, persistence } = await seededSession()
		await persistence.reviews.create(REVIEW_ID, reviewFixture())
		await persistence.assets.create(ASSET_ID, assetFixture())

		const list = await app.listPointResources({ kinds: ['review', 'asset'], limit: 10 })
		expect(list.status).toBe('ok')
		if (list.status !== 'ok') return

		const reviewItem = list.page.items.find(item => item.kind === 'review' && item.key === REVIEW_ID)
		expect(reviewItem).toMatchObject({
			kind: 'review',
			key: REVIEW_ID,
			summary: {
				anchor: { viewId: VIEW_ID, widgetId: 'root' },
				status: 'open',
				messageCount: 1,
			},
		})

		const assetItem = list.page.items.find(item => item.kind === 'asset' && item.key === ASSET_ID)
		expect(assetItem).toMatchObject({
			kind: 'asset',
			key: ASSET_ID,
			summary: {
				name: 'Sample Icon',
				mediaType: 'application/octet-stream',
				contentFilename: 'icon.bin',
			},
		})

		const search = await app.searchPointResources({ query: 'Sample Icon', limit: 10 })
		expect(search.status).toBe('ok')
		if (search.status !== 'ok') return
		expect(search.page.items.map(item => item.key)).toContain(ASSET_ID)
	})

	it('preserves unreadable/repairable invalid states with diagnostics for Review and Asset', async () => {
		const { root, app } = await seededSession()
		const corruptReviewId = '77777777-1111-4777-8777-777777777777'
		const corruptAssetId = '77777777-2222-4777-8777-777777777777'

		await mkdir(join(root, 'reviews'), { recursive: true })
		await writeFile(join(root, 'reviews', `${corruptReviewId}.review.json`), '{corrupt-json')
		await mkdir(join(root, 'assets', corruptAssetId), { recursive: true })
		await writeFile(join(root, 'assets', corruptAssetId, 'asset.json'), '{corrupt-asset-json')

		const result = await app.listPointResources({ kinds: ['review', 'asset'], limit: 10 })
		expect(result.status).toBe('ok')
		if (result.status !== 'ok') return

		const reviewItem = result.page.items.find(item => item.key === corruptReviewId)
		expect(reviewItem).toMatchObject({ kind: 'review', key: corruptReviewId, summary: {} })
		expect(reviewItem?.diagnosticCount).toBeGreaterThan(0)

		const assetItem = result.page.items.find(item => item.key === corruptAssetId)
		expect(assetItem).toMatchObject({ kind: 'asset', key: corruptAssetId, summary: {} })
		expect(assetItem?.diagnosticCount).toBeGreaterThan(0)
	})
})

async function seededSession() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-transport-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: testSchemaPolicy })
	await persistence.workspace.create(workspaceFixture())
	await persistence.views.create(VIEW_ID, viewFixture())
	await persistence.views.create(VIEW_ID_2, viewFixture(VIEW_ID_2, 'Checkout panel', 'catalog'))
	await persistence.flows.create(FLOW_ID, flowFixture())
	await persistence.locales.create('en-US', { title: 'Title' })
	await persistence.locales.create('zh-TW', { title: '標題', action: '送出' })
	return { root, persistence, app: createWorkspaceApplicationSession(persistence) }
}

function workspaceFixture(): WorkspaceManifest {
	return {
		schemaVersion: 2,
		i18n: { defaultLocale: 'en-US' },
		adapters: [],
		viewports: { desktop: { dimensions: { width: 1280, height: 800 } } },
		themes: { light: {} },
	}
}

function viewFixture(id = VIEW_ID, name = 'Transport fixture', feature?: string): ViewResource {
	return {
		id,
		name,
		...(feature ? { feature } : {}),
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

function flowFixture(): FlowResource {
	const step = '44444444-4444-4444-8444-444444444444'
	return { id: FLOW_ID, name: 'Transport flow', entryStepId: step, steps: { [step]: { target: { viewId: VIEW_ID }, transitions: [] } } }
}

function reviewFixture(id = REVIEW_ID): ReviewThread {
	return {
		id,
		anchor: { viewId: VIEW_ID, widgetId: 'root' },
		variantNames: [],
		status: 'open',
		messages: [{ id: '99999999-1111-4111-8111-111111111111', actor: { type: 'agent', displayName: 'Antigravity' }, at: '2026-10-04T00:00:00.000Z', body: 'Review message fixture' }],
		history: [],
		submissions: [],
	}
}

function assetFixture(id = ASSET_ID): AuthoredAssetResource {
	return {
		metadata: { id, name: 'Sample Icon', contentFilename: 'icon.bin', mediaType: 'application/octet-stream' },
		content: new Uint8Array([1, 2, 3, 4, 5]),
	}
}
