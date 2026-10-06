import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createHandoffExportService } from '../src/application/services/handoff-export'
import { createFormalCaptureService } from '../src/application/services/formal-capture'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { createUiuxMcpHttpHandler, principalAuthInfo } from '../src/mcp/server'
import { createLeaseManager } from '../src/application/access/leases'
import { AGENT_EDITOR, provisionToken, sessionCookieFor } from './support/access'
import {
	validateHandoffManifest,
	validateHandoffRoot,
	type HandoffManifest,
} from '../src/domain/handoff/schema'
import { validateViewResource, type ViewResource } from '../src/domain/views/schema'
import { validateFlowResource, type FlowResource } from '../src/domain/flows/schema'
import { validateWorkspaceManifest } from '../src/domain/workspace/schema'
import { validateAssetMetadata, type AuthoredAsset } from '../src/domain/assets/schema'
import { artifactBytesMatch } from '../src/domain/artifacts/schema'
import { canonicalJsonBytes } from '../src/domain/canonical-json'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import type { ReviewThread } from '../src/domain/reviews/schema'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

const temporaryRoots: string[] = []
const runningServers: ChildProcess[] = []

afterEach(async () => {
	for (const s of runningServers.splice(0)) {
		s.kill('SIGTERM')
	}
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function makeCounterAdapterSource(): string {
	return `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';
import { useWidget } from '@deviltea/widget-vue';

export const counterPlugin = createWidgetPlugin('Counter')
  .interfaces()
  .state(s => s.count({ authorWritable: true, validate: (v) => typeof v === 'number', default: () => 42 }))
  .done();

export const CounterRenderer = defineComponent({
  name: 'CounterRenderer',
  setup() {
    const { useState } = useWidget(counterPlugin);
    const state = useState();
    return () => h('div', { class: 'real-counter' }, 'Count: ' + state.count.value);
  }
});

export const manifest = {
  id: 'my-counter',
  apiVersion: '1',
  widgetPlugins: [counterPlugin],
  catalog: { widgets: { Counter: { assetFields: { image: { acceptedMediaTypes: ['image/png'] } } } } },
  renderers: [{ type: 'Counter', component: CounterRenderer }],
  providers: [],
  styles: [],
  tokens: [],
};
`
}

async function createTestWorkspace(adapters: Array<{ moduleSpecifier: string; config?: unknown }> = []): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-handoff-test-'))
	temporaryRoots.push(root)
	await mkdir(join(root, '.uiux'), { recursive: true })
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })

	const rootModules = join(process.cwd(), 'node_modules')

	const widgetCorePath = join(rootModules, '@deviltea', 'widget-core')
	const widgetVuePath = join(rootModules, '@deviltea', 'widget-vue')
	const vuePath = join(rootModules, 'vue')

	await symlink(widgetCorePath, join(root, 'node_modules', '@deviltea', 'widget-core')).catch(() => undefined)
	await symlink(widgetVuePath, join(root, 'node_modules', '@deviltea', 'widget-vue')).catch(() => undefined)
	await symlink(vuePath, join(root, 'node_modules', 'vue')).catch(() => undefined)

	await writeFile(join(root, '.uiux', 'workspace.json'), JSON.stringify({
		schemaVersion: 3,
		i18n: { defaultLocale: 'en-US' },
		adapters,
		viewports: {
			desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } },
		},
		themes: {
			light: { label: 'Light' },
		},
	}))

	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.locales.create('en-US', { 'app.title': 'UIUX Workspace' })
	return { root, persistence }
}

async function startTestServer(workspaceRoot: string): Promise<{ url: string; close: () => void; token: string; cookie: { name: string; value: string }; headers: Record<string, string> }> {
	const token = await provisionToken(workspaceRoot, { nickname: 'tester', kind: 'human', role: 'owner' })
	const probe = createServer()
	await new Promise<void>((res, rej) => { probe.once('error', rej); probe.listen(0, '127.0.0.1', () => res()) })
	const address = probe.address() as AddressInfo
	const port = address.port
	await new Promise<void>((res, rej) => probe.close(err => err ? rej(err) : res()))

	const serverEntry = resolve(process.cwd(), '.output/server/index.mjs')
	const server = spawn(process.execPath, [serverEntry], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(port),
			NITRO_HOST: '127.0.0.1',
			NITRO_PORT: String(port),
			UIUX_WORKSPACE_ROOT: workspaceRoot,
			UIUX_PACKAGE_ROOT: process.cwd(),
		},
	})
	runningServers.push(server)

	let serverOutput = ''
	server.stdout?.setEncoding('utf8').on('data', chunk => { serverOutput += chunk })
	server.stderr?.setEncoding('utf8').on('data', chunk => { serverOutput += chunk })

	const baseUrl = `http://127.0.0.1:${port}`
	const deadline = Date.now() + 15_000
	let ready = false
	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(`Test Nitro server exited before becoming ready:\n${serverOutput}`)
		}
		try {
			const res = await fetch(`${baseUrl}/api/health`)
			if (res.status === 200) {
				ready = true
				break
			}
		}
		catch {
			await new Promise(r => setTimeout(r, 100))
		}
	}

	if (!ready) {
		throw new Error(`Test Nitro server timed out waiting for /api/health:\n${serverOutput}`)
	}

	const cookie = await sessionCookieFor(baseUrl, token)
	return {
		url: baseUrl,
		close: () => server.kill('SIGTERM'),
		token,
		cookie,
		headers: { cookie: `${cookie.name}=${cookie.value}` },
	}
}

const VIEW_1_ID = '11111111-1111-4111-8111-111111111111'
const VIEW_2_ID = '22222222-2222-4222-8222-222222222222'
const VIEW_INVALID_ID = '99999999-9999-4999-8999-999999999999'
const FLOW_1_ID = '33333333-3333-4333-8333-333333333333'
const ASSET_1_ID = '44444444-4444-4444-8444-444444444444'
const REVIEW_1_ID = '55555555-5555-4555-8555-555555555555'

function createSampleView(id: string, name: string, assetRefId?: string): ViewResource {
	return {
		id,
		name,
		feature: 'checkout',
		ir: {
			type: 'RootShell',
			id: 'root',
			slots: {
				content: [{
					type: 'Counter',
					id: 'counter-1',
					props: {},
					bindings: {},
					events: {},
				}],
			},
		},
		variants: {
			alt: {
				state: {},
			},
		},
		spec: {
			intent: `Test view ${name}`,
			entryConditions: [],
			interactionRules: [],
			constraints: [],
			accessibility: [],
			references: assetRefId ? [{ type: 'external', uri: `uiux://asset/${assetRefId}` }] : [],
			decisions: [],
		},
	}
}

function createSampleFlow(id: string, targetViewId: string): FlowResource {
	const stepId = 'step-entry-0001'
	return {
		id,
		name: 'Main Flow',
		entryStepId: stepId,
		steps: {
			[stepId]: {
				target: { viewId: targetViewId },
				transitions: [],
			},
		},
	}
}

function createSampleAsset(id: string): { metadata: AuthoredAsset; content: Uint8Array } {
	return {
		metadata: {
			id,
			name: 'Brand Logo',
			contentFilename: 'logo.png',
			mediaType: 'image/png',
		},
		content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	}
}

async function putFormalEvidence(
	persistence: FileNativePersistence,
	viewId: string,
	viewRevision: string,
	complete = true,
): Promise<string> {
	const dummyScreenshotBytes = new TextEncoder().encode(`screenshot-bytes-for-${viewId}`)
	const screenshotPut = await persistence.artifacts.put(dummyScreenshotBytes)
	const workspaceRead = await persistence.workspace.readInspected()
	const localeRead = await persistence.locales.readInspected('en-US')
	if (!workspaceRead.revision || !localeRead) throw new Error('Test Workspace provenance is incomplete.')

	const record: FormalEvidenceRecord = {
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: {
			viewId,
			locale: 'en-US',
			viewportId: 'desktop',
			viewport: { width: 1280, height: 800 },
			themeId: 'light',
		},
		coverage: { complete },
		provenance: {
			workspaceSchemaVersion: 1,
			resources: [
				{ identity: { type: 'view', id: viewId }, revision: viewRevision },
				{ identity: { type: 'workspace', id: 'workspace' }, revision: workspaceRead.revision },
				{ identity: { type: 'locale', id: 'en-US' }, revision: localeRead.revision },
			],
			versions: { uiux: '0.1.0' },
		},
		artifactRefs: [screenshotPut.identity],
		evidenceRefs: [],
		data: {},
	}

	const recordBytes = canonicalJsonBytes(record)
	const recordPut = await persistence.artifacts.put(recordBytes)
	return recordPut.identity
}

describe('Handoff closure export and readiness evaluation', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('proves deterministic closure identity: same roots and content produce identical bundleIdentity across invocations', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'View One')
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const service = createHandoffExportService(persistence)
		const roots = [{ type: 'view' as const, viewId: VIEW_1_ID }]

		// First export
		const result1 = await service.exportHandoff({ roots })
		expect(result1.status).toBe('exported')
		expect(result1.bundleIdentity).toBeDefined()
		expect(result1.manifest).toBeDefined()
		expect(result1.readiness?.implementationReady).toBe(true)

		// Delay slightly to ensure distinct timestamp if unconstrained
		await new Promise(r => setTimeout(r, 20))

		// Second export
		const result2 = await service.exportHandoff({ roots })
		expect(result2.status).toBe('exported')
		expect(result2.bundleIdentity).toBeDefined()

		// Bundle identity MUST be completely deterministic and identical regardless of invocation time
		expect(result2.bundleIdentity).toBe(result1.bundleIdentity)
		expect(result1.manifest?.bundleIdentity).toBe(result1.bundleIdentity)
		expect(result2.manifest?.bundleIdentity).toBe(result2.bundleIdentity)

		// Validates against canonical Handoff manifest schema
		const validation = validateHandoffManifest(result1.manifest)
		expect(validation.ok).toBe(true)
		expect(validateHandoffRoot(roots[0]!).ok).toBe(true)
	})
	it('keeps draft bundle identity deterministic when equivalent root order changes', async () => {
		const { persistence } = await createTestWorkspace()
		await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'One'))
		await persistence.views.create(VIEW_2_ID, createSampleView(VIEW_2_ID, 'Two'))
		const service = createHandoffExportService(persistence)

		const first = await service.exportHandoff({ roots: [
			{ type: 'view', viewId: VIEW_1_ID },
			{ type: 'view', viewId: VIEW_2_ID },
		] })
		const second = await service.exportHandoff({ roots: [
			{ type: 'view', viewId: VIEW_2_ID },
			{ type: 'view', viewId: VIEW_1_ID },
		] })

		expect(first.status).toBe('exported')
		expect(first.readiness?.implementationReady).toBe(false)
		expect(second.bundleIdentity).toBe(first.bundleIdentity)
		expect(second.readiness?.blockingDiagnostics).toEqual(first.readiness?.blockingDiagnostics)
	})

	it('changes bundle identity when canonical content or revision changes', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'View One')
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const service = createHandoffExportService(persistence)
		const roots = [{ type: 'view' as const, viewId: VIEW_1_ID }]

		const result1 = await service.exportHandoff({ roots })

		// Modify the view spec
		const updatedView: ViewResource = {
			...view,
			spec: {
				...view.spec,
				intent: 'Updated intent that changes canonical content',
			},
		}
		const casRes = await persistence.views.compareAndSwap({
			key: VIEW_1_ID,
			expectedRevision: viewRev,
			resource: updatedView,
		})
		expect(casRes.ok).toBe(true)
		if (!casRes.ok) throw new Error('CAS failed')
		await putFormalEvidence(persistence, VIEW_1_ID, casRes.revision, true)

		const result2 = await service.exportHandoff({ roots })
		expect(result2.bundleIdentity).not.toBe(result1.bundleIdentity)
	})

	it('ensures closure isolation: unrelated invalid resource outside closure does not block export or readiness', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		// Create valid VIEW_1
		const view1 = createSampleView(VIEW_1_ID, 'Valid View')
		const viewRev1 = await persistence.views.create(VIEW_1_ID, view1)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev1, true)

		// Corrupt or invalid VIEW_INVALID outside the closure
		await mkdir(join(root, 'views'), { recursive: true })
		await writeFile(join(root, 'views', `${VIEW_INVALID_ID}.view.json`), JSON.stringify({
			id: VIEW_INVALID_ID,
			name: 'Completely broken view',
			// Missing required ir, variants, spec
		}))

		const service = createHandoffExportService(persistence)

		// Target only VIEW_1
		const result = await service.exportHandoff({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})

		expect(result.status).toBe('exported')
		expect(result.readiness?.implementationReady).toBe(true)
		expect(result.readiness?.blockingDiagnostics).toHaveLength(0)

		// Invalid view is not in exported resources
		const resourceIds = result.manifest?.resources.map(r => r.identity.id)
		expect(resourceIds).toContain(VIEW_1_ID)
		expect(resourceIds).not.toContain(VIEW_INVALID_ID)
	})

	it('blocks implementation-ready when review threads are unresolved, while still exporting coherent snapshot', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view1 = createSampleView(VIEW_1_ID, 'View With Open Review')
		const viewRev1 = await persistence.views.create(VIEW_1_ID, view1)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev1, true)

		// Create an OPEN review thread anchored to VIEW_1
		const reviewThread: ReviewThread = {
			id: REVIEW_1_ID,
			anchor: { viewId: VIEW_1_ID, widgetId: 'root' },
			variantNames: [],
			status: 'open',
			messages: [{
				id: 'msg-1',
				author: 'reviewer',
				body: 'Need visual check on button padding',
				createdAt: '2026-10-04T00:00:00Z',
			}],
		}
		const reviewRev = await persistence.reviews.create(REVIEW_1_ID, reviewThread)

		const service = createHandoffExportService(persistence)
		const roots = [{ type: 'view' as const, viewId: VIEW_1_ID }]

		// Assessment blocks readiness
		const assessment = await service.assessReadiness({ roots })
		expect(assessment.status).toBe('ok')
		expect(assessment.readiness?.implementationReady).toBe(false)
		expect(assessment.readiness?.blockingDiagnostics.some(d => d.code === 'handoff.unresolved_review_thread')).toBe(true)

		// Export succeeds as a coherent snapshot, but implementationReady is false
		const exported = await service.exportHandoff({ roots })
		expect(exported.status).toBe('exported')
		expect(exported.manifest).toBeDefined()
		expect(exported.readiness?.implementationReady).toBe(false)
		expect(validateHandoffManifest(exported.manifest).ok).toBe(true)

		// Resolve the review thread
		const casRev = await persistence.reviews.compareAndSwap({
			key: REVIEW_1_ID,
			expectedRevision: reviewRev,
			resource: { ...reviewThread, status: 'resolved' },
		})
		expect(casRev.ok).toBe(true)

		// Now readiness is unblocked!
		const resolvedExport = await service.exportHandoff({ roots })
		expect(resolvedExport.readiness?.implementationReady).toBe(true)
		expect(resolvedExport.readiness?.blockingDiagnostics).toHaveLength(0)
	})

	it('reports per-resolution review counts, never blocks on closed threads, and flags wont-fix as advisory only', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		const viewRev = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'View With Closed Reviews'))
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const human = { type: 'human', displayName: 'Mei' }
		const submissionId = 'f0000000-0000-4000-8000-000000000001'
		const closed = (index: number, resolution: string, reason?: string): ReviewThread => ({
			id: `e0000000-0000-4000-8000-00000000000${index}`,
			anchor: { viewId: VIEW_1_ID, widgetId: 'root' },
			variantNames: [],
			status: 'resolved',
			messages: [],
			submissions: [],
			history: [{ id: `d0000000-0000-4000-8000-00000000000${index}`, kind: 'lifecycle', from: 'open', to: 'resolved', actor: human, at: '2026-10-05T09:00:00Z', resolution: resolution as never, ...(reason ? { reason } : {}) }],
		})
		const verified: ReviewThread = {
			id: 'e0000000-0000-4000-8000-000000000009',
			anchor: { viewId: VIEW_1_ID, widgetId: 'root' },
			variantNames: [],
			status: 'resolved',
			messages: [],
			submissions: [{
				id: submissionId, actor: { type: 'agent' }, at: '2026-10-05T08:00:00Z', changeDomains: ['view-structure'],
				resources: [{ identity: { type: 'view', id: VIEW_1_ID }, revision: viewRev }], scope: {}, evidenceRefs: [{ kind: 'screenshot', evidence: `sha256:${'d'.repeat(64)}` }],
			}],
			history: [
				{ id: 'd0000000-0000-4000-8000-000000000008', kind: 'lifecycle', from: 'open', to: 'ready-for-review', actor: { type: 'agent' }, at: '2026-10-05T08:00:00Z', submissionId },
				{ id: 'd0000000-0000-4000-8000-000000000009', kind: 'lifecycle', from: 'ready-for-review', to: 'resolved', actor: human, at: '2026-10-05T08:30:00Z', submissionId, resolution: 'verified' },
			],
		}
		const threads = [closed(1, 'answered'), closed(2, 'wont-fix', 'Out of scope'), closed(3, 'duplicate', 'Same as e…9'), closed(4, 'obsolete'), closed(5, 'answered'), verified]
		for (const thread of threads) {
			await persistence.reviews.create(thread.id, thread)
			expect((await persistence.reviews.readInspected(thread.id))?.diagnostics).toEqual([])
		}

		const service = createHandoffExportService(persistence)
		const roots = [{ type: 'view' as const, viewId: VIEW_1_ID }]
		const assessed = await service.assessReadiness({ roots })
		expect(assessed.status).toBe('ok')
		expect(assessed.readiness?.implementationReady).toBe(true)
		expect(assessed.readiness?.coverage.review).toEqual({
			complete: true,
			threads: 6,
			workspaceThreads: 0,
			resolved: { 'verified': 1, 'answered': 2, 'wont-fix': 1, 'duplicate': 1, 'obsolete': 1 },
		})
		expect(assessed.readiness?.blockingDiagnostics).toEqual([{
			code: 'handoff.review_declined',
			message: expect.stringContaining('e0000000-0000-4000-8000-000000000002'),
			blocking: false,
			path: '/reviews/e0000000-0000-4000-8000-000000000002',
		}])

		const exported = await service.exportHandoff({ roots })
		expect(exported.status).toBe('exported')
		expect(validateHandoffManifest(exported.manifest).ok).toBe(true)
		expect(exported.manifest?.readiness.implementationReady).toBe(true)
		expect(exported.manifest?.readiness.coverage.review).toEqual(assessed.readiness?.coverage.review)
		expect(exported.manifest?.provenance.workspaceSchemaVersion).toBe(3)
		const snapshot = exported.manifest?.resources.find(resource => resource.type === 'review' && resource.identity.id === verified.id)
		expect((snapshot?.snapshot as unknown as ReviewThread).history.at(-1)?.resolution).toBe('verified')

		// An open thread still blocks; its count is not part of any resolution bucket.
		await persistence.reviews.create('e0000000-0000-4000-8000-00000000000a', { ...closed(0, 'answered'), id: 'e0000000-0000-4000-8000-00000000000a', status: 'open', history: [] })
		const blocked = await service.assessReadiness({ roots })
		expect(blocked.readiness?.implementationReady).toBe(false)
		expect(blocked.readiness?.coverage.review).toMatchObject({ complete: false, threads: 7, resolved: { answered: 2 } })
		expect(blocked.readiness?.blockingDiagnostics.filter(d => d.blocking).map(d => d.code)).toEqual(['handoff.unresolved_review_thread'])
	})

	it('blocks implementation-ready when formal evidence is missing or incomplete', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view1 = createSampleView(VIEW_1_ID, 'View Without Evidence')
		const viewRev = await persistence.views.create(VIEW_1_ID, view1)

		const service = createHandoffExportService(persistence)
		const roots = [{ type: 'view' as const, viewId: VIEW_1_ID }]

		// Missing evidence
		const resMissing = await service.exportHandoff({ roots })
		expect(resMissing.status).toBe('exported')
		expect(resMissing.readiness?.implementationReady).toBe(false)
		expect(resMissing.readiness?.blockingDiagnostics.some(d => d.code === 'handoff.missing_view_evidence')).toBe(true)

		// Provide incomplete evidence
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, false)

		const resIncomplete = await service.exportHandoff({ roots })
		expect(resIncomplete.status).toBe('exported')
		expect(resIncomplete.readiness?.implementationReady).toBe(false)
		expect(resIncomplete.readiness?.blockingDiagnostics.some(d => d.code === 'handoff.incomplete_view_evidence')).toBe(true)
	})

	it('computes transitive closure from Flow root to target Views, referenced Assets, Locales, and Adapters', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		// Create Asset
		const assetData = createSampleAsset(ASSET_1_ID)
		await persistence.assets.create(ASSET_1_ID, assetData)

		// Create View referencing Asset
		const view = createSampleView(VIEW_1_ID, 'Flow Target View', ASSET_1_ID)
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		// Create Flow referencing View
		const flow = createSampleFlow(FLOW_1_ID, VIEW_1_ID)
		await persistence.flows.create(FLOW_1_ID, flow)

		const service = createHandoffExportService(persistence)

		// Export with Flow as root
		const result = await service.exportHandoff({
			roots: [{ type: 'flow', flowId: FLOW_1_ID }],
		})

		expect(result.status).toBe('exported')
		expect(result.manifest).toBeDefined()
		const manifest = result.manifest!

		// Transitive closure contains: flow, view, asset, workspace, locale
		const resourceTypes = manifest.resources.map(r => r.type)
		expect(resourceTypes).toContain('flow')
		expect(resourceTypes).toContain('view')
		expect(resourceTypes).toContain('asset')
		expect(resourceTypes).toContain('workspace')
		expect(resourceTypes).toContain('locale')

		// Asset content is referenced in artifactRefs
		const assetSnapshot = manifest.resources.find(r => r.type === 'asset')
		expect(assetSnapshot?.contentDigest).toBeDefined()
		expect(manifest.artifactRefs.some(a => a.artifact === assetSnapshot?.contentDigest)).toBe(true)

		// Check that invalid root type is rejected
		const invalidResult = await service.exportHandoff({
			roots: [{ type: 'feature', feature: 'checkout' } as never],
		})
		expect(invalidResult.status).toBe('failed')
		expect(invalidResult.diagnostics?.some(d => d.code === 'handoff.invalid_root_type')).toBe(true)
	})

	it('includes authored Assets referenced only through Adapter Catalog assetFields in View IR', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const assetData = createSampleAsset(ASSET_1_ID)
		await persistence.assets.create(ASSET_1_ID, assetData)

		const view: ViewResource = {
			...createSampleView(VIEW_1_ID, 'IR Asset Binding'),
			ir: {
				type: 'RootShell',
				id: 'root',
				slots: {
					content: [{
						type: 'Counter',
						id: 'counter-with-asset',
						config: { image: { $asset: ASSET_1_ID } },
						slots: {},
					}],
				},
			},
			spec: {
				...createSampleView(VIEW_1_ID, 'IR Asset Binding').spec,
				references: [],
			},
		}
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const result = await createHandoffExportService(persistence).exportHandoff({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(result.status).toBe('exported')
		const assetSnapshot = result.manifest?.resources.find(resource =>
			resource.type === 'asset' && resource.identity.id === ASSET_1_ID)
		expect(assetSnapshot).toBeDefined()
		expect(assetSnapshot?.contentDigest).toBeDefined()
		expect(result.manifest?.artifactRefs).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'asset-content', artifact: assetSnapshot?.contentDigest }),
		]))
	})
	it('materializes widget implementation references and flags unavailable widget types', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		// View using both Counter and an unregistered UnknownWidget
		const view: ViewResource = {
			id: VIEW_1_ID,
			name: 'Mixed Widgets View',
			feature: 'test',
			ir: {
				type: 'RootShell',
				id: 'root',
				slots: {
					content: [
						{ type: 'Counter', id: 'c-1', props: {}, bindings: {}, events: {} },
						{ type: 'UnknownWidget', id: 'u-1', props: {}, bindings: {}, events: {} },
					],
				},
			},
			variants: {},
			spec: {
				intent: 'Test implementation references',
				entryConditions: [],
				interactionRules: [],
				constraints: [],
				accessibility: [],
				references: [],
				decisions: [],
			},
		}

		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const service = createHandoffExportService(persistence)
		const result = await service.exportHandoff({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})

		expect(result.status).toBe('exported')
		const manifest = result.manifest!

		// Counter implementation is materialized
		const counterImpl = manifest.implementationReferences.find(r => r.widgetType === 'Counter')
		expect(counterImpl).toBeDefined()
		expect(counterImpl?.semanticSource.availability).toBe('materialized')
		expect(counterImpl?.semanticSource.contentDigest).toBeDefined()
		const storedCounterBytes = await persistence.artifacts.read(counterImpl!.semanticSource.contentDigest!)
		expect(storedCounterBytes).toBeDefined()
		expect(new TextDecoder().decode(storedCounterBytes!)).toContain('my-counter')

		// RootShell built-in is materialized
		const rootShellImpl = manifest.implementationReferences.find(r => r.widgetType === 'RootShell')
		expect(rootShellImpl).toBeDefined()
		expect(rootShellImpl?.semanticSource.availability).toBe('materialized')

		// UnknownWidget is marked unavailable and blocks readiness
		const unknownImpl = manifest.implementationReferences.find(r => r.widgetType === 'UnknownWidget')
		expect(unknownImpl).toBeDefined()
		expect(unknownImpl?.semanticSource.availability).toBe('unavailable')
		expect(manifest.readiness.implementationReady).toBe(false)
		expect(manifest.readiness.blockingDiagnostics.some(d => d.code === 'handoff.unavailable_widget_source')).toBe(true)
	})

	it('deduplicates content-addressed artifacts when multiple views share the same asset', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		// Create shared asset
		const assetData = createSampleAsset(ASSET_1_ID)
		await persistence.assets.create(ASSET_1_ID, assetData)

		// Create View 1 and View 2 both referencing ASSET_1_ID
		const view1 = createSampleView(VIEW_1_ID, 'View One', ASSET_1_ID)
		const view2 = createSampleView(VIEW_2_ID, 'View Two', ASSET_1_ID)

		const viewRev1 = await persistence.views.create(VIEW_1_ID, view1)
		const viewRev2 = await persistence.views.create(VIEW_2_ID, view2)

		await putFormalEvidence(persistence, VIEW_1_ID, viewRev1, true)
		await putFormalEvidence(persistence, VIEW_2_ID, viewRev2, true)

		const service = createHandoffExportService(persistence)
		const result = await service.exportHandoff({
			roots: [
				{ type: 'view', viewId: VIEW_1_ID },
				{ type: 'view', viewId: VIEW_2_ID },
			],
		})

		expect(result.status).toBe('exported')
		const manifest = result.manifest!

		// Count occurrences of the asset content digest in artifactRefs
		const assetDigest = (await persistence.artifacts.put(assetData.content)).identity
		const matchingArtifactRefs = manifest.artifactRefs.filter(a => a.artifact === assetDigest)

		// Must appear EXACTLY once
		expect(matchingArtifactRefs).toHaveLength(1)

		// Manifest validation passes without duplicate artifact error
		const validation = validateHandoffManifest(manifest)
		expect(validation.ok).toBe(true)
		expect(validation.diagnostics.some(d => d.code === 'handoff.duplicate_artifact')).toBe(false)
	})

	it('consumer fixture: standalone downstream consumer validates manifest and resolves all snapshots and artifacts offline', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const assetData = createSampleAsset(ASSET_1_ID)
		await persistence.assets.create(ASSET_1_ID, assetData)

		const view = createSampleView(VIEW_1_ID, 'Exportable View', ASSET_1_ID)
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const service = createHandoffExportService(persistence)
		const result = await service.exportHandoff({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})

		expect(result.status).toBe('exported')
		const manifest = result.manifest!

		// Standalone consumer verification function (no access to workspace root / persistence)
		async function verifyConsumerPackage(
			bundle: HandoffManifest,
			artifactResolver: (digest: string) => Promise<Uint8Array | undefined>,
		) {
			// 1. Structural schema validation
			const manifestVal = validateHandoffManifest(bundle)
			if (!manifestVal.ok) return { ok: false, error: 'Manifest failed schema validation' }

			// 2. Resource validation
			for (const res of bundle.resources) {
				if (res.type === 'view') {
					const viewVal = validateViewResource(res.snapshot)
					if (!viewVal.ok) return { ok: false, error: `Invalid view resource: ${res.identity.id}` }
				}
				else if (res.type === 'flow') {
					const flowVal = validateFlowResource(res.snapshot)
					if (!flowVal.ok) return { ok: false, error: `Invalid flow resource: ${res.identity.id}` }
				}
				else if (res.type === 'asset') {
					const assetVal = validateAssetMetadata(res.snapshot, res.identity.id as string)
					if (!assetVal.ok) return { ok: false, error: `Invalid asset metadata: ${res.identity.id}` }
					if (!res.contentDigest) return { ok: false, error: 'Asset missing content digest' }
					const bytes = await artifactResolver(res.contentDigest)
					if (!bytes || !(await artifactBytesMatch(res.contentDigest, bytes))) {
						return { ok: false, error: `Asset content mismatch for ${res.contentDigest}` }
					}
				}
				else if (res.type === 'workspace') {
					const wsVal = validateWorkspaceManifest(res.snapshot)
					if (!wsVal.ok) return { ok: false, error: 'Invalid workspace manifest snapshot' }
				}
			}

			// 3. Materialized sources validation
			for (const impl of bundle.implementationReferences) {
				if (impl.semanticSource.availability === 'materialized') {
					const digest = impl.semanticSource.contentDigest!
					const bytes = await artifactResolver(digest)
					if (!bytes || !(await artifactBytesMatch(digest, bytes))) {
						return { ok: false, error: `Materialized source corrupted for ${impl.widgetType}` }
					}
				}
			}

			// 4. Artifact references validation
			for (const ref of bundle.artifactRefs) {
				const bytes = await artifactResolver(ref.artifact)
				if (!bytes || !(await artifactBytesMatch(ref.artifact, bytes))) {
					return { ok: false, error: `Referenced artifact missing or corrupt: ${ref.artifact}` }
				}
			}

			return { ok: true }
		}

		// Execute consumer verification
		const consumerOutcome = await verifyConsumerPackage(manifest, digest => persistence.artifacts.read(digest))
		expect(consumerOutcome.ok).toBe(true)
	})

	it('exposes handoff readiness assessment and export via MCP tools and HTTP endpoints', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'HTTP Test View')
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const server = await startTestServer(root)
		const serverUrl = server.url
		const app = createWorkspaceApplicationSession(persistence, { captureCookie: () => server.cookie })

		// 1. Test MCP client connection and tools
		const handler = createUiuxMcpHttpHandler(app, { leases: createLeaseManager() })
		const client = new Client({ name: 'mcp-handoff-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
		const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/api/mcp`), {
			fetch: async (input, init) => handler.fetch(new Request(input, init), { authInfo: principalAuthInfo(AGENT_EDITOR) }),
		})
		await client.connect(transport)

		try {
			// Call MCP assess_handoff_readiness
			const assessRes = await client.callTool({
				name: 'assess_handoff_readiness',
				arguments: {
					roots: [{ type: 'view', viewId: VIEW_1_ID }],
				},
			})
			expect(assessRes.isError).toBeFalsy()
			const assessData = assessRes.structuredContent as { status: string; readiness?: { implementationReady: boolean } }
			expect(assessData.status).toBe('ok')
			expect(assessData.readiness?.implementationReady).toBe(true)

			// Call MCP export_handoff
			const exportRes = await client.callTool({
				name: 'export_handoff',
				arguments: {
					roots: [{ type: 'view', viewId: VIEW_1_ID }],
				},
			})
			expect(exportRes.isError).toBeFalsy()
			const exportData = exportRes.structuredContent as { status: string; manifestArtifactDigest?: string; bundleIdentity?: string }
			expect(exportData.status).toBe('exported')
			expect(exportData.bundleIdentity).toBeDefined()
			expect(exportData.manifestArtifactDigest).toBeDefined()

			// 2. Test HTTP endpoints
			// POST /api/handoff/assess
			const httpAssess = await fetch(`${serverUrl}/api/handoff/assess`, {
				method: 'POST',
				headers: { ...server.headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ roots: [{ type: 'view', viewId: VIEW_1_ID }] }),
			})
			expect(httpAssess.status).toBe(200)
			const httpAssessJson = await httpAssess.json() as { status: string; readiness: { implementationReady: boolean } }
			expect(httpAssessJson.status).toBe('ok')

			// POST /api/handoff/export
			const httpExport = await fetch(`${serverUrl}/api/handoff/export`, {
				method: 'POST',
				headers: { ...server.headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ roots: [{ type: 'view', viewId: VIEW_1_ID }] }),
			})
			expect(httpExport.status).toBe(200)
			const httpExportJson = await httpExport.json() as {
				status: string
				manifestArtifactDigest: string
				bundleIdentity: string
			}
			expect(httpExportJson.status).toBe('exported')
			expect(httpExportJson.bundleIdentity).toBeDefined()

			// GET /api/artifacts/[digest] to download exported manifest
			const httpArtifact = await fetch(`${serverUrl}/api/artifacts/${httpExportJson.manifestArtifactDigest}`, { headers: server.headers })
			expect(httpArtifact.status).toBe(200)
			expect(httpArtifact.headers.get('content-type')).toContain('application/json')
			expect(httpArtifact.headers.get('x-content-type-options')).toBe('nosniff')
			const downloadedManifest = await httpArtifact.json() as HandoffManifest
			expect(downloadedManifest.bundleIdentity).toBe(httpExportJson.bundleIdentity)
			expect(validateHandoffManifest(downloadedManifest).ok).toBe(true)
		}
		finally {
			await client.close()
			await handler.close()
		}
	})

	it('materializes RootShell source snapshot with real bytes matching root-shell.ts and verifies digest', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'RootShell View')
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const handoff = createHandoffExportService(persistence)
		const exportRes = await handoff.exportHandoff({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(exportRes.status).toBe('exported')
		if (exportRes.status !== 'exported') return

		const rsRef = exportRes.manifest?.implementationReferences.find(r => r.widgetType === 'RootShell')
		expect(rsRef).toBeDefined()
		expect(rsRef?.semanticSource.availability).toBe('materialized')
		expect(rsRef?.semanticSource.contentDigest).toBeDefined()
		expect(rsRef?.semanticSource.provenance.path).toBe('src/runtime/root-shell.ts')

		// Read the actual artifact bytes from persistence and compare with actual local root-shell.ts
		const artifactBytes = await persistence.artifacts.read(rsRef!.semanticSource.contentDigest!)
		expect(artifactBytes).toBeDefined()
		const actualSource = await readFile(resolve(process.cwd(), 'src/runtime/root-shell.ts'))
		expect(Buffer.from(artifactBytes!)).toEqual(actualSource)

		// Digest verification
		const expectedDigest = 'sha256:' + createHash('sha256').update(actualSource).digest('hex')
		expect(rsRef?.semanticSource.contentDigest).toBe(expectedDigest)
	})

	it('excludes stale evidence from readiness and export when View revision changes (r1 -> r2 regression)', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'Revision Test View')
		const r1 = await persistence.views.create(VIEW_1_ID, view)

		// Capture evidence at r1
		const r1EvidenceDigest = await putFormalEvidence(persistence, VIEW_1_ID, r1, true)

		const handoff = createHandoffExportService(persistence)
		const formalCapture = createFormalCaptureService(persistence)

		// Assessment at r1: must be ready
		const assessR1 = await handoff.assessReadiness({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(assessR1.readiness?.implementationReady).toBe(true)

		// Mutate View to r2
		const updatedView = { ...view, name: 'Revision Test View Mutated' }
		const casRes = await persistence.views.compareAndSwap({
			key: VIEW_1_ID,
			expectedRevision: r1,
			resource: updatedView,
		})
		const r2 = casRes.revision
		expect(r2).not.toBe(r1)

		// Assessment at r2 before capturing new evidence: must NOT be ready!
		const assessR2Stale = await handoff.assessReadiness({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(assessR2Stale.readiness?.implementationReady).toBe(false)
		expect(assessR2Stale.readiness?.blockingDiagnostics.some(b => b.code === 'handoff.stale_view_evidence')).toBe(true)

		// Stale evidence must still remain discoverable in listEvidence
		const allEvidence = await formalCapture.listEvidence()
		expect(allEvidence.some(e => e.digest === r1EvidenceDigest)).toBe(true)

		// Export at r2: exported active evidenceRefs must NOT include the stale r1 evidence
		const exportR2Stale = await handoff.exportHandoff({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(exportR2Stale.status).toBe('exported')
		if (exportR2Stale.status === 'exported') {
			expect(exportR2Stale.manifest?.evidenceRefs.some(ref => ref.evidence === r1EvidenceDigest)).toBe(false)
		}

		// Now capture fresh evidence for r2
		const r2EvidenceDigest = await putFormalEvidence(persistence, VIEW_1_ID, r2, true)
		expect(r2EvidenceDigest).toBeDefined()

		// Assessment at r2 with fresh evidence: must become ready again!
		const assessR2Fresh = await handoff.assessReadiness({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(assessR2Fresh.readiness?.implementationReady).toBe(true)
	})

	it('treats evidence as stale when its locale revision changes without a View revision change', async () => {
		const { persistence } = await createTestWorkspace()
		const view = createSampleView(VIEW_1_ID, 'Localized View')
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const locale = await persistence.locales.read('en-US')
		if (!locale) throw new Error('Expected en-US locale')
		const localeUpdate = await persistence.locales.compareAndSwap({
			key: 'en-US',
			expectedRevision: locale.revision,
			resource: { 'app.title': 'Changed after capture' },
		})
		expect(localeUpdate.ok).toBe(true)

		const service = createHandoffExportService(persistence)
		const assessed = await service.assessReadiness({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(assessed.status).toBe('ok')
		expect(assessed.readiness?.implementationReady).toBe(false)
		expect(assessed.readiness?.blockingDiagnostics).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'handoff.stale_view_evidence' }),
		]))
	})
	it('safely ignores binaries, oversized files, and invalid JSON without misclassifying as evidence', async () => {
		const { persistence } = await createTestWorkspace()

		// 1. Binary artifact (e.g. PNG image with magic bytes)
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])
		await persistence.artifacts.put(pngBytes)

		// 2. Large binary / non-json artifact exceeding candidate read limit (> 512KB)
		const largeBuffer = Buffer.alloc(600 * 1024, 0x41) // 600KB
		await persistence.artifacts.put(largeBuffer)

		// 3. JSON asset that has kind: 'formal_capture' but invalid schema
		const fakeCaptureJson = canonicalJsonBytes({
			kind: 'formal_capture',
			schemaVersion: 999, // invalid / missing required fields
			somethingElse: 'bad',
		})
		await persistence.artifacts.put(fakeCaptureJson)

		// 4. Real valid formal evidence
		const validDigest = await putFormalEvidence(persistence, VIEW_1_ID, 'rev-1', true)

		const formalCapture = createFormalCaptureService(persistence)
		const evidenceList = await formalCapture.listEvidence()

		// Only the valid evidence should be discovered; binary, large, and invalid JSON must be skipped
		expect(evidenceList).toHaveLength(1)
		expect(evidenceList[0]?.digest).toBe(validDigest)
	})

	it('ensures unrelated broken adapter in workspace does not block closure readiness or export', async () => {
		// Workspace defines two adapters:
		// 1. Valid counter adapter (used by view)
		// 2. Broken adapter with syntax error or broken manifest (not used by view)
		const { root, persistence } = await createTestWorkspace([
			{ moduleSpecifier: './adapters/counter.mjs' },
			{ moduleSpecifier: './adapters/broken.mjs' },
		])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		await writeFile(join(root, 'adapters', 'broken.mjs'), 'export const broken = syntax error !@#$;')

		const view = createSampleView(VIEW_1_ID, 'Counter View')
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const handoff = createHandoffExportService(persistence)

		// Assessment must succeed because View only uses Counter, not the broken adapter
		const assess = await handoff.assessReadiness({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(assess.readiness?.implementationReady).toBe(true)

		// Export must succeed and materialize the needed adapter cleanly
		const exportRes = await handoff.exportHandoff({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(exportRes.status).toBe('exported')
		if (exportRes.status === 'exported') {
			expect(exportRes.manifest?.provenance.adapters).toHaveLength(1)
			expect(exportRes.manifest?.provenance.adapters[0]?.adapterId).toBe('my-counter')
		}
	})

	it('proves end-to-end integration: real Playwright formal capture output directly satisfies handoff readiness and export', { timeout: 30_000 }, async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'Real Capture Handoff View')
		await persistence.views.create(VIEW_1_ID, view)

		const server = await startTestServer(root)
		const serverUrl = server.url
		const formalCapture = createFormalCaptureService(persistence, { captureCookie: () => server.cookie })

		// 1. Run REAL formal capture via Playwright against running server
		const captureBatch = await formalCapture.capture({
			contexts: [{
				viewId: VIEW_1_ID,
				locale: 'en-US',
				viewportId: 'desktop',
				viewport: { width: 1280, height: 800 },
				themeId: 'light',
			}],
			baseUrl: serverUrl,
		})

		expect(captureBatch.status).toBe('ok')
		const realEvidenceDigest = captureBatch.results[0]?.evidenceDigest
		expect(realEvidenceDigest).toBeDefined()

		// 2. Assess readiness using the real formal capture
		const handoff = createHandoffExportService(persistence)
		const assess = await handoff.assessReadiness({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})

		expect(assess.readiness?.implementationReady).toBe(true)

		// 3. Export handoff with the real formal capture
		const exportRes = await handoff.exportHandoff({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})

		expect(exportRes.status).toBe('exported')
		if (exportRes.status === 'exported') {
			expect(exportRes.manifest?.evidenceRefs.some(ref => ref.evidence === realEvidenceDigest)).toBe(true)
			expect(exportRes.manifest?.artifactRefs.some(ref => ref.artifact === realEvidenceDigest)).toBe(true)
		}
	})
})
