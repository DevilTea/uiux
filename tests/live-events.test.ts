import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager } from '../src/application/access/leases'
import type { MemberPrincipal } from '../src/application/access/principal'
import { changeEventsForCommit, createChangeEventBus, publishCommits, publishLeaseChanges, type ChangeEvent } from '../src/application/services/change-events'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { FileNativePersistence } from '../src/persistence'
import type { CommittedResourceChange } from '../src/persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { changeEventFrame, closeEventStreamsOnShutdown, createEventStreamHub, EVENT_STREAM_RETRY_MS, type EventStreamHub } from '../src/server/event-stream'
import { testMember } from './support/access'
import { createCurrentWorkspace } from './support/workspace-layout'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const ASSET_ID = '55555555-5555-4555-8555-555555555555'
const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
const spec = { intent: 'x', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-live-events-unit-'))
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {} })
	const app = createWorkspaceApplicationSession(persistence)
	const commits: CommittedResourceChange[][] = []
	cleanups.push(persistence.onCanonicalCommit(changes => commits.push([...changes])))
	const bus = createChangeEventBus()
	cleanups.push(publishCommits(bus, persistence))
	const events: ChangeEvent[] = []
	cleanups.push(bus.subscribe(event => events.push(event)))
	return { root, persistence, app, commits, bus, events }
}

describe('commits become change events (Rules 01a11485-f365-70ce-82d9-43ea3f5ea5bb, 01a11485-f3bb-760b-9132-0e8c2f6bbf43)', () => {
	it('emits one resource.changed per committed resource with the revision reads return, the View and the Review of a promotion both', async () => {
		const ctx = await fixture()
		const view = await ctx.app.createView({ id: VIEW_ID, name: 'A', spec })
		const review = await ctx.app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		if (view.status !== 'created' || review.status !== 'created') throw new Error('fixture')
		ctx.events.length = 0
		const promoted = await ctx.app.promoteReviewToDecision({ reviewId: REVIEW_ID, expectedReviewRevision: review.revision, viewId: VIEW_ID, expectedViewRevision: view.revision, question: 'Keep it?' })
		expect(promoted.status).toBe('updated')
		const viewRevision = (await ctx.app.readPointResource('view', VIEW_ID))!.revision
		const reviewRevision = (await ctx.app.readPointResource('review', REVIEW_ID))!.revision
		expect([...ctx.events].sort((left, right) => ('kind' in left ? left.kind : '') < ('kind' in right ? right.kind : '') ? 1 : -1)).toEqual([
			{ type: 'resource.changed', kind: 'view', key: VIEW_ID, revision: viewRevision },
			{ type: 'resource.changed', kind: 'review', key: REVIEW_ID, revision: reviewRevision },
		])
	})

	it('reports an Asset by the revision of its whole directory, as reads do', async () => {
		const ctx = await fixture()
		const created = await ctx.app.createAsset({ id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png', contentBase64: Buffer.from([...PNG, 1]).toString('base64') })
		expect(created.status).toBe('created')
		const read = await ctx.app.readPointResource('asset', ASSET_ID)
		expect(ctx.events).toEqual([{ type: 'resource.changed', kind: 'asset', key: ASSET_ID, revision: read!.revision }])
	})

	it('emits nothing for a refused write, and resource.changed for the Product Kit file (Discussion #241 owner decision 2)', async () => {
		const ctx = await fixture()
		const view = await ctx.app.createView({ id: VIEW_ID, name: 'A', spec })
		ctx.events.length = 0
		ctx.commits.length = 0
		expect((await ctx.app.updateViewSpec({ key: VIEW_ID, expectedRevision: 'r_stale' as never, spec })).status).toBe('conflict')
		expect(ctx.commits).toEqual([])
		const kit = await ctx.app.readProductKit()
		const updated = await ctx.app.updateProductKit({ expectedRevision: kit!.revision, adapters: [], styles: ['./dist/kit.css'], themes: {} })
		expect(updated.status).toBe('updated')
		expect(ctx.commits.map(changes => changes.map(change => change.kind))).toEqual([['product-kit']])
		expect(ctx.events).toEqual([{ type: 'resource.changed', kind: 'product-kit', key: 'product-kit', revision: (updated as { revision: string }).revision }])
		expect((await ctx.app.readProductKit())!.revision).toBe((updated as { revision: string }).revision)
		expect(view.status).toBe('created')
	})

	it('maps a removal to resource.removed, and keeps only the content-free fields on the wire', () => {
		expect(changeEventsForCommit([{ kind: 'review', key: REVIEW_ID, revision: null }])).toEqual([{ type: 'resource.removed', kind: 'review', key: REVIEW_ID }])
		const frame = changeEventFrame({ type: 'resource.changed', kind: 'view', key: VIEW_ID, revision: 'r_x' as never, body: 'secret' } as never)
		expect(frame).toBe(`event: resource.changed\ndata: {"kind":"view","key":"${VIEW_ID}","revision":"r_x"}\n\n`)
		expect(changeEventFrame({ type: 'access.changed', members: ['secret'] } as never)).toBe('event: access.changed\ndata: {}\n\n')
	})

	it('gives every bus its own server instance ID, so a restarted server is told apart (Rule 01a11485-f39f-7464-9f8f-608335ed9800)', () => {
		expect(createChangeEventBus().serverInstanceId).not.toBe(createChangeEventBus().serverInstanceId)
	})
})

describe('the stream hub (Clause 01a114ec-e839-7b11-957c-41c88b692e12)', () => {
	async function serveHub(options: Readonly<{ principal?: MemberPrincipal; heartbeatMs?: number; onHeartbeat?: () => void; keys?: () => readonly string[] | undefined; maxStreams?: number; maxBufferedBytes?: number }> = {}) {
		const bus = createChangeEventBus()
		const principal = options.principal ?? testMember({ nickname: 'lead', kind: 'human', preset: 'viewer', credential: 'session' })
		const hub: EventStreamHub = createEventStreamHub({
			bus,
			credentialKeys: () => (options.keys ? options.keys() : principal.keys) as never,
			...(options.onHeartbeat ? { onHeartbeat: options.onHeartbeat } : {}),
			heartbeatMs: options.heartbeatMs ?? 60_000,
			...(options.maxStreams ? { maxStreams: options.maxStreams } : {}),
			...(options.maxBufferedBytes ? { maxBufferedBytes: options.maxBufferedBytes } : {}),
		})
		const app = createApp()
		app.use(defineEventHandler((event) => {
			event.context.uiuxPrincipal = principal
			return hub.serve(event)
		}))
		const server: Server = createServer(toNodeListener(app))
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		cleanups.push(async () => {
			hub.close()
			server.closeAllConnections()
			await new Promise<void>(resolve => server.close(() => resolve()))
		})
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`
		return { bus, hub, url }
	}

	async function read(url: string, until: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
		const controller = new AbortController()
		const response = await fetch(url, { signal: controller.signal })
		const reader = response.body!.getReader()
		const decoder = new TextDecoder()
		let text = ''
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			while (!until(text)) {
				const { value, done } = await reader.read()
				if (done) break
				text += decoder.decode(value, { stream: true })
			}
		}
		catch { /* aborted at the timeout */ }
		finally {
			clearTimeout(timer)
			controller.abort()
		}
		return text
	}

	it('sends retry: 3000 and hello first, then a named heartbeat event with {} on every heartbeat, after the heartbeat work', async () => {
		let beats = 0
		const { url, bus } = await serveHub({ heartbeatMs: 40, onHeartbeat: () => { beats += 1 } })
		const frame = 'event: heartbeat\ndata: {}\n\n'
		const text = await read(url, value => value.split(frame).length > 2)
		expect(EVENT_STREAM_RETRY_MS).toBe(3000)
		expect(text.startsWith(`retry: 3000\n\nevent: hello\ndata: {"serverInstanceId":"${bus.serverInstanceId}"}\n\n`)).toBe(true)
		expect(text.split(frame).length).toBeGreaterThan(2)
		expect(text).not.toMatch(/^: heartbeat/mu)
		expect(beats).toBeGreaterThan(1)
	})

	it('disconnects a client that stops reading once its buffered data passes the bound', async () => {
		const { url, bus, hub } = await serveHub({ maxBufferedBytes: 4096 })
		const controller = new AbortController()
		const response = await fetch(url, { signal: controller.signal })
		expect(response.status).toBe(200)
		// The client never reads the body; the server keeps writing until the socket buffers fill.
		for (let attempt = 0; attempt < 200 && hub.size > 0; attempt++) {
			for (let index = 0; index < 2000; index++) bus.publish({ type: 'resource.changed', kind: 'view', key: `${VIEW_ID}-${index}`, revision: 'r_x' as never })
			await new Promise(resolve => setTimeout(resolve, 5))
		}
		expect(hub.size).toBe(0)
		expect(bus.subscriberCount).toBe(0)
		// The connection was dropped, not ended after the backlog: reading on fails instead of finishing.
		await expect(response.text()).rejects.toThrow()
		controller.abort()
	})

	it('drops every open stream on close(), so a graceful shutdown does not wait on them', async () => {
		const { url, hub } = await serveHub()
		const controller = new AbortController()
		const response = await fetch(url, { signal: controller.signal })
		const reader = response.body!.getReader()
		await reader.read()
		expect(hub.size).toBe(1)
		hub.close()
		expect(hub.size).toBe(0)
		// The client sees the connection end (a clean end or a reset, either way not a hanging read).
		const ended = await (async () => {
			try { for (;;) if ((await reader.read()).done) return 'done' }
			catch { return 'reset' }
		})()
		expect(['done', 'reset']).toContain(ended)
		controller.abort()
	})

	it('closes the streams on the shutdown signals Nitro handles, and installs nothing when its shutdown is disabled', () => {
		const handlers = new Map<string, () => void>()
		const target = { on: (signal: string, handler: () => void) => { handlers.set(signal, handler); return target }, off: (signal: string) => { handlers.delete(signal); return target } }
		let closed = 0
		const remove = closeEventStreamsOnShutdown({ close: () => { closed += 1 } }, {}, target as never)
		expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM'])
		handlers.get('SIGTERM')!()
		expect(closed).toBe(1)
		remove()
		expect(handlers.size).toBe(0)
		closeEventStreamsOnShutdown({ close: () => {} }, { NITRO_SHUTDOWN_SIGNALS: 'SIGHUP' }, target as never)
		expect([...handlers.keys()]).toEqual(['SIGHUP'])
		handlers.clear()
		closeEventStreamsOnShutdown({ close: () => {} }, { NITRO_SHUTDOWN_DISABLED: '1' }, target as never)
		expect(handlers.size).toBe(0)
	})

	it('emits lock.changed for a lease that expired, found by the heartbeat sweep (Rule 01a114ec-e706-7c39-84a6-2e4a536daed2)', async () => {
		let now = 1_000_000
		const leases = createLeaseManager({ now: () => now, ttlMs: 1000 })
		leases.acquire([{ kind: 'view', key: VIEW_ID }], { memberId: 'm', nickname: 'claude', kind: 'agent' })
		const served = await serveHub({ heartbeatMs: 40, onHeartbeat: () => { leases.list() } })
		cleanups.push(publishLeaseChanges(served.bus, leases))
		now += 5000
		const text = await read(served.url, value => value.includes('event: lock.changed'))
		expect(text).toContain(`event: lock.changed\ndata: {"kind":"view","key":"${VIEW_ID}"}\n\n`)
	})

	it('closes a stream whose credential ended at the next check', async () => {
		let valid = true
		const { url, hub } = await serveHub({ heartbeatMs: 40, keys: () => valid ? ['workspace.read'] : undefined })
		const controller = new AbortController()
		const response = await fetch(url, { signal: controller.signal })
		const reader = response.body!.getReader()
		await reader.read()
		expect(hub.size).toBe(1)
		valid = false
		hub.revalidate()
		let done = false
		for (let index = 0; index < 20 && !done; index++) done = (await reader.read()).done
		expect(done).toBe(true)
		expect(hub.size).toBe(0)
	})

	it('refuses a stream over the server-wide cap with 429', async () => {
		const { url } = await serveHub({ maxStreams: 1 })
		const controller = new AbortController()
		const first = await fetch(url, { signal: controller.signal })
		expect(first.status).toBe(200)
		const second = await fetch(url)
		expect(second.status).toBe(429)
		expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
		expect(await second.json()).toMatchObject({ code: 'events.stream_limit' })
		controller.abort()
	})
})
