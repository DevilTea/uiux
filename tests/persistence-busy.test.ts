import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createApp, createError, createRouter, defineEventHandler, toWebHandler } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager } from '../src/application/access/leases'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { createUiuxMcpHttpHandler, principalAuthInfo } from '../src/mcp/server'
import { FileNativePersistence, PersistenceError, isPersistenceBusyError, persistenceBusyResult } from '../src/persistence'
import { workspaceRelativePath } from '../src/persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { sendPersistenceBusyError } from '../src/server/persistence-busy'
import { describeFetchError, isTransientError } from '../app/utils/fetch-error'
import { isRetryableRead, shouldRetryRead, transientRetryDelay } from '../app/utils/fetch-retry'
import { AGENT_EDITOR } from './support/access'

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
	spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
}

async function seedWorkspace(schemaVersion: number): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-busy-'))
	roots.push(root)
	await mkdir(join(root, '.uiux'), { recursive: true })
	await mkdir(join(root, 'views'), { recursive: true })
	await mkdir(join(root, 'assets', ASSET_ID), { recursive: true })
	await writeFile(join(root, workspaceRelativePath()), `${JSON.stringify({ schemaVersion, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })}\n`)
	await writeFile(join(root, 'views', `${VIEW_ID}.view.json`), `${JSON.stringify(view)}\n`)
	await writeFile(join(root, 'assets', ASSET_ID, 'asset.json'), `${JSON.stringify({ id: ASSET_ID, name: 'icon', contentFilename: 'icon.svg', mediaType: 'image/svg+xml' })}\n`)
	await writeFile(join(root, 'assets', ASSET_ID, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
	return root
}

function open(root: string, lockWaitMilliseconds?: number): FileNativePersistence {
	return new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY, ...(lockWaitMilliseconds ? { lockWaitMilliseconds } : {}) })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>(done => resolve = done)
	return { promise, resolve }
}

/** Holds the cross-process persistence lock from a second instance until `release` is called. */
async function holdLockElsewhere(root: string): Promise<{ release: () => Promise<void> }> {
	const holder = open(root)
	const entered = deferred()
	const gate = deferred()
	const done = holder.withLock(async () => {
		entered.resolve()
		await gate.promise
	})
	await entered.promise
	return { release: async () => { gate.resolve(); await done } }
}

describe('persistence lock sharing', () => {
	it('lets concurrent reads in one process share the lock instead of queueing on it', async () => {
		const persistence = open(await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION))
		const inside = deferred()
		const gate = deferred()
		const firstRead = persistence.withReadLock(async () => {
			inside.resolve()
			await gate.promise
			return 'first'
		})
		await inside.promise
		// The first read is still inside the lock; a second read completes anyway.
		expect((await persistence.views.read(VIEW_ID))?.resource).toMatchObject({ id: VIEW_ID })
		expect(await Promise.all(Array.from({ length: 25 }, () => persistence.inspectWorkspace())).then(all => all.every(item => item.inspection.state === 'current'))).toBe(true)
		gate.resolve()
		expect(await firstRead).toBe('first')
	})

	it('admits a waiting writer before readers that arrive after it, so writes are not starved', async () => {
		const persistence = open(await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION))
		const events: string[] = []
		const inside = deferred()
		const gate = deferred()
		const firstRead = persistence.withReadLock(async () => {
			inside.resolve()
			await gate.promise
			events.push('read-1')
		})
		await inside.promise
		const write = persistence.withLock(async () => { events.push('write') })
		const lateRead = persistence.withReadLock(async () => { events.push('read-2') })
		await new Promise(resolve => setTimeout(resolve, 30))
		expect(events).toEqual([])
		gate.resolve()
		await Promise.all([firstRead, write, lateRead])
		expect(events).toEqual(['read-1', 'write', 'read-2'])
	})

	it('still excludes another process: reads wait for its lock and time out as persistence.lock_busy', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const elsewhere = await holdLockElsewhere(root)
		try {
			const reader = open(root, 150)
			await expect(reader.views.read(VIEW_ID)).rejects.toMatchObject({ code: 'persistence.lock_busy' })
			// A reader queued in-process behind the timed-out one also gives up within its own budget.
			await expect(Promise.all([reader.inspectWorkspace(), reader.views.discoverKeys()])).rejects.toMatchObject({ code: 'persistence.lock_busy' })
		}
		finally {
			await elsewhere.release()
		}
		expect((await open(root, 150).views.read(VIEW_ID))?.resource).toMatchObject({ id: VIEW_ID })
	})

	it('times out an in-process waiter queued behind a long exclusive operation', async () => {
		const persistence = open(await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION), 120)
		const inside = deferred()
		const gate = deferred()
		const write = persistence.withLock(async () => {
			inside.resolve()
			await gate.promise
		})
		await inside.promise
		await expect(persistence.views.read(VIEW_ID)).rejects.toMatchObject({ code: 'persistence.lock_busy' })
		gate.resolve()
		await write
		expect((await persistence.views.read(VIEW_ID))?.resource).toMatchObject({ id: VIEW_ID })
	})
})

describe('persistence.busy transport mapping', () => {
	const busy = () => new PersistenceError('persistence.lock_busy', 'Timed out waiting for another UIUX persistence operation to finish.')

	it('recognizes the lock timeout directly and through h3 error wrapping, and nothing else', () => {
		expect(isPersistenceBusyError(busy())).toBe(true)
		expect(isPersistenceBusyError(createError(busy()))).toBe(true)
		expect(isPersistenceBusyError(new PersistenceError('workspace.migration_required', 'migrate'))).toBe(false)
		expect(isPersistenceBusyError(new Error('Timed out'))).toBe(false)
	})

	it('answers HTTP with a retryable 503, Retry-After and a coded diagnostic; other errors fall through', async () => {
		const app = createApp({
			onError: async (error, event) => {
				await sendPersistenceBusyError(error, event)
			},
		})
		const router = createRouter()
			.get('/busy', defineEventHandler(() => { throw busy() }))
			.get('/other', defineEventHandler(() => { throw new Error('boom') }))
		app.use(router)
		const handler = toWebHandler(app)
		const response = await handler(new Request('http://uiux.test/busy'))
		expect(response.status).toBe(503)
		expect(response.headers.get('retry-after')).toBe('1')
		expect(response.headers.get('cache-control')).toBe('no-store')
		const body = await response.json()
		expect(body).toEqual(persistenceBusyResult())
		expect(body).toMatchObject({ status: 'unavailable', code: 'persistence.busy', retryable: true, diagnostics: [{ code: 'persistence.busy', path: '/' }] })
		const other = await handler(new Request('http://uiux.test/other'))
		expect(other.status).toBe(500)
	})

	it('answers MCP tools with a persistence.busy error result and resource reads with a coded JSON-RPC error', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const app = createWorkspaceApplicationSession(open(root, 150))
		const handler = createUiuxMcpHttpHandler(app, { leases: createLeaseManager() })
		const client = new Client({ name: 'uiux-busy-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), {
			fetch: async (input, init) => handler.fetch(new Request(input, init), { authInfo: principalAuthInfo(AGENT_EDITOR) }),
		})
		await client.connect(transport)
		const elsewhere = await holdLockElsewhere(root)
		try {
			const tool = await client.callTool({ name: 'list_resources', arguments: { kinds: ['view'], limit: 10 } })
			expect(tool.isError).toBe(true)
			expect(tool.structuredContent).toMatchObject({ code: 'persistence.busy', retryable: true })
			await expect(client.readResource({ uri: `uiux://view/${VIEW_ID}` })).rejects.toMatchObject({ code: -32603, data: { code: 'persistence.busy' } })
		}
		finally {
			await elsewhere.release()
			await client.close()
			await handler.close()
		}
	})

	it('lets the Workbench classify a 503 persistence.busy as transient', () => {
		const details = describeFetchError({ statusCode: 503, data: persistenceBusyResult() }, 'fallback')
		expect(isTransientError(details)).toBe(true)
		expect(details.diagnostics[0]?.code).toBe('persistence.busy')
		expect(isTransientError(describeFetchError({ statusCode: 422, data: { status: 'blocked', code: 'workspace.migration_required' } }, 'fallback'))).toBe(false)
	})

	it('retries only reads, once, after the capped Retry-After', () => {
		expect(isRetryableRead('/api/resources/view/x', '/api/resources/view/x')).toBe(true)
		expect(isRetryableRead('/api/resources/list', '/api/resources/list', { method: 'POST', body: '{}' })).toBe(true)
		expect(isRetryableRead('/api/handoff/assess', '/api/handoff/assess', { method: 'POST', body: '{}' })).toBe(true)
		expect(isRetryableRead('/api/handoff/export', '/api/handoff/export', { method: 'POST', body: '{}' })).toBe(false)
		expect(isRetryableRead('/api/views/x/spec', '/api/views/x/spec', { method: 'PUT', body: '{}' })).toBe(false)
		const busy = new Response('{}', { status: 503, headers: { 'retry-after': '1' } })
		expect(shouldRetryRead(busy)).toBe(true)
		expect(shouldRetryRead(new Response('{}', { status: 503 }))).toBe(false)
		expect(shouldRetryRead(new Response('{}', { status: 500, headers: { 'retry-after': '1' } }))).toBe(false)
		expect(transientRetryDelay(busy, () => 0)).toBe(1000)
		expect(transientRetryDelay(new Response('{}', { status: 503, headers: { 'retry-after': '60' } }), () => 0.999)).toBe(3249)
	})
})
