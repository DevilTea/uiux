import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager } from '../src/application/access/leases'
import { adapterRecordFieldUnlocked, readCurrentAdapterProvenance, type AdapterProvenanceSource } from '../src/application/services/adapter-provenance'
import { createHistoryRecorder, type HistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { ValidatedAdapterEntry, AdapterSetResolutionResult } from '../src/adapters/resolution'
import { adaptersChangedCaveat } from '../src/domain/history/adapter-caveat'
import { ADAPTER_CHANGED_REASON } from '../src/domain/evidence/staleness'
import type { CurrentAdapterProvenance, EvidenceAdapterProvenance } from '../src/domain/evidence/adapter-provenance'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { renderInputDigest } from '../src/domain/evidence/render-input-digest'
import { readWorkspaceProductKitProvenance } from '../src/application/services/product-kit-provenance'
import type { WorkspaceAdapterSelection } from '../src/domain/workspace/schema'
import { canonicalJsonBytes, FileNativePersistence } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createHistoryStoreFactory } from '../src/server/history-stores'
import { scoped, testMember } from './support/access'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * Adapter provenance in version history (issue #300): Rule 01a11a5e-06fb-79c5-8396-d50d08780a6d and
 * Clause 01a11a5e-201a-7532-8192-517b439c6c0c (version records), Rule 01a11a5e-1385-7484-baf3-93d865fd97a5
 * (the historical-frame caveat) and Rule 01a11a5e-17a0-7c21-9e23-dd56ef12c9a9 (restore impact).
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const OWNER = testMember({ memberId: 'owner-1', nickname: 'mei', kind: 'human', preset: 'owner', credential: 'session' })
const DIGEST = `sha256:${'a'.repeat(64)}`

const cleanup: string[] = []
const running: HistoryRecorder[] = []
afterEach(async () => {
	await Promise.all(running.splice(0).map(recorder => recorder.stop()))
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	cleanup.push(path)
	return path
}

function manualClock(): HistoryRecorderClock & Readonly<{ advance(milliseconds: number): void }> {
	let now = Date.parse('2026-10-09T00:00:00.000Z')
	return { now: () => now, setTimeout: () => Symbol('timer'), clearTimeout: () => undefined, advance(milliseconds) { now += milliseconds } }
}

/** A resolution of the given selections, as the server's resolution would give it, with a fixed content digest. */
function stubSource(kitBuild?: AdapterProvenanceSource['kitBuild']): AdapterProvenanceSource {
	return {
		resolve: async (adapters): Promise<AdapterSetResolutionResult> => ({
			state: 'valid',
			diagnostics: [],
			summaries: [],
			themeSupport: { diagnostics: [], unsupportedThemeIds: [] },
			set: {
				entries: adapters.map((selection, index) => ({
					index,
					selection,
					resolvedModule: { resolvedPath: `/host/only/${index}.mjs`, moduleIdentity: `file:///host/only/${index}.mjs`, packageVersion: '1.0.0' },
					manifest: { id: `adapter-${index}`, apiVersion: '1' },
					ownership: {},
				})) as unknown as ValidatedAdapterEntry[],
			},
		} as unknown as AdapterSetResolutionResult),
		pinnedContentDigest: async () => DIGEST,
		...(kitBuild ? { kitBuild } : {}),
	}
}

const ENTRY = (index: number, extra: Record<string, unknown> = {}): EvidenceAdapterProvenance => ({
	moduleSpecifier: `./adapters/${String.fromCharCode(97 + index)}.mjs`,
	adapterId: `adapter-${index}`,
	apiVersion: '1',
	packageVersion: '1.0.0',
	contentDigest: DIGEST,
	...extra,
})

const SELECTION = (letter: string, config?: unknown): WorkspaceAdapterSelection => ({ moduleSpecifier: `./adapters/${letter}.mjs`, ...(config === undefined ? {} : { config }) }) as WorkspaceAdapterSelection

async function workspace(adapters: readonly WorkspaceAdapterSelection[], source: AdapterProvenanceSource) {
	const root = await tempDir('uiux-history-adapters-ws-')
	const home = join(await tempDir('uiux-history-adapters-home-'), 'home')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, adapters, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: { light: { label: 'Light' } } })
	await persistence.locales.create('en-US', {})
	const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
	const clock = manualClock()
	const recorder = createHistoryRecorder({ persistence, stores: () => history.open(), clock, log: () => undefined, adapterProvenance: () => source })
	const app = createWorkspaceApplicationSession(persistence, { history, historyBoundary: () => recorder, adapterResolution: source })
	const spec = { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	expect((await app.createView({ id: VIEW_ID, name: 'Checkout', spec })).status).toBe('created')
	running.push(recorder)
	const started = await recorder.start()
	return { root, persistence, history, recorder, clock, app, baseline: started.baseline!, leases: createLeaseManager() }
}

describe('version records carry the Adapter provenance (Rule 01a11a5e-06fb, Clause 01a11a5e-201a)', () => {
	it('records the active set in the formal capture shape, without moduleIdentity, on the Baseline, a Checkpoint and an autosave', async () => {
		const source = stubSource()
		const ctx = await workspace([SELECTION('a'), SELECTION('b', { label: 'x' })], source)
		const current = await readCurrentAdapterProvenance(ctx.persistence, source)
		expect(current.state).toBe('available')
		const adapters = (current as Extract<CurrentAdapterProvenance, { state: 'available' }>).adapters
		expect(adapters).toHaveLength(2)
		expect(adapters[0]).not.toHaveProperty('moduleIdentity')
		expect(adapters[1]).toHaveProperty('configDigest')

		const baseline = await ctx.app.readVersion(ctx.baseline)
		expect(baseline).toMatchObject({ status: 'found', version: { type: 'checkpoint', adapters } })

		ctx.clock.advance(1_000)
		const checkpoint = await scoped(ctx.app, OWNER).createCheckpoint({ name: 'Second' })
		expect(checkpoint).toMatchObject({ status: 'created' })
		expect(await ctx.app.readVersion((checkpoint as { versionId: string }).versionId)).toMatchObject({ status: 'found', version: { adapters } })

		const session = scoped(ctx.app, OWNER, { leases: ctx.leases, history: ctx.recorder, transport: 'http' })
		const view = (await ctx.persistence.views.read(VIEW_ID))!
		const spec = { ...view.resource.spec, intent: 'Pay again' }
		expect(await session.updateViewSpec({ key: VIEW_ID, expectedRevision: view.revision, spec })).toMatchObject({ status: 'updated' })
		await ctx.recorder.stop()
		const listing = await ctx.app.listVersions({ types: ['autosave'] })
		const [autosave] = (listing as unknown as { versions: { id: string }[] }).versions
		expect(await ctx.app.readVersion(autosave!.id)).toMatchObject({ status: 'found', version: { type: 'autosave', adapters } })
	})

	it('records an empty set as an empty list, and no `adapters` while the set cannot be computed', async () => {
		const none = await workspace([], stubSource())
		expect(await none.app.readVersion(none.baseline)).toMatchObject({ version: { adapters: [] } })

		const building = await workspace([SELECTION('a')], stubSource(() => ({ state: 'building' })))
		const read = await building.app.readVersion(building.baseline)
		expect(read.status).toBe('found')
		expect((read as unknown as { version: object }).version).not.toHaveProperty('adapters')
	})

	it('records nothing when the budget runs out and logs it', async () => {
		const ctx = await workspace([SELECTION('a')], stubSource())
		const slow: AdapterProvenanceSource = { ...stubSource(), pinnedContentDigest: () => new Promise(() => undefined) }
		const logs: string[] = []
		expect(await adapterRecordFieldUnlocked(ctx.persistence, slow, { budgetMilliseconds: 20, log: line => logs.push(line) })).toEqual({})
		expect(logs).toHaveLength(1)
	})
})

describe('the historical-frame caveat (Rule 01a11a5e-1385)', () => {
	const available = (adapters: readonly EvidenceAdapterProvenance[]): CurrentAdapterProvenance => ({ state: 'available', adapters })

	it('shows when the recorded provenance is absent or differs in selection, order, content or configuration, or the current one is unavailable', () => {
		const recorded = [ENTRY(0), ENTRY(1)]
		expect(adaptersChangedCaveat(recorded, available([ENTRY(0), ENTRY(1)]))).toBe(false)
		expect(adaptersChangedCaveat([], available([]))).toBe(false)
		expect(adaptersChangedCaveat(undefined, available(recorded))).toBe(true)
		expect(adaptersChangedCaveat(recorded, available([ENTRY(1), ENTRY(0)]))).toBe(true)
		expect(adaptersChangedCaveat(recorded, available([ENTRY(0)]))).toBe(true)
		expect(adaptersChangedCaveat(recorded, available([ENTRY(0), ENTRY(1, { contentDigest: `sha256:${'b'.repeat(64)}` })]))).toBe(true)
		expect(adaptersChangedCaveat(recorded, available([ENTRY(0), ENTRY(1, { configDigest: DIGEST })]))).toBe(true)
		expect(adaptersChangedCaveat(recorded, { state: 'unavailable' })).toBe(true)
	})
})

describe('the restore impact listing follows the Adapter condition (Rule 01a11a5e-17a0)', () => {
	async function evidence(ctx: Awaited<ReturnType<typeof workspace>>, source: AdapterProvenanceSource): Promise<string> {
		const workspaceRead = await ctx.persistence.workspace.readInspected()
		const locale = (await ctx.persistence.locales.readInspected('en-US'))!
		const view = (await ctx.persistence.views.readInspected(VIEW_ID))!
		const screenshot = await ctx.persistence.artifacts.put(new TextEncoder().encode('screenshot'))
		const productKit = await readWorkspaceProductKitProvenance(ctx.persistence)
		const adapters = await readCurrentAdapterProvenance(ctx.persistence, source)
		if (adapters.state !== 'available') throw new Error('Adapter provenance unavailable')
		const record: FormalEvidenceRecord = {
			schemaVersion: 1,
			kind: 'formal_capture',
			executionContext: { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
			coverage: { complete: true },
			provenance: {
				workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
				resources: [
					{ identity: { type: 'view', id: VIEW_ID }, revision: view.revision },
					{ identity: { type: 'workspace', id: 'workspace' }, revision: workspaceRead.revision! },
					{ identity: { type: 'locale', id: 'en-US' }, revision: locale.revision },
				],
				versions: { uiux: '0.1.0' },
				...(productKit ? { productKit } : {}),
				adapters: adapters.adapters,
				renderInputDigest: renderInputDigest(view.resource),
			},
			artifactRefs: [screenshot.identity],
			evidenceRefs: [],
			data: {},
		}
		return (await ctx.persistence.artifacts.put(canonicalJsonBytes(record))).identity
	}

	it('lists Evidence that a Product Kit restore would make stale through a changed Adapter configuration, and nothing for an unchanged set', async () => {
		const source = stubSource()
		const ctx = await workspace([SELECTION('a', { label: 'one' })], source)
		const digest = await evidence(ctx, source)
		const earlier = (await scoped(ctx.app, OWNER).createCheckpoint({ name: 'One' })) as { versionId: string }

		// Unchanged set: the restore lists nothing.
		const session = scoped(ctx.app, OWNER, { leases: ctx.leases, history: ctx.recorder, transport: 'http' })
		const same = await session.restoreResourceVersion({ versionId: earlier.versionId, resource: { kind: 'product-kit', key: 'product-kit' }, expectedRevision: (await ctx.persistence.productKit.readRevision())! })
		expect(same).toMatchObject({ status: 'updated', impacts: [] })

		// The Adapter configuration changes after the Evidence was captured; it is already stale, so a restore back lists nothing...
		const kit = (await ctx.persistence.productKit.read())!
		const changed = { ...kit.resource, adapters: [SELECTION('a', { label: 'two' })] }
		expect((await ctx.persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: kit.revision, resource: changed })).ok).toBe(true)
		ctx.clock.advance(1_000)
		const stale = await scoped(ctx.app, OWNER).createCheckpoint({ name: 'Two' }) as { versionId: string }

		// ...whereas restoring the configuration the Evidence was captured with while it is fresh would be fine, and restoring the changed one lists it.
		const back = await session.restoreResourceVersion({ versionId: earlier.versionId, resource: { kind: 'product-kit', key: 'product-kit' }, expectedRevision: (await ctx.persistence.productKit.readRevision())! })
		expect(back).toMatchObject({ status: 'updated' })
		const forward = await session.restoreResourceVersion({ versionId: stale.versionId, resource: { kind: 'product-kit', key: 'product-kit' }, expectedRevision: (await ctx.persistence.productKit.readRevision())! })
		expect(forward).toMatchObject({ status: 'impact_acknowledgement_required', impacts: [{ category: 'evidence_stale', evidence: digest, viewId: VIEW_ID, reason: ADAPTER_CHANGED_REASON }] })
		const acknowledged = await session.restoreResourceVersion({ versionId: stale.versionId, resource: { kind: 'product-kit', key: 'product-kit' }, expectedRevision: (await ctx.persistence.productKit.readRevision())!, acknowledgeImpact: true })
		expect(acknowledged).toMatchObject({ status: 'updated', impacts: [{ category: 'evidence_stale', evidence: digest }] })
	}, 60_000)
})
