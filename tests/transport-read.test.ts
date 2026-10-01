import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ResourceNotFoundError } from '@modelcontextprotocol/server'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { FlowResource } from '../src/domain/flows/schema'
import type { ViewResource } from '../src/domain/views/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { createUiuxMcpHttpHandler } from '../src/mcp/server'
import { parsePointResourceUri, pointResourceUri } from '../src/mcp/resource-uri'
import { FileNativePersistence } from '../src/persistence'
import { defineWorkspaceSchemaPolicy } from '../src/persistence/schema-policy'
import { readPointResourceForHttp } from '../src/server/point-resource'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const roots: string[] = []
const testSchemaPolicy = defineWorkspaceSchemaPolicy({ currentVersion: 2, recognizedVersions: [2], steps: [] })

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('shared HTTP/MCP point-resource reads', () => {
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
		const mismatchedId = '33333333-3333-4333-8333-333333333333'
		await writeFile(join(root, 'views', `${VIEW_ID}.view.json`), `${JSON.stringify({ ...viewFixture(), id: mismatchedId })}\n`)

		const application = await app.readPointResource('view', VIEW_ID)
		const http = await readPointResourceForHttp(app, 'view', VIEW_ID)
		expect(application?.diagnostics.some(item => item.code === 'identity.filename_id_mismatch')).toBe(true)
		expect(http.status).toBe(200)
		if (http.status !== 200) return
		expect(http.body.diagnostics).toEqual(application?.diagnostics)

		const handler = createUiuxMcpHttpHandler(app)
		const client = new Client({ name: 'uiux-inspection-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), { fetch: async (input, init) => handler.fetch(new Request(input, init)) })
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
		expect(await readPointResourceForHttp(app, 'view', '33333333-3333-4333-8333-333333333333')).toEqual({
			status: 404,
			body: { code: 'resource_not_found', kind: 'view', key: '33333333-3333-4333-8333-333333333333' },
		})
	})

	it('serves the same point resource over real MCP HTTP and exposes no generic write/patch tools', async () => {
		const { app } = await seededSession()
		const expected = await app.readPointResource('view', VIEW_ID)
		const handler = createUiuxMcpHttpHandler(app)
		const client = new Client(
			{ name: 'uiux-transport-test', version: '1.0.0' },
			{ versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } },
		)
		const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), {
			fetch: async (input, init) => handler.fetch(new Request(input, init)),
		})
		try {
			await client.connect(transport)
			const read = await client.readResource({ uri: pointResourceUri({ kind: 'view', key: VIEW_ID }) })
			expect(read.contents).toHaveLength(1)
			const content = read.contents[0]
			expect(content?.uri).toBe(`uiux://view/${VIEW_ID}`)
			expect(content && 'text' in content ? JSON.parse(content.text) : undefined).toEqual(expected)
			expect(client.getServerCapabilities()?.tools).toBeUndefined()
		}
		finally {
			await client.close()
			await handler.close()
		}
	})

	it('returns standard MCP error codes for malformed and missing point resources', async () => {
		const { app } = await seededSession()
		const handler = createUiuxMcpHttpHandler(app)
		const client = new Client({ name: 'uiux-error-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), { fetch: async (input, init) => handler.fetch(new Request(input, init)) })
		try {
			await client.connect(transport)
			await expect(client.readResource({ uri: 'uiux://view/not-a-uuid' })).rejects.toMatchObject({ code: -32602 })
			const missingUri = pointResourceUri({ kind: 'view', key: '33333333-3333-4333-8333-333333333333' })
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
})

async function seededSession() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-transport-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: testSchemaPolicy })
	await persistence.workspace.create(workspaceFixture())
	await persistence.views.create(VIEW_ID, viewFixture())
	await persistence.flows.create(FLOW_ID, flowFixture())
	await persistence.locales.create('en-US', { title: 'Title' })
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

function viewFixture(): ViewResource {
	return {
		id: VIEW_ID,
		name: 'Transport fixture',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

function flowFixture(): FlowResource {
	const step = '44444444-4444-4444-8444-444444444444'
	return { id: FLOW_ID, name: 'Transport flow', entryStepId: step, steps: { [step]: { target: { viewId: VIEW_ID }, transitions: [] } } }
}
