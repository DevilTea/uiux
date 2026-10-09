import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MemberPrincipal } from '../src/application/access/principal'
import { createHistoryRecorder, type HistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_EVENTS, AUTOSAVE_MAX_SPAN_MS, HOST_PRUNE_INTERVAL_MS, HOST_RETENTION_MAX_AGE_MS, HOST_RETENTION_MIN_KEPT } from '../src/domain/history/constants'
import type { HostVersionRecord, VersionRecord } from '../src/domain/history/schema'
import { FileNativePersistence, localeRelativePath, viewRelativePath, type PersistenceFaultHook } from '../src/persistence'
import {
	CheckpointStore,
	HostHistoryStore,
	currentDesignWriteContext,
	readMergedTimeline,
	runWithDesignWriteContext,
	versionResourcesFromSnapshot,
	type DesignWriteContext,
} from '../src/persistence/history'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { hostHistoryPaths } from '../src/server/access/store'
import { createSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { connectMcp, scoped, testMember } from './support/access'

/**
 * The autosave recorder (issue #132 B3): Rules 01a11a5d-fec6, ff1c, ff72, ffc6 and 01a11a5e-0018,
 * 0068, 00b9, 010b, 01b5, 020b, 025f, 02b6, 0313, 036d, 03c9, 0873, 0ac6, 0b79; Clauses 2119,
 * 21c4, 221b, 22ca, 2320, 2374; Scenarios 01a11a5e-903e-… and 01a11a5e-91d5-….
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VIEW_ID = '22222222-2222-4222-8222-222222222222'
const REVIEW_ID = '33333333-3333-4333-8333-333333333333'
const START = Date.parse('2026-10-09T00:00:00.000Z')

const AGENT = testMember({ memberId: 'agent-1', nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })
const OTHER_AGENT = testMember({ memberId: 'agent-2', nickname: 'codex', kind: 'agent', role: 'editor', credential: 'token' })
const HUMAN = testMember({ memberId: 'human-1', nickname: 'mei', kind: 'human', role: 'owner', credential: 'session' })

const cleanup: string[] = []
beforeEach(async () => {
	// AGENTS.md: every test runs with a temporary UIUX_HOME.
	vi.stubEnv('UIUX_HOME', join(await tempDir('uiux-recorder-env-home-'), 'home'))
})
afterEach(async () => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	cleanup.push(path)
	return path
}

function spec(intent: string): ViewSpecContent {
	return { intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
}

type ManualClock = HistoryRecorderClock & Readonly<{ advance(milliseconds: number): void; set(milliseconds: number): void; pending(): number }>

/** A clock whose timers fire only when the test advances it. */
function manualClock(start = START): ManualClock {
	let now = start
	let nextId = 1
	const timers = new Map<number, { due: number; callback: () => void }>()
	return {
		now: () => now,
		setTimeout(callback, milliseconds) {
			const id = nextId++
			timers.set(id, { due: now + milliseconds, callback })
			return id
		},
		clearTimeout(handle) { timers.delete(handle as number) },
		advance(milliseconds) {
			const target = now + milliseconds
			for (;;) {
				const due = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((left, right) => left[1].due - right[1].due)[0]
				if (!due) break
				timers.delete(due[0])
				now = Math.max(now, due[1].due)
				due[1].callback()
			}
			now = target
		},
		set(milliseconds) { now = milliseconds },
		pending: () => timers.size,
	}
}

type Fixture = Readonly<{
	root: string
	home: string
	persistence: FileNativePersistence
	app: WorkspaceApplicationSession
	host: HostHistoryStore
	checkpoints: CheckpointStore
	clock: ManualClock
	recorder: HistoryRecorder
	logs: string[]
	viewRevision: () => Promise<string>
	versions: () => Promise<readonly VersionRecord[]>
	hostVersions: () => Promise<readonly HostVersionRecord[]>
}>

async function fixture(options: Readonly<{ clock?: ManualClock; observerTimeoutMilliseconds?: number; seed?: boolean; fault?: PersistenceFaultHook }> = {}): Promise<Fixture> {
	const root = await tempDir('uiux-recorder-ws-')
	const home = join(await tempDir('uiux-recorder-home-'), 'home')
	const persistence = new FileNativePersistence({
		root,
		schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
		...(options.observerTimeoutMilliseconds ? { observerTimeoutMilliseconds: options.observerTimeoutMilliseconds } : {}),
		...(options.fault ? { fault: options.fault } : {}),
	})
	const app = createWorkspaceApplicationSession(persistence)
	if (options.seed !== false) {
		await persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
		const created = await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })
		expect(created.status).toBe('created')
	}
	const host = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, root), create: true }))!
	const checkpoints = new CheckpointStore(persistence)
	const clock = options.clock ?? manualClock()
	const logs: string[] = []
	const recorder = createHistoryRecorder({ persistence, stores: async () => ({ host, checkpoints }), clock, log: line => logs.push(line) })
	return {
		root,
		home,
		persistence,
		app,
		host,
		checkpoints,
		clock,
		recorder,
		logs,
		viewRevision: async () => (await persistence.views.readRevision(VIEW_ID))!,
		versions: async () => (await readMergedTimeline(persistence, { host, checkpoints })).versions.map(entry => entry.version),
		hostVersions: async () => (await host.listVersions()).records,
	}
}

async function editView(ctx: Fixture, principal: MemberPrincipal, intent: string, transport: 'http' | 'mcp' = principal.kind === 'agent' ? 'mcp' : 'http'): Promise<string> {
	const result = await scoped(ctx.app, principal, { transport, history: ctx.recorder }).updateViewSpec({ key: VIEW_ID, expectedRevision: await ctx.viewRevision(), spec: spec(intent) })
	expect(result).toMatchObject({ status: 'updated' })
	return (result as { revision: string }).revision
}

/** A change made outside UIUX: a text editor rewrites the View file. */
async function externalViewEdit(ctx: Fixture, name: string): Promise<string> {
	const path = join(ctx.root, viewRelativePath(VIEW_ID))
	const view = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
	await writeFile(path, `${JSON.stringify({ ...view, name }, null, '\t')}\n`)
	return ctx.viewRevision()
}

function revisionOf(version: VersionRecord, kind: string, key: string): string | undefined {
	return version.resources.find(resource => resource.kind === kind && resource.key === key)?.revision
}

const actorOf = (principal: MemberPrincipal) => ({ type: principal.kind, id: `member:${principal.memberId}`, displayName: principal.nickname })

describe('history recorder start', () => {
	it('writes the Baseline Checkpoint once per host, as system:baseline with source cli, then records nothing on a clean restart', async () => {
		const ctx = await fixture()
		const started = await ctx.recorder.start()
		expect(started.enabled).toBe(true)
		expect(started.baseline).toBeDefined()
		const [baseline, ...rest] = await ctx.versions()
		expect(rest).toEqual([])
		expect(baseline).toMatchObject({ id: started.baseline, type: 'checkpoint', name: 'Baseline', actor: { type: 'system', id: 'system:baseline' }, source: 'cli', workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION })
		expect(baseline).not.toHaveProperty('parentCheckpoint')
		expect(revisionOf(baseline!, 'view', VIEW_ID)).toBe(await ctx.viewRevision())
		// The checkpoint is inside the Workspace and its blobs are in the artifact store.
		expect((await readdir(join(ctx.root, '.uiux/history/checkpoints')))).toEqual([`${started.baseline}.json`])
		await ctx.recorder.stop()

		// Same host, next start: no second Baseline, no external version.
		const again = createHistoryRecorder({ persistence: ctx.persistence, stores: async () => ({ host: ctx.host, checkpoints: ctx.checkpoints }), clock: ctx.clock })
		const restarted = await again.start()
		expect(restarted.baseline).toBeUndefined()
		expect(restarted.boundary).toEqual({ reason: 'start' })
		expect(await ctx.versions()).toHaveLength(1)
		await again.stop()

		// Another host (a new git worktree of the same files): its own Baseline, after the committed one.
		const otherHome = join(await tempDir('uiux-recorder-home-'), 'home')
		const otherHost = (await HostHistoryStore.open({ paths: hostHistoryPaths(otherHome, ctx.root), create: true }))!
		const worktree = createHistoryRecorder({ persistence: ctx.persistence, stores: async () => ({ host: otherHost, checkpoints: ctx.checkpoints }), clock: ctx.clock })
		const second = await worktree.start()
		expect(second.baseline).toBeDefined()
		const checkpoints = (await ctx.checkpoints.list()).records
		expect(checkpoints.map(checkpoint => checkpoint.id)).toEqual([started.baseline, second.baseline])
		expect(checkpoints[1]).toMatchObject({ parentCheckpoint: started.baseline })
		await worktree.stop()
	})

	it('records a change made while no server ran as an external version at start (Scenario 01a11a5e-91d5)', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		await ctx.recorder.stop()
		const edited = await externalViewEdit(ctx, 'Edited in a text editor')

		const next = createHistoryRecorder({ persistence: ctx.persistence, stores: async () => ({ host: ctx.host, checkpoints: ctx.checkpoints }), clock: ctx.clock })
		const report = await next.start()
		expect(report.boundary?.external).toBeDefined()
		const versions = await ctx.versions()
		expect(versions.map(version => version.type)).toEqual(['checkpoint', 'external'])
		const external = versions[1] as HostVersionRecord
		expect(external.actor).toEqual({ type: 'external' })
		expect(external).toMatchObject({ netChange: true, events: [] })
		expect(external).not.toHaveProperty('recordingGap')
		expect(revisionOf(external, 'view', VIEW_ID)).toBe(edited)
		// The external version's blobs are on the host.
		for (const digest of Object.values(external.resources.find(resource => resource.kind === 'view')!.files))
			expect(await ctx.host.hasBlob(digest)).toBe(true)
		await next.stop()
	})

	it('closes a leftover autosave at start, and surfaces a write whose event a crash lost as an external version', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		const first = await editView(ctx, AGENT, 'agent step 1')
		const openId = ctx.recorder.openAutosaveId
		expect(openId).toBeDefined()
		// Crash window: the write commits but the process dies before the after hook records it.
		ctx.persistence.setWriteObserver(undefined)
		const lost = await editView(ctx, AGENT, 'agent step 2, never recorded')
		expect(lost).not.toBe(first)

		const restarted = createHistoryRecorder({ persistence: ctx.persistence, stores: async () => ({ host: ctx.host, checkpoints: ctx.checkpoints }), clock: ctx.clock })
		const report = await restarted.start()
		expect(report.boundary).toMatchObject({ reason: 'leftover', autosave: openId })
		expect(await ctx.host.readOpenJournal()).toBeUndefined()
		const versions = await ctx.versions()
		expect(versions.map(version => version.type)).toEqual(['checkpoint', 'autosave', 'external'])
		const autosave = versions[1] as HostVersionRecord
		expect(autosave).toMatchObject({ id: openId, actor: actorOf(AGENT), netChange: true })
		expect(autosave.events.map(event => event.afterRevision)).toEqual([first])
		expect(revisionOf(autosave, 'view', VIEW_ID)).toBe(first)
		expect(revisionOf(versions[2]!, 'view', VIEW_ID)).toBe(lost)
		expect(versions[2]!.actor).toEqual({ type: 'external' })
		await restarted.stop()
	})

	it('quarantines a corrupt open.json, records its changes as a recording gap, and then records cleanly', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		await editView(ctx, AGENT, 'agent step 1')
		ctx.persistence.setWriteObserver(undefined)
		const journal = await readFile(ctx.host.paths.open, 'utf8')
		// A complete middle line that is not JSON: parseOpenJournal refuses it.
		await writeFile(ctx.host.paths.open, journal.replace('\n', '\n{not json\n'), { mode: 0o600 })

		const restarted = createHistoryRecorder({ persistence: ctx.persistence, stores: async () => ({ host: ctx.host, checkpoints: ctx.checkpoints }), clock: ctx.clock, log: () => undefined })
		const report = await restarted.start()
		expect(report.enabled).toBe(true)
		expect(report.quarantined).toMatch(/^open\.json\.corrupt-2026-10-09T00-00-00-\d{3}Z$/u)
		expect((await lstat(join(ctx.host.paths.dir, report.quarantined!))).isFile()).toBe(true)
		await expect(lstat(ctx.host.paths.open)).rejects.toMatchObject({ code: 'ENOENT' })
		const versions = await ctx.versions()
		expect(versions.map(version => version.type)).toEqual(['checkpoint', 'external'])
		expect(versions[1]).toMatchObject({ recordingGap: true, actor: { type: 'external' } })
		expect(revisionOf(versions[1]!, 'view', VIEW_ID)).toBe(await ctx.viewRevision())

		await editView(ctx, AGENT, 'agent step 2')
		await restarted.closeOpenAutosave('checkpoint')
		expect((await ctx.versions()).map(version => version.type)).toEqual(['checkpoint', 'external', 'autosave'])
		await restarted.stop()
	})

	it('prunes at start and once a day', async () => {
		const ctx = await fixture()
		const old = START - HOST_RETENTION_MAX_AGE_MS - 1
		const ids: string[] = []
		for (let index = 0; index < HOST_RETENTION_MIN_KEPT + 2; index++) {
			const id = randomUUID()
			ids.push(id)
			await ctx.host.writeVersion({ historySchemaVersion: 1, id, type: 'external', actor: { type: 'external' }, at: new Date(old + index).toISOString(), workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, resources: [], startedAt: new Date(old + index).toISOString(), netChange: true, events: [] })
		}
		const report = await ctx.recorder.start()
		expect(report.pruned?.pruned).toEqual(ids.slice(0, 2).sort())
		const prune = vi.spyOn(ctx.recorder, 'prune')
		ctx.clock.advance(HOST_PRUNE_INTERVAL_MS)
		expect(prune).toHaveBeenCalledTimes(1)
		await vi.waitFor(() => expect(ctx.clock.pending()).toBe(1))
		await ctx.recorder.stop()
		expect(ctx.clock.pending()).toBe(0)
	}, 30_000)
})

describe('autosave boundaries', () => {
	it('groups one actor\'s writes into one autosave and closes it after 2 minutes idle', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		const before = await ctx.viewRevision()
		const first = await editView(ctx, HUMAN, 'step 1')
		ctx.clock.advance(AUTOSAVE_IDLE_MS - 1)
		const second = await editView(ctx, HUMAN, 'step 2')
		ctx.clock.advance(AUTOSAVE_IDLE_MS - 1)
		expect(await ctx.hostVersions()).toEqual([])
		ctx.clock.advance(1)
		// The timer close writes the version, then clears open.json.
		await vi.waitFor(async () => expect([(await ctx.hostVersions()).length, await ctx.host.readOpenJournal()]).toEqual([1, undefined]))
		const [autosave] = await ctx.hostVersions()
		expect(autosave).toMatchObject({ type: 'autosave', actor: actorOf(HUMAN), netChange: true, startedAt: new Date(START).toISOString() })
		expect(autosave).not.toHaveProperty('recordingGap')
		expect(autosave!.events).toEqual([
			{ at: new Date(START).toISOString(), actor: actorOf(HUMAN), source: 'workbench', operation: 'updateViewSpec', resource: { kind: 'view', key: VIEW_ID }, beforeRevision: before, afterRevision: first },
			{ at: new Date(START + AUTOSAVE_IDLE_MS - 1).toISOString(), actor: actorOf(HUMAN), source: 'workbench', operation: 'updateViewSpec', resource: { kind: 'view', key: VIEW_ID }, beforeRevision: first, afterRevision: second },
		])
		expect(revisionOf(autosave!, 'view', VIEW_ID)).toBe(second)
		// Every event's committed bytes are stored by digest on the host.
		for (const digest of Object.values(autosave!.resources.find(resource => resource.kind === 'view')!.files))
			expect(await ctx.host.hasBlob(digest)).toBe(true)
		expect(await ctx.host.readOpenJournal()).toBeUndefined()
		await ctx.recorder.stop()
	})

	it('closes on idle in the next write when the timer has not fired yet', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		await editView(ctx, HUMAN, 'step 1')
		ctx.clock.set(START + AUTOSAVE_IDLE_MS)
		await editView(ctx, HUMAN, 'step 2')
		expect((await ctx.hostVersions()).map(version => version.events.length)).toEqual([1])
		await ctx.recorder.stop()
		expect((await ctx.hostVersions()).map(version => version.events.length)).toEqual([1, 1])
	})

	it('closes once the autosave spans 30 minutes even while writes keep coming', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		// One write every 100 s, always within the idle period of the previous one.
		const interval = 100_000
		let writes = 0
		for (let elapsed = 0; elapsed < AUTOSAVE_MAX_SPAN_MS; elapsed += interval) {
			ctx.clock.set(START + elapsed)
			await editView(ctx, HUMAN, `at ${elapsed}`)
			writes++
		}
		expect(await ctx.hostVersions()).toEqual([])
		ctx.clock.advance(START + AUTOSAVE_MAX_SPAN_MS - ctx.clock.now())
		await vi.waitFor(async () => expect([(await ctx.hostVersions()).length, await ctx.host.readOpenJournal()]).toEqual([1, undefined]))
		const [autosave] = await ctx.hostVersions()
		expect(autosave!.events).toHaveLength(writes)
		expect(Date.parse(autosave!.at) - Date.parse(autosave!.startedAt)).toBe(AUTOSAVE_MAX_SPAN_MS)
		await ctx.recorder.stop()
	}, 30_000)

	it('closes once the autosave holds 200 events', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		// 199 events reach the recorder directly (each a committed no-op write of the View's own
		// bytes), then a real write is the 200th: the cap closes the autosave right after it.
		const path = viewRelativePath(VIEW_ID)
		const bytes = Uint8Array.from(await readFile(join(ctx.root, path)))
		const revision = await ctx.viewRevision()
		const context: DesignWriteContext = { actor: actorOf(HUMAN), source: 'workbench', operation: 'updateViewSpec' }
		const change = { resource: { kind: 'view', key: VIEW_ID }, beforeRevision: revision, afterRevision: revision, files: [{ path, bytes }] }
		for (let index = 0; index < AUTOSAVE_MAX_EVENTS - 1; index++) await ctx.recorder.observer.afterCanonicalCommit!(context, [change], new AbortController().signal)
		expect(ctx.recorder.openAutosaveId).toBeDefined()
		await editView(ctx, HUMAN, 'the 200th event')
		expect(ctx.recorder.openAutosaveId).toBeUndefined()
		expect((await ctx.hostVersions()).map(version => version.events.length)).toEqual([AUTOSAVE_MAX_EVENTS])
		await editView(ctx, HUMAN, 'one more')
		expect(ctx.recorder.openAutosaveId).toBeDefined()
		await ctx.recorder.stop()
		expect((await ctx.hostVersions()).map(version => version.events.length)).toEqual([AUTOSAVE_MAX_EVENTS, 1])
	}, 30_000)

	it('closes on an actor change and records an out-of-band edit between the writes as external, not as either actor\'s change', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		const agentRevision = await editView(ctx, AGENT, 'agent')
		// Out of band: a new Locale file appears.
		await mkdir(join(ctx.root, 'i18n'), { recursive: true })
		await writeFile(join(ctx.root, localeRelativePath('fr-FR')), '{"hello":"bonjour"}\n')
		const humanRevision = await editView(ctx, HUMAN, 'human')
		await ctx.recorder.stop()

		const versions = await ctx.hostVersions()
		expect(versions.map(version => [version.type, version.actor.type])).toEqual([['autosave', 'agent'], ['external', 'external'], ['autosave', 'human']])
		const [agentSave, external, humanSave] = versions
		expect(agentSave!.events.map(event => event.afterRevision)).toEqual([agentRevision])
		expect(revisionOf(agentSave!, 'locale', 'fr-FR')).toBeUndefined()
		expect(revisionOf(external!, 'locale', 'fr-FR')).toBeDefined()
		expect(revisionOf(external!, 'view', VIEW_ID)).toBe(agentRevision)
		expect(humanSave!.events).toHaveLength(1)
		expect(humanSave!.events[0]).toMatchObject({ actor: actorOf(HUMAN), source: 'workbench', beforeRevision: agentRevision, afterRevision: humanRevision })
		expect(revisionOf(humanSave!, 'locale', 'fr-FR')).toBe(revisionOf(external!, 'locale', 'fr-FR'))
		// Host parents chain the host records; Date order follows recording order.
		expect(external!.parent).toBe(agentSave!.id)
		expect(humanSave!.parent).toBe(external!.id)
		expect(Date.parse(agentSave!.at)).toBeLessThan(Date.parse(external!.at))
	})

	it('records an outside edit of the resource an actor is writing as external before that actor\'s next write', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		await editView(ctx, AGENT, 'agent step 1')
		const edited = await externalViewEdit(ctx, 'Renamed outside')
		const after = await editView(ctx, AGENT, 'agent step 2')
		await ctx.recorder.stop()
		const versions = await ctx.hostVersions()
		expect(versions.map(version => version.type)).toEqual(['autosave', 'external', 'autosave'])
		expect(revisionOf(versions[1]!, 'view', VIEW_ID)).toBe(edited)
		expect(versions[2]!.events[0]).toMatchObject({ beforeRevision: edited, afterRevision: after })
	})

	it('records an autosave whose writes cancel out, marked as having no net change', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		const view = (await ctx.persistence.views.read(VIEW_ID))!
		await editView(ctx, HUMAN, 'temporary')
		const restored = await scoped(ctx.app, HUMAN, { history: ctx.recorder }).updateViewSpec({ key: VIEW_ID, expectedRevision: await ctx.viewRevision(), spec: view.resource.spec as ViewSpecContent })
		expect(restored).toMatchObject({ status: 'updated', revision: view.revision })
		await ctx.recorder.stop()
		expect(await ctx.hostVersions()).toMatchObject([{ type: 'autosave', netChange: false }])
		expect((await ctx.hostVersions())[0]!.events).toHaveLength(2)
	})

	it('closes before and after a restore, so the restore stands alone with restoredFrom', async () => {
		const ctx = await fixture()
		const started = await ctx.recorder.start()
		await editView(ctx, AGENT, 'agent')
		const view = (await ctx.persistence.views.read(VIEW_ID))!
		const context: DesignWriteContext = { actor: actorOf(AGENT), source: 'mcp', operation: 'restoreResourceVersion', restoredFrom: started.baseline! }
		await runWithDesignWriteContext(context, () => ctx.persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: view.revision, resource: { ...view.resource, name: 'Restored' } }))
		expect(ctx.recorder.openAutosaveId).toBeUndefined()
		const versions = await ctx.hostVersions()
		expect(versions.map(version => [version.events.length, version.restoredFrom])).toEqual([[1, undefined], [1, started.baseline]])
		expect(versions[1]!.events[0]!.operation).toBe('restoreResourceVersion')
		await ctx.recorder.stop()
	})

	it('closes an Agent\'s autosave on release_lock with no arguments only, and only for that Agent', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		await editView(ctx, AGENT, 'agent')
		const session = scoped(ctx.app, AGENT, { transport: 'mcp', history: ctx.recorder })
		await session.releaseLeases({ resources: [{ kind: 'view', key: VIEW_ID }] })
		await scoped(ctx.app, OTHER_AGENT, { transport: 'mcp', history: ctx.recorder }).releaseLeases({})
		expect(ctx.recorder.openAutosaveId).toBeDefined()
		expect(await session.releaseLeases({})).toMatchObject({ status: 'released' })
		expect(ctx.recorder.openAutosaveId).toBeUndefined()
		expect((await ctx.hostVersions()).map(version => version.actor)).toEqual([actorOf(AGENT)])
		// Rule 01a11a5e-0ac6: release closes the autosave only; no Checkpoint is created.
		expect((await ctx.checkpoints.list()).records).toHaveLength(1)
		await ctx.recorder.stop()
	})

	it('closes the open autosave at shutdown and for a Checkpoint start', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		await editView(ctx, HUMAN, 'one')
		expect(await ctx.recorder.closeOpenAutosave('checkpoint')).toMatchObject({ reason: 'checkpoint', autosave: expect.any(String) })
		await editView(ctx, HUMAN, 'two')
		await ctx.recorder.stop()
		expect((await ctx.hostVersions()).map(version => version.type)).toEqual(['autosave', 'autosave'])
		expect(await ctx.host.readOpenJournal()).toBeUndefined()
		// Stopped: later writes are not recorded until the next start notices them.
		await editView(ctx, HUMAN, 'three')
		expect(await ctx.hostVersions()).toHaveLength(2)
	})
})

describe('what is recorded', () => {
	it('records no Review activity, and a Decision promotion as one View event', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		const session = scoped(ctx.app, HUMAN, { history: ctx.recorder })
		const created = await session.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		expect(created.status).toBe('created')
		const appended = await session.appendReviewMessage({ reviewId: REVIEW_ID, expectedRevision: (created as { revision: string }).revision, body: 'Looks off.' })
		expect(appended.status).toBe('updated')
		expect(ctx.recorder.openAutosaveId).toBeUndefined()

		const viewBefore = await ctx.viewRevision()
		const promoted = await session.promoteReviewToDecision({ reviewId: REVIEW_ID, expectedReviewRevision: (appended as { revision: string }).revision, viewId: VIEW_ID, expectedViewRevision: viewBefore, question: 'Keep it?' })
		expect(promoted.status).toBe('updated')
		await ctx.recorder.stop()
		const [autosave, ...rest] = await ctx.hostVersions()
		expect(rest).toEqual([])
		expect(autosave!.events).toEqual([expect.objectContaining({ operation: 'promoteReviewToDecision', resource: { kind: 'view', key: VIEW_ID }, beforeRevision: viewBefore, afterRevision: await ctx.viewRevision() })])
		expect(autosave!.resources.some(resource => resource.kind === 'review' || Object.keys(resource.files).some(path => path.startsWith('reviews/')))).toBe(false)
	})

	it('stamps the server-side actor and the transport source; a bearer-Token write over /api/* is workbench', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		await editView(ctx, AGENT, 'agent over http', 'http')
		await ctx.recorder.closeOpenAutosave('checkpoint')
		await editView(ctx, AGENT, 'agent over mcp', 'mcp')
		await ctx.recorder.stop()
		expect((await ctx.hostVersions()).map(version => version.events.map(event => [event.source, event.actor]))).toEqual([
			[['workbench', actorOf(AGENT)]],
			[['mcp', actorOf(AGENT)]],
		])
	})
})

describe('recording failures', () => {
	it('never fails the write and records the missed change at the next boundary as a recording gap', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const first = await editView(ctx, HUMAN, 'recorded')
		vi.spyOn(ctx.host, 'putBlob').mockRejectedValueOnce(new Error('disk full'))
		const missed = await editView(ctx, HUMAN, 'missed')
		expect(ctx.persistence.recordingGap).toBe(true)
		expect(error).toHaveBeenCalledWith(expect.stringContaining('disk full'))
		const next = await editView(ctx, HUMAN, 'after the failure')
		await ctx.recorder.stop()

		const versions = await ctx.hostVersions()
		expect(versions.map(version => version.type)).toEqual(['autosave', 'external', 'autosave'])
		expect(versions[0]!.events.map(event => event.afterRevision)).toEqual([first])
		expect(versions[0]).not.toHaveProperty('recordingGap')
		expect(versions[1]).toMatchObject({ recordingGap: true, actor: { type: 'external' } })
		expect(revisionOf(versions[1]!, 'view', VIEW_ID)).toBe(missed)
		expect(versions[2]!.events[0]).toMatchObject({ beforeRevision: missed, afterRevision: next })
		expect(ctx.persistence.recordingGap).toBe(false)
	})

	it('tolerates a before hook with no following write (review finding L3)', async () => {
		let failApply = false
		const ctx = await fixture({ fault: (point) => {
			if (failApply && point === 'transaction.after_apply') throw new Error('injected mid-transaction')
		} })
		await ctx.recorder.start()
		const agentRevision = await editView(ctx, AGENT, 'agent')
		// The human's Asset transaction fails after its before hook closed the agent's autosave.
		failApply = true
		const asset = randomUUID()
		await expect(runWithDesignWriteContext({ actor: actorOf(HUMAN), source: 'workbench', operation: 'createAsset' }, () => ctx.persistence.assets.create(asset, { metadata: { id: asset, name: 'Logo', contentFilename: 'logo.bin', mediaType: 'application/octet-stream' }, content: Buffer.from('x') }))).rejects.toBeDefined()
		failApply = false
		expect(await ctx.persistence.assets.readRevision(asset)).toBeUndefined()
		expect(ctx.recorder.openAutosaveId).toBeUndefined()
		expect(await ctx.host.readOpenJournal()).toBeUndefined()
		expect((await ctx.hostVersions()).map(version => [version.type, version.actor.type])).toEqual([['autosave', 'agent']])
		expect(revisionOf((await ctx.hostVersions())[0]!, 'view', VIEW_ID)).toBe(agentRevision)

		const humanRevision = await editView(ctx, HUMAN, 'human')
		await ctx.recorder.stop()
		const versions = await ctx.hostVersions()
		expect(versions.map(version => [version.type, version.actor.type])).toEqual([['autosave', 'agent'], ['autosave', 'human']])
		expect(versions[1]!.events.map(event => event.afterRevision)).toEqual([humanRevision])
	})

	it('attributes a write whose resources could not be read first to the next boundary, not the previous one (review finding L3)', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const agentRevision = await editView(ctx, AGENT, 'agent')
		const original = ctx.persistence.readOptionalBytesUnlocked.bind(ctx.persistence)
		vi.spyOn(ctx.persistence, 'readOptionalBytesUnlocked').mockImplementation(async (relativePath: string) => {
			// Only the funnel's read of the resource before the write fails; the write's own reads work.
			if (new Error('probe').stack?.includes('readVersionedResourceFilesUnlocked')) throw new Error('transient read failure')
			return original(relativePath)
		})
		const humanRevision = await editView(ctx, HUMAN, 'human, unrecorded')
		vi.mocked(ctx.persistence.readOptionalBytesUnlocked).mockRestore()
		// No hook ran for the human's write: the agent's autosave is still open and the gap is pending.
		expect(ctx.recorder.openAutosaveId).toBeDefined()
		expect(ctx.persistence.recordingGap).toBe(true)

		await ctx.recorder.closeOpenAutosave('checkpoint')
		const versions = await ctx.hostVersions()
		expect(versions.map(version => version.type)).toEqual(['autosave', 'external'])
		expect(versions[0]!.events.map(event => event.afterRevision)).toEqual([agentRevision])
		expect(revisionOf(versions[0]!, 'view', VIEW_ID)).toBe(agentRevision)
		expect(versions[1]).toMatchObject({ recordingGap: true })
		expect(revisionOf(versions[1]!, 'view', VIEW_ID)).toBe(humanRevision)
		await ctx.recorder.stop()
	})

	it('abandons a hook that outlives the observer timeout, keeps writing, and records the skipped writes once it settles (review finding L4)', async () => {
		const ctx = await fixture({ observerTimeoutMilliseconds: 100 })
		await ctx.recorder.start()
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const agentRevision = await editView(ctx, AGENT, 'agent')
		let release!: () => void
		const stalled = new Promise<void>(resolve => { release = resolve })
		const writeVersion = ctx.host.writeVersion.bind(ctx.host)
		vi.spyOn(ctx.host, 'writeVersion').mockImplementationOnce(async (record) => {
			await stalled
			return writeVersion(record)
		})
		const began = Date.now()
		// The actor change makes the before hook close the agent's autosave, which stalls on the host.
		const humanRevision = await editView(ctx, HUMAN, 'human while the store stalls')
		expect(Date.now() - began).toBeLessThan(3_000)
		expect(ctx.persistence.recordingGap).toBe(true)
		// While the abandoned close still runs, new hooks are refused (fast) instead of racing it.
		const busyRevision = await editView(ctx, HUMAN, 'human again')
		expect(Date.now() - began).toBeLessThan(3_000)

		// Once the store recovers, the abandoned close writes the agent's autosave but, no longer
		// holding the lock, neither rescans nor consumes the gap: it journals the gap instead.
		const scan = vi.spyOn(ctx.persistence, 'scanVersionedSnapshotUnlocked')
		release()
		await vi.waitFor(async () => {
			expect(await ctx.hostVersions()).toHaveLength(1)
			expect((await ctx.host.readOpenJournal())?.entries.map(entry => entry.type)).toContain('gap')
		})
		expect(scan).not.toHaveBeenCalled()
		// The next boundary under the lock records both skipped writes as one external version.
		expect(await vi.waitFor(() => ctx.recorder.closeOpenAutosave('checkpoint'))).toMatchObject({ reason: 'checkpoint', external: expect.any(String) })
		expect(scan).toHaveBeenCalledTimes(1)
		expect(await ctx.host.readOpenJournal()).toBeUndefined()
		const versions = await ctx.hostVersions()
		expect(versions.map(version => version.type)).toEqual(['autosave', 'external'])
		expect(revisionOf(versions[0]!, 'view', VIEW_ID)).toBe(agentRevision)
		expect(versions[1]).toMatchObject({ recordingGap: true })
		expect(revisionOf(versions[1]!, 'view', VIEW_ID)).toBe(busyRevision)
		expect(humanRevision).not.toBe(busyRevision)
		await ctx.recorder.stop()
	})

	it('refuses a hook as busy without waiting for an abandoned boundary stuck in open.json (re-verification of 6c2c313)', async () => {
		const ctx = await fixture({ observerTimeoutMilliseconds: 1_000 })
		await ctx.recorder.start()
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		await editView(ctx, AGENT, 'agent')
		let release!: () => void
		const stalled = new Promise<void>(resolve => { release = resolve })
		const clear = ctx.host.clearOpenJournal.bind(ctx.host)
		vi.spyOn(ctx.host, 'clearOpenJournal').mockImplementationOnce(async () => {
			await stalled
			return clear()
		})
		// The actor change closes the agent's autosave; the boundary's journal clear stalls past the timeout.
		await editView(ctx, HUMAN, 'abandoned boundary')
		// The recorder is busy with the abandoned work, which holds the journal queue.
		const durations: number[] = []
		for (const intent of ['busy 1', 'busy 2']) {
			const began = Date.now()
			await editView(ctx, HUMAN, intent)
			durations.push(Date.now() - began)
		}
		expect(Math.max(...durations)).toBeLessThan(500)
		release()
		await vi.waitFor(async () => expect((await ctx.host.readOpenJournal())?.entries.filter(entry => entry.type === 'gap').length).toBeGreaterThanOrEqual(3))
		expect(await vi.waitFor(() => ctx.recorder.closeOpenAutosave('checkpoint'))).toMatchObject({ external: expect.any(String) })
		expect((await ctx.hostVersions()).map(version => [version.type, version.recordingGap])).toEqual([['autosave', undefined], ['external', true]])
		await ctx.recorder.stop()
	})

	it('discards a rescan that outlives the observer timeout and leaves the gap to the next locked boundary (owner ruling 3, verification of 67b5f11)', async () => {
		const ctx = await fixture({ observerTimeoutMilliseconds: 100 })
		await ctx.recorder.start()
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		await editView(ctx, AGENT, 'agent')
		let release!: () => void
		const stalled = new Promise<void>(resolve => { release = resolve })
		const scan = ctx.persistence.scanVersionedSnapshotUnlocked.bind(ctx.persistence)
		vi.spyOn(ctx.persistence, 'scanVersionedSnapshotUnlocked').mockImplementationOnce(async () => {
			await stalled
			// By now W1 has committed and the lock is free: this read is not under the lock.
			return scan()
		})
		// W1: the actor change closes the agent's autosave, then the rescan stalls and is abandoned.
		const w1 = await editView(ctx, HUMAN, 'W1')
		expect(ctx.persistence.recordingGap).toBe(true)
		release()
		await vi.waitFor(async () => expect((await ctx.host.readOpenJournal())?.entries.map(entry => entry.type)).toContain('gap'))
		// The abandoned work wrote nothing from its unlocked scan.
		expect((await ctx.hostVersions()).map(version => version.type)).toEqual(['autosave'])

		expect(await vi.waitFor(() => ctx.recorder.closeOpenAutosave('checkpoint'))).toMatchObject({ external: expect.any(String) })
		const versions = await ctx.hostVersions()
		expect(versions.map(version => [version.type, version.recordingGap])).toEqual([['autosave', undefined], ['external', true]])
		expect(revisionOf(versions[1]!, 'view', VIEW_ID)).toBe(w1)
		expect(ctx.persistence.recordingGap).toBe(false)
		await ctx.recorder.stop()
	})

	it('never rescans outside the lock when an abandoned boundary finishes during a slow write (owner ruling 3, review M1)', async () => {
		let slowWrite: (() => Promise<void>) | undefined
		const ctx = await fixture({
			observerTimeoutMilliseconds: 100,
			fault: async (point, details) => {
				if (point === 'file.before_rename' && details.path === viewRelativePath(VIEW_ID) && slowWrite) await slowWrite()
			},
		})
		await ctx.recorder.start()
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		await editView(ctx, AGENT, 'agent')
		let release!: () => void
		const stalled = new Promise<void>(resolve => { release = resolve })
		const writeVersion = ctx.host.writeVersion.bind(ctx.host)
		vi.spyOn(ctx.host, 'writeVersion').mockImplementationOnce(async (record) => {
			await stalled
			return writeVersion(record)
		})
		const scan = vi.spyOn(ctx.persistence, 'scanVersionedSnapshotUnlocked')
		let scansDuringW1 = -1
		// W1, the human's write, is slow: the store recovers while W1's bytes are not on disk yet, so
		// a rescan by the abandoned close would see the Workspace mid-write without the lock.
		slowWrite = async () => {
			slowWrite = undefined
			const before = scan.mock.calls.length
			release()
			await new Promise(resolve => setTimeout(resolve, 300))
			scansDuringW1 = scan.mock.calls.length - before
		}
		const w1 = await editView(ctx, HUMAN, 'W1')
		expect(scansDuringW1).toBe(0)
		expect(ctx.persistence.recordingGap).toBe(true)
		await vi.waitFor(async () => expect((await ctx.host.readOpenJournal())?.entries.map(entry => entry.type)).toContain('gap'))
		expect(scan).not.toHaveBeenCalled()

		expect(await vi.waitFor(() => ctx.recorder.closeOpenAutosave('checkpoint'))).toMatchObject({ external: expect.any(String) })
		const versions = await ctx.hostVersions()
		expect(versions.map(version => [version.type, version.actor.type, version.recordingGap])).toEqual([['autosave', 'agent', undefined], ['external', 'external', true]])
		expect(revisionOf(versions[1]!, 'view', VIEW_ID)).toBe(w1)
		await ctx.recorder.stop()
	})

	it('bounds a persistence observer hook in time and skips the after hook of a write whose before hook failed', async () => {
		const ctx = await fixture({ observerTimeoutMilliseconds: 50 })
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const after = vi.fn()
		ctx.persistence.setWriteObserver({ beforeCanonicalWrite: () => new Promise(() => undefined), afterCanonicalCommit: after })
		const began = Date.now()
		const result = await runWithDesignWriteContext({ actor: actorOf(HUMAN), source: 'workbench', operation: 'updateViewSpec' }, async () => ctx.persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: await ctx.viewRevision(), resource: { ...(await ctx.persistence.views.read(VIEW_ID))!.resource, name: 'Written anyway' } }))
		expect(result.ok).toBe(true)
		expect(Date.now() - began).toBeLessThan(2_000)
		expect(after).not.toHaveBeenCalled()
		expect(ctx.persistence.consumeRecordingGap()).toBe(true)
	})
})

describe('review follow-ups on PR #156', () => {
	const restart = (ctx: Fixture) => createHistoryRecorder({ persistence: ctx.persistence, stores: async () => ({ host: ctx.host, checkpoints: ctx.checkpoints }), clock: ctx.clock, log: () => undefined })

	it('writes nothing to the host while migration is required, then creates the Baseline on the first start after migration (owner ruling 2, review M2)', async () => {
		const ctx = await fixture({ seed: false })
		await mkdir(join(ctx.root, '.uiux'), { recursive: true })
		await writeFile(join(ctx.root, '.uiux/workspace.json'), `${JSON.stringify({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION - 1, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })}\n`)
		// A Checkpoint committed by another worktree is already in the Workspace.
		const other = randomUUID()
		await ctx.persistence.withLock(async () => {
			const snapshot = versionResourcesFromSnapshot(await ctx.persistence.scanVersionedSnapshotUnlocked())
			await ctx.checkpoints.createUnlocked({ historySchemaVersion: 1, id: other, type: 'checkpoint', actor: actorOf(HUMAN), at: new Date(START - 60_000).toISOString(), workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION - 1, resources: snapshot.resources, name: 'From another worktree', source: 'workbench' }, snapshot.blobs)
		})

		expect(await ctx.recorder.start()).toEqual({ enabled: false })
		expect(await ctx.hostVersions()).toEqual([])
		expect(await ctx.host.listBlobDigests()).toEqual([])
		expect(await ctx.host.readOpenJournal()).toBeUndefined()
		expect((await ctx.checkpoints.list()).records.map(checkpoint => checkpoint.id)).toEqual([other])
		await ctx.recorder.stop()

		await ctx.persistence.migrateWorkspace()
		const after = restart(ctx)
		const report = await after.start()
		expect(report).toMatchObject({ enabled: true, baseline: expect.any(String) })
		const checkpoints = (await ctx.checkpoints.list()).records
		expect(checkpoints.map(checkpoint => checkpoint.id)).toEqual([other, report.baseline])
		expect(checkpoints[1]).toMatchObject({ name: 'Baseline', parentCheckpoint: other, workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION })
		await after.stop()
	})

	it('journals a recording gap, so a kill before the next boundary still flags the next start\'s external version (review L1)', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const first = await editView(ctx, HUMAN, 'recorded')
		vi.spyOn(ctx.host, 'putBlob').mockRejectedValueOnce(new Error('disk full'))
		const missed = await editView(ctx, HUMAN, 'missed')
		expect((await ctx.host.readOpenJournal())!.entries.map(entry => entry.type)).toEqual(['begin', 'event', 'gap'])
		// SIGKILL: no shutdown boundary, and the in-memory gap flag is gone with the process.
		ctx.persistence.setWriteObserver(undefined)

		const report = await restart(ctx).start()
		expect(report.boundary).toMatchObject({ reason: 'leftover', autosave: expect.any(String), external: expect.any(String) })
		const versions = await ctx.hostVersions()
		expect(versions.map(version => [version.type, version.recordingGap])).toEqual([['autosave', undefined], ['external', true]])
		expect(revisionOf(versions[0]!, 'view', VIEW_ID)).toBe(first)
		expect(revisionOf(versions[1]!, 'view', VIEW_ID)).toBe(missed)
	})

	it('treats a journal line cut short by a crash as a recording gap (review L1)', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		await editView(ctx, HUMAN, 'recorded')
		ctx.persistence.setWriteObserver(undefined)
		await editView(ctx, HUMAN, 'never journaled')
		await writeFile(ctx.host.paths.open, `${await readFile(ctx.host.paths.open, 'utf8')}{"type":"ga`, { mode: 0o600 })
		await restart(ctx).start()
		expect((await ctx.hostVersions()).map(version => [version.type, version.recordingGap])).toEqual([['autosave', undefined], ['external', true]])
	})

	it('still journals a write already past its before hook when shutdown takes the no-lock path (review L2)', async () => {
		let duringWrite: (() => Promise<void>) | undefined
		const ctx = await fixture({
			fault: async (point, details) => {
				if (point === 'file.before_rename' && details.path === viewRelativePath(VIEW_ID) && duringWrite) await duringWrite()
			},
		})
		await ctx.recorder.start()
		duringWrite = async () => {
			duringWrite = undefined
			await ctx.recorder.stop()
		}
		const revision = await editView(ctx, HUMAN, 'written while stopping')
		expect((await ctx.host.readOpenJournal())!.entries.map(entry => entry.type)).toEqual(['begin', 'event'])

		const report = await restart(ctx).start()
		expect(report.boundary).toMatchObject({ reason: 'leftover', autosave: expect.any(String) })
		expect(report.boundary).not.toHaveProperty('external')
		const versions = await ctx.hostVersions()
		expect(versions.map(version => [version.type, version.actor.type])).toEqual([['autosave', 'human']])
		expect(versions[0]!.events.map(event => event.afterRevision)).toEqual([revision])
	})

	it('discards an open autosave that never journaled an event and writes no version for it (review L3)', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const append = ctx.host.appendOpenEntry.bind(ctx.host)
		let failed = false
		vi.spyOn(ctx.host, 'appendOpenEntry').mockImplementation(async (entry) => {
			if (entry.type === 'event' && !failed) {
				failed = true
				throw new Error('journal append failed')
			}
			return append(entry)
		})
		const revision = await editView(ctx, HUMAN, 'event not journaled')
		expect(ctx.recorder.openAutosaveId).toBeDefined()
		expect(await ctx.recorder.closeOpenAutosave('checkpoint')).toMatchObject({ external: expect.any(String) })
		expect(await ctx.recorder.closeOpenAutosave('checkpoint')).toEqual({ reason: 'checkpoint' })
		const versions = await ctx.hostVersions()
		expect(versions.map(version => [version.type, version.recordingGap])).toEqual([['external', true]])
		expect(revisionOf(versions[0]!, 'view', VIEW_ID)).toBe(revision)
		expect(await ctx.host.readOpenJournal()).toBeUndefined()
		await ctx.recorder.stop()
	})
})

describe('timer isolation (review finding L1)', () => {
	it('arms autosave timers outside the design-write context', async () => {
		const observed: (DesignWriteContext | undefined)[] = []
		const base = manualClock()
		const clock: ManualClock = {
			...base,
			setTimeout(callback, milliseconds) {
				// A real timer captures the async context of the code that creates it.
				setTimeout(() => observed.push(currentDesignWriteContext()), 0)
				return base.setTimeout(callback, milliseconds)
			},
		}
		const ctx = await fixture({ clock })
		await ctx.recorder.start()
		await editView(ctx, HUMAN, 'arms the idle timer')
		await vi.waitFor(() => expect(observed.length).toBeGreaterThanOrEqual(2))
		expect(observed.every(context => context === undefined)).toBe(true)

		// Control: the same probe inside a write context does see it.
		const control: (DesignWriteContext | undefined)[] = []
		await runWithDesignWriteContext({ actor: actorOf(HUMAN), source: 'workbench', operation: 'updateViewSpec' }, async () => {
			setTimeout(() => control.push(currentDesignWriteContext()), 0)
		})
		await vi.waitFor(() => expect(control).toHaveLength(1))
		expect(control[0]).toMatchObject({ operation: 'updateViewSpec' })
		await ctx.recorder.stop()
	})
})

describe('transports', () => {
	it('records one Agent task over /mcp, ended by release_lock, as one autosave (Scenario 01a11a5e-903e)', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		const agent = await connectMcp(ctx.app, AGENT, { history: ctx.recorder })
		try {
			const created = await agent.client.callTool({ name: 'create_view', arguments: { id: OTHER_VIEW_ID, name: 'New', spec: spec('n') } })
			expect(created.isError).not.toBe(true)
			ctx.clock.advance(60_000)
			const first = await agent.client.callTool({ name: 'update_view_spec', arguments: { viewId: VIEW_ID, expectedRevision: await ctx.viewRevision(), spec: spec('agent step 1') } })
			expect(first.isError).not.toBe(true)
			ctx.clock.advance(60_000)
			const second = await agent.client.callTool({ name: 'update_view_spec', arguments: { viewId: VIEW_ID, expectedRevision: await ctx.viewRevision(), spec: spec('agent step 2') } })
			expect(second.isError).not.toBe(true)
			expect(await ctx.hostVersions()).toEqual([])
			const released = await agent.client.callTool({ name: 'release_lock', arguments: {} })
			expect(released.structuredContent).toMatchObject({ status: 'released' })
		}
		finally {
			await agent.close()
		}
		const versions = await ctx.versions()
		expect(versions.map(version => version.type)).toEqual(['checkpoint', 'autosave'])
		const autosave = versions[1] as HostVersionRecord
		expect(autosave.actor).toEqual(actorOf(AGENT))
		expect(autosave.events.map(event => [event.operation, event.resource.key, event.source, event.actor.id])).toEqual([
			['createView', OTHER_VIEW_ID, 'mcp', 'member:agent-1'],
			['updateViewSpec', VIEW_ID, 'mcp', 'member:agent-1'],
			['updateViewSpec', VIEW_ID, 'mcp', 'member:agent-1'],
		])
		expect(revisionOf(autosave, 'view', OTHER_VIEW_ID)).toBe(await ctx.persistence.views.readRevision(OTHER_VIEW_ID))
		expect(ctx.recorder.openAutosaveId).toBeUndefined()
		await ctx.recorder.stop()
	})

	it('records an edit made outside UIUX as an external version before a Checkpoint boundary (Scenario 01a11a5e-91d5)', async () => {
		const ctx = await fixture()
		await ctx.recorder.start()
		const edited = await externalViewEdit(ctx, 'Changed in a text editor')
		const report = await ctx.recorder.closeOpenAutosave('checkpoint')
		expect(report).toMatchObject({ reason: 'checkpoint', external: expect.any(String) })
		const versions = await ctx.versions()
		expect(versions.map(version => version.type)).toEqual(['checkpoint', 'external'])
		expect(versions[1]!.actor).toEqual({ type: 'external' })
		expect(versions[1]!.actor).not.toHaveProperty('id')
		expect(revisionOf(versions[1]!, 'view', VIEW_ID)).toBe(edited)
		await ctx.recorder.stop()
	})

	it('never records for the internal uiux publish server', async () => {
		const base = await tempDir('uiux-recorder-publish-')
		const workspace = join(base, 'ws')
		await mkdir(workspace)
		const home = join(base, 'home')
		const runtime = createSelectedWorkspaceServerRuntime(workspace, { uiuxHome: home, publishCredential: 'internal-publish-credential', serverOrigin: 'http://127.0.0.1:1' })
		await runtime.persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
		expect(await runtime.historyRecorder.start()).toEqual({ enabled: false })
		const created = await scoped(runtime.app, HUMAN, { history: runtime.historyRecorder }).createView({ id: VIEW_ID, name: 'Published', spec: spec('p') })
		expect(created.status).toBe('created')
		await runtime.close()
		await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' })
		await expect(lstat(join(workspace, '.uiux/history'))).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('starts and stops with the selected-Workspace runtime', async () => {
		const base = await tempDir('uiux-recorder-runtime-')
		const workspace = join(base, 'ws')
		await mkdir(workspace)
		const home = join(base, 'home')
		const runtime = createSelectedWorkspaceServerRuntime(workspace, { uiuxHome: home, serverOrigin: 'http://127.0.0.1:1' })
		await runtime.persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
		const report = await runtime.historyRecorder.start()
		expect(report).toMatchObject({ enabled: true, baseline: expect.any(String) })
		const created = await scoped(runtime.app, HUMAN, { history: runtime.historyRecorder }).createView({ id: VIEW_ID, name: 'Recorded', spec: spec('r') })
		expect(created.status).toBe('created')
		expect(runtime.historyRecorder.openAutosaveId).toBeDefined()
		await runtime.close()
		const stores = (await runtime.history.open())!
		expect((await stores.host.listVersions()).records.map(version => version.type)).toEqual(['autosave'])
	})
})
