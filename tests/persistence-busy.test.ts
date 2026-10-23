import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createApp, createError, createRouter, defineEventHandler, toWebHandler } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager } from '../src/application/access/leases'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { isFullUuid } from '../src/domain/validation'
import { createUiuxMcpHttpHandler, principalAuthInfo } from '../src/mcp/server'
import { FileNativePersistence, PersistenceError, isPersistenceBusyError, persistenceBusyResult } from '../src/persistence'
import { BOOT_STALENESS_TOLERANCE_MS, currentBootId, currentBootTimeMs, resetBootIdForTests } from '../src/persistence/boot-staleness'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { sendPersistenceBusyError } from '../src/server/persistence-busy'
import { describeFetchError, isTransientError } from '../app/utils/fetch-error'
import { isRetryableRead, shouldRetryRead, transientRetryDelay } from '../app/utils/fetch-retry'
import { AGENT_EDITOR } from './support/access'
import { writeCurrentWorkspace, writeManifest } from './support/workspace-layout'

const BOOT_ID = await currentBootId()
const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const ASSET_ID = '55555555-5555-4555-8555-555555555555'
const roots: string[] = []

afterEach(async () => {
	resetBootIdForTests()
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
	await mkdir(join(root, 'views'), { recursive: true })
	await mkdir(join(root, 'assets', ASSET_ID), { recursive: true })
	await writeCurrentWorkspace(root)
	if (schemaVersion !== CURRENT_WORKSPACE_SCHEMA_VERSION) await writeManifest(root, { schemaVersion, i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {} })
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

/** The pid of a process that has exited, as a crashed lock holder leaves it behind. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ['-e', ''])
	if (child.error || typeof child.pid !== 'number') throw new Error('Could not spawn a short-lived process.', { cause: child.error })
	return child.pid
}

async function lockCandidates(root: string): Promise<string[]> {
	return (await readdir(root)).filter(name => name.startsWith('.persistence-lock-'))
}

describe('persistence lock file (issue #321)', () => {
	it('publishes the owner record while held and leaves neither the lock nor a candidate behind', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const persistence = open(root)
		const lockPath = join(root, persistence.layout.lockPath)
		await persistence.withLock(async () => {
			const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: unknown; token: unknown; bootId?: unknown }
			expect(owner.pid).toBe(process.pid)
			expect(owner.bootId).toBe(BOOT_ID)
			expect((owner as { hostname?: unknown }).hostname).toBe(hostname())
			expect(typeof owner.token === 'string' && isFullUuid(owner.token)).toBe(true)
			expect(await lockCandidates(root)).toEqual([])
		})
		expect(await readFile(lockPath).catch(error => error.code)).toBe('ENOENT')
		await persistence.withReadLock(async () => undefined)
		expect(await readFile(lockPath).catch(error => error.code)).toBe('ENOENT')
		expect(await lockCandidates(root)).toEqual([])
	})

	it('clears the lock of a holder that crashed while holding it, and the operation goes on', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const lockPath = join(root, '.persistence.lock')
		// What a holder killed between publishing and removing its candidate leaves on disk.
		const token = randomUUID()
		const candidate = join(root, `.persistence-lock-${token}-${randomUUID()}.tmp`)
		await writeFile(candidate, JSON.stringify({ pid: deadPid(), token }))
		await link(candidate, lockPath)
		const persistence = open(root, 500)
		expect((await persistence.views.read(VIEW_ID))?.resource).toMatchObject({ id: VIEW_ID })
		expect(await readFile(lockPath).catch(error => error.code)).toBe('ENOENT')
		await persistence.withLock(async () => undefined)
	})

	it('waits for a live holder in another process until the wait budget, then refuses as persistence.lock_busy', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const lockPath = join(root, '.persistence.lock')
		const record = JSON.stringify({ pid: process.pid, token: randomUUID() })
		await writeFile(lockPath, record)
		await expect(open(root, 120).views.read(VIEW_ID)).rejects.toMatchObject({ code: 'persistence.lock_busy' })
		expect(await readFile(lockPath, 'utf8')).toBe(record)
		await rm(lockPath)
		expect((await open(root, 120).views.read(VIEW_ID))?.resource).toMatchObject({ id: VIEW_ID })
	})

	it('refuses, and keeps, a lock written since boot whose owner record is unreadable', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const lockPath = join(root, '.persistence.lock')
		await writeFile(lockPath, '')
		await expect(open(root, 120).views.read(VIEW_ID)).rejects.toMatchObject({ code: 'persistence.lock_busy', message: expect.stringContaining('unreadable') })
		expect(await readFile(lockPath, 'utf8')).toBe('')
	})

	// Owner ruling 2026-10-23 (Discussion #241): a lock from an earlier boot is stale whatever it records.
	it.skipIf(BOOT_ID === undefined)('clears a lock that records another boot, even with a live pid and a fresh time', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const lockPath = join(root, '.persistence.lock')
		await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: randomUUID(), bootId: randomUUID() }))
		expect((await open(root, 120).views.read(VIEW_ID))?.resource).toMatchObject({ id: VIEW_ID })
		expect(await readFile(lockPath).catch(error => error.code)).toBe('ENOENT')
	})

	it('keeps the lock of another host, whatever boot or pid it records', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const lockPath = join(root, '.persistence.lock')
		const record = JSON.stringify({ pid: deadPid(), hostname: `${hostname()}-elsewhere`, token: randomUUID(), bootId: randomUUID() })
		await writeFile(lockPath, record)
		const beforeBoot = new Date(currentBootTimeMs() - 60_000)
		await utimes(lockPath, beforeBoot, beforeBoot)
		await expect(open(root, 120).views.read(VIEW_ID)).rejects.toMatchObject({ code: 'persistence.lock_busy' })
		expect(await readFile(lockPath, 'utf8')).toBe(record)
	})

	it('judges a lock by its time when this process has no boot identifier, although the lock records one', async () => {
		resetBootIdForTests({ read: async () => { throw new Error('sysctl unavailable') } })
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const lockPath = join(root, '.persistence.lock')
		const record = JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID(), bootId: randomUUID() })
		await writeFile(lockPath, record)
		await expect(open(root, 120).views.read(VIEW_ID)).rejects.toMatchObject({ code: 'persistence.lock_busy' })
		const beforeBoot = new Date(currentBootTimeMs() - 60_000)
		await utimes(lockPath, beforeBoot, beforeBoot)
		expect((await open(root, 120).views.read(VIEW_ID))?.resource).toMatchObject({ id: VIEW_ID })
		expect(await readFile(lockPath).catch(error => error.code)).toBe('ENOENT')
	})

	it.skipIf(BOOT_ID === undefined)('keeps a live lock that records the current boot although its time lies before boot (a clock step)', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const lockPath = join(root, '.persistence.lock')
		const record = JSON.stringify({ pid: process.pid, token: randomUUID(), bootId: BOOT_ID })
		await writeFile(lockPath, record)
		const beforeBoot = new Date(currentBootTimeMs() - 60_000)
		await utimes(lockPath, beforeBoot, beforeBoot)
		await expect(open(root, 120).views.read(VIEW_ID)).rejects.toMatchObject({ code: 'persistence.lock_busy' })
		expect(await readFile(lockPath, 'utf8')).toBe(record)
	})

	it.each([
		['the pid of this live process', () => JSON.stringify({ pid: process.pid, token: randomUUID() })],
		['pid 1, which answers EPERM or is alive', () => JSON.stringify({ pid: 1, token: randomUUID() })],
		['no bytes at all', () => ''],
		['a partial record', () => '{"pid":'],
	])('clears a lock without a boot identifier written before the current boot that records %s', async (_label, record) => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const lockPath = join(root, '.persistence.lock')
		await writeFile(lockPath, record())
		const beforeBoot = new Date(currentBootTimeMs() - 60_000)
		await utimes(lockPath, beforeBoot, beforeBoot)
		expect((await open(root, 120).views.read(VIEW_ID))?.resource).toMatchObject({ id: VIEW_ID })
		expect(await readFile(lockPath).catch(error => error.code)).toBe('ENOENT')
	})

	it('keeps a live lock whose time lies within the tolerance before boot', async () => {
		const root = await seedWorkspace(CURRENT_WORKSPACE_SCHEMA_VERSION)
		const lockPath = join(root, '.persistence.lock')
		await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: randomUUID() }))
		const nearBoot = new Date(currentBootTimeMs() - BOOT_STALENESS_TOLERANCE_MS / 2)
		await utimes(lockPath, nearBoot, nearBoot)
		await expect(open(root, 120).views.read(VIEW_ID)).rejects.toMatchObject({ code: 'persistence.lock_busy' })
		expect((await stat(lockPath)).isFile()).toBe(true)
	})
})

describe('persistence.busy transport mapping', () => {
	const busy = () => new PersistenceError('persistence.lock_busy', 'Timed out waiting for another UIUX persistence operation to finish.')

	it('recognizes the lock timeout directly and through h3 error wrapping, and nothing else', () => {
		expect(isPersistenceBusyError(busy())).toBe(true)
		expect(isPersistenceBusyError(createError(busy()))).toBe(true)
		expect(isPersistenceBusyError(new PersistenceError('workspace.schema_unsupported', 'unsupported'))).toBe(false)
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
		expect(isTransientError(describeFetchError({ statusCode: 422, data: { status: 'blocked', code: 'workspace.schema_unsupported' } }, 'fallback'))).toBe(false)
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
