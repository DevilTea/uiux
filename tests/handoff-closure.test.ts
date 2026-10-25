import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { FileNativePersistence } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import {
	createHandoffExportService,
	type AssessHandoffReadinessCommand,
	type ExportHandoffCommand,
} from '../src/application/services/handoff-export'
import { createFormalCaptureService } from '../src/application/services/formal-capture'
import { readWorkspaceProductKitProvenance } from '../src/application/services/product-kit-provenance'
import { readCurrentAdapterProvenance } from '../src/application/services/adapter-provenance'
import { readCurrentProductKitProvenance } from '../src/application/services/product-kit-provenance'
import { adapterFreshnessContext } from '../src/domain/evidence/adapter-provenance'
import { ADAPTER_CHANGED_REASON, ADAPTER_PROVENANCE_MISSING_REASON, ADAPTER_PROVENANCE_UNAVAILABLE_REASON, provenanceFreshness } from '../src/domain/evidence/staleness'
import { productKitFreshnessContext } from '../src/domain/product-kit/provenance'
import type { WorkspaceAdapterSelection } from '../src/domain/workspace/schema'
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
import { renderInputDigest } from '../src/domain/evidence/render-input-digest'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import type { ReviewThread } from '../src/domain/reviews/schema'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'
import { writeCurrentWorkspace } from './support/workspace-layout'
import { bundleAdapterWithOwnWidgetCore } from './support/own-widget-core'
import { checkAdapterSetRuntime, resolveSelectedWorkspaceAdapterList } from '../src/server/workspace-adapters'

const temporaryRoots: string[] = []
const runningServers: ChildProcess[] = []

afterEach(async () => {
	for (const s of runningServers.splice(0)) {
		s.kill('SIGTERM')
	}
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** These Workspaces are on the current schema, so the schema gate never blocks; a blocked result fails the test. */
function currentSchemaHandoff(persistence: FileNativePersistence, options: Parameters<typeof createHandoffExportService>[1] = {}) {
	const service = createHandoffExportService(persistence, options)
	return {
		async exportHandoff(command: ExportHandoffCommand) {
			const result = await service.exportHandoff(command)
			if (result.status === 'blocked') throw new Error(`Unexpected Handoff schema gate: ${result.code}`)
			return result
		},
		async assessReadiness(command: AssessHandoffReadinessCommand) {
			const result = await service.assessReadiness(command)
			if (result.status === 'blocked') throw new Error(`Unexpected Handoff schema gate: ${result.code}`)
			return result
		},
	}
}

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
};
`
}

/** An Adapter `zz-badge` providing `Badge`, which no sample View uses; its label comes from `./badge-label.mjs`. */
function makeBadgeAdapterSource(): string {
	return `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';
import { BADGE_LABEL } from './badge-label.mjs';

export const badgePlugin = createWidgetPlugin('Badge')
  .interfaces()
  .done();

export const BadgeRenderer = defineComponent({
  name: 'BadgeRenderer',
  setup() {
    return () => h('span', { class: 'badge' }, BADGE_LABEL);
  }
});

export const manifest = {
  id: 'zz-badge',
  apiVersion: '1',
  widgetPlugins: [badgePlugin],
  catalog: { widgets: { Badge: {} } },
  renderers: [{ type: 'Badge', component: BadgeRenderer }],
  providers: [],
};
`
}

async function writeBadgeAdapter(root: string, label = 'New'): Promise<void> {
	await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
	await writeFile(join(root, 'kit', 'adapters', 'badge.mjs'), makeBadgeAdapterSource())
	await writeFile(join(root, 'kit', 'adapters', 'badge-label.mjs'), `export const BADGE_LABEL = ${JSON.stringify(label)};\n`)
}

async function createTestWorkspace(adapters: Array<{ moduleSpecifier: string; config?: unknown }> = []): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-handoff-test-'))
	temporaryRoots.push(root)
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })

	const rootModules = join(process.cwd(), 'node_modules')

	const widgetCorePath = join(rootModules, '@deviltea', 'widget-core')
	const widgetVuePath = join(rootModules, '@deviltea', 'widget-vue')
	const vuePath = join(rootModules, 'vue')

	await symlink(widgetCorePath, join(root, 'node_modules', '@deviltea', 'widget-core')).catch(() => undefined)
	await symlink(widgetVuePath, join(root, 'node_modules', '@deviltea', 'widget-vue')).catch(() => undefined)
	await symlink(vuePath, join(root, 'node_modules', 'vue')).catch(() => undefined)

	await writeCurrentWorkspace(root, {
		i18n: { defaultLocale: 'en-US' },
		adapters,
		viewports: {
			desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } },
		},
		themes: {
			light: { label: 'Light' },
		},
	})

	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.locales.create('en-US', { 'app.title': 'UIUX Workspace' })
	return { root, persistence }
}

async function startTestServer(workspaceRoot: string): Promise<{ url: string; close: () => void; token: string; cookie: { name: string; value: string }; headers: Record<string, string> }> {
	const token = await provisionToken(workspaceRoot, { nickname: 'tester', kind: 'human', preset: 'owner' })
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
	withProductKit = true,
	withAdapters = true,
): Promise<string> {
	const dummyScreenshotBytes = new TextEncoder().encode(`screenshot-bytes-for-${viewId}`)
	const screenshotPut = await persistence.artifacts.put(dummyScreenshotBytes)
	const workspaceRead = await persistence.workspace.readInspected()
	const localeRead = await persistence.locales.readInspected('en-US')
	if (!workspaceRead.revision || !localeRead) throw new Error('Test Workspace provenance is incomplete.')
	// A capture without Product Kit provenance has unknown freshness (Rule 01a1161b-ff68-…), so the
	// fixture records the current one, as formal capture does.
	const productKit = withProductKit ? await readWorkspaceProductKitProvenance(persistence) : undefined
	// Likewise the Adapter provenance (Clause 01a1161c-008a-…), as formal capture records it.
	const adapters = withAdapters ? await readCurrentAdapterProvenance(persistence) : undefined
	// The View's render-input digest as it is stored now (Clause 01a14e30-2d4a-…), as formal capture records it.
	const viewRead = await persistence.views.readInspected(viewId)
	const viewRenderInput = viewRead?.resource ? renderInputDigest(viewRead.resource) : undefined

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
			...(productKit ? { productKit } : {}),
			...(adapters?.state === 'available' ? { adapters: adapters.adapters } : {}),
			...(viewRenderInput ? { renderInputDigest: viewRenderInput } : {}),
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'View One')
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const service = currentSchemaHandoff(persistence)
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
		const service = currentSchemaHandoff(persistence)

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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'View One')
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const service = currentSchemaHandoff(persistence)
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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

		const service = currentSchemaHandoff(persistence)

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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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
				actor: { type: 'human', id: 'reviewer' },
				at: '2026-10-04T00:00:00Z',
				body: 'Need visual check on button padding',
			}],
			history: [],
			submissions: [],
		}
		const reviewRev = await persistence.reviews.create(REVIEW_1_ID, reviewThread)

		const service = currentSchemaHandoff(persistence)
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())
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

		const service = currentSchemaHandoff(persistence)
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
		expect(exported.manifest?.provenance.workspaceSchemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view1 = createSampleView(VIEW_1_ID, 'View Without Evidence')
		const viewRev = await persistence.views.create(VIEW_1_ID, view1)

		const service = currentSchemaHandoff(persistence)
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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

		const service = currentSchemaHandoff(persistence)

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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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

		const result = await currentSchemaHandoff(persistence).exportHandoff({
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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

		const service = currentSchemaHandoff(persistence)
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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

		const service = currentSchemaHandoff(persistence)
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const assetData = createSampleAsset(ASSET_1_ID)
		await persistence.assets.create(ASSET_1_ID, assetData)

		const view = createSampleView(VIEW_1_ID, 'Exportable View', ASSET_1_ID)
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const service = currentSchemaHandoff(persistence)
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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'RootShell View')
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const handoff = currentSchemaHandoff(persistence)
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

	it('materializes the Adapter authoring entry declarations that RootShell\'s source imports its interfaces from', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const viewRev = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'RootShell View'))
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)
		const exportRes = await currentSchemaHandoff(persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exportRes.status).toBe('exported')
		if (exportRes.status !== 'exported') return

		// RootShell's source imports `RootShellInterfaces` from the entry by relative path (Discussion #241
		// owner decision 3 during review of #251); the Handoff carries the file that import names.
		const rootShellSource = await readFile(resolve(process.cwd(), 'src/runtime/root-shell.ts'), 'utf8')
		expect(rootShellSource).toContain(`import type { RootShellInterfaces } from '../adapter-entry'`)
		const declarations = await readFile(resolve(process.cwd(), 'src/adapter-entry/index.d.ts'))
		const digest = 'sha256:' + createHash('sha256').update(declarations).digest('hex')

		const rsRef = exportRes.manifest?.implementationReferences.find(r => r.widgetType === 'RootShell')
		expect(rsRef?.supportingSources).toEqual([{
			availability: 'materialized',
			provenance: { package: '@deviltea/uiux', path: 'src/adapter-entry/index.d.ts', revision: expect.any(String) },
			contentDigest: digest,
		}])
		expect(rsRef?.supportingSources?.[0]?.provenance.revision).toBe(rsRef?.semanticSource.provenance.revision)
		expect(exportRes.manifest?.artifactRefs).toContainEqual({ kind: 'widget-source', artifact: digest, context: { widgetType: 'RootShell' } })
		const stored = await persistence.artifacts.read(digest)
		expect(Buffer.from(stored!)).toEqual(declarations)
	})

	// Scenario 01a11a5b-1c07-79b5-89fc-dc04afdde464 and Rules 01a115cd-cbcc-…, 01a11a5a-58c6-… and 01a11add-f389-… (issue #93).
	describe('Adapter-mapped implementation sources', () => {
		const counterWithSources = (sources: string) => makeCounterAdapterSource().replace('providers: [],\n};', `providers: [],\n  sources: ${sources},\n};`)

		async function exportCounterView(root: string, persistence: FileNativePersistence, adapterSource: string) {
			await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
			await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), adapterSource)
			const viewRev = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'Counter View'))
			await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)
			const exported = await currentSchemaHandoff(persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
			if (exported.status !== 'exported') throw new Error('Expected an exported bundle.')
			return exported
		}

		const sha = (bytes: string | Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')

		it('snapshots mapped files with their package, revision and path, and marks the others provenance-only or unavailable without blocking', async () => {
			const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
			await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
			await mkdir(join(root, 'kit', 'node_modules', '@acme', 'ds', 'src'), { recursive: true })
			await writeFile(join(root, 'kit', 'node_modules', '@acme', 'ds', 'package.json'), JSON.stringify({ name: '@acme/ds', version: '2.1.0' }))
			await writeFile(join(root, 'kit', 'node_modules', '@acme', 'ds', 'src', 'Counter.vue'), '<template>ds counter</template>')
			await writeFile(join(root, 'kit', 'adapters', 'counter-renderer.txt'), 'renderer integration')
			await writeFile(join(root, 'kit', 'adapters', 'private.txt'), 'private')
			const exported = await exportCounterView(root, persistence, counterWithSources(JSON.stringify({
				Counter: {
					semantic: { path: 'adapters/counter.mjs' },
					renderer: { path: 'adapters/counter-renderer.txt' },
					designSystem: { package: '@acme/ds', path: 'src/Counter.vue' },
					supporting: [
						{ path: 'adapters/missing.md' },
						{ url: 'https://example.com/docs/counter' },
						{ path: 'adapters/private.txt', embed: false },
						{ package: '@acme/absent', path: 'x.ts' },
					],
				},
			})))
			const reference = exported.manifest!.implementationReferences.find(r => r.widgetType === 'Counter')!
			const adapterBytes = await readFile(join(root, 'kit', 'adapters', 'counter.mjs'))
			expect(reference.semanticSource).toEqual({
				availability: 'materialized',
				provenance: { package: '@workspace', path: 'adapters/counter.mjs', revision: sha(adapterBytes), selection: 'adapter-mapping' },
				contentDigest: sha(adapterBytes),
			})
			expect(reference.rendererSource).toEqual({
				availability: 'materialized',
				provenance: { package: '@workspace', path: 'adapters/counter-renderer.txt', revision: sha('renderer integration'), selection: 'adapter-mapping' },
				contentDigest: sha('renderer integration'),
			})
			expect(reference.designSystemSource).toEqual({
				availability: 'materialized',
				provenance: { package: '@acme/ds', path: 'src/Counter.vue', revision: '2.1.0', selection: 'adapter-mapping' },
				contentDigest: sha('<template>ds counter</template>'),
			})
			expect(reference.supportingSources).toEqual([
				{ availability: 'unavailable', provenance: { package: '@workspace', path: 'adapters/missing.md', selection: 'adapter-mapping' } },
				{ availability: 'provenance-only', provenance: { url: 'https://example.com/docs/counter', selection: 'adapter-mapping' } },
				{ availability: 'provenance-only', provenance: { package: '@workspace', path: 'adapters/private.txt', selection: 'adapter-mapping' } },
				{ availability: 'unavailable', provenance: { package: '@acme/absent', path: 'x.ts', selection: 'adapter-mapping' } },
			])
			const stored = await persistence.artifacts.read(reference.designSystemSource!.contentDigest!)
			expect(new TextDecoder().decode(stored!)).toBe('<template>ds counter</template>')
			expect(exported.manifest!.artifactRefs).toContainEqual({ kind: 'widget-source', artifact: sha('<template>ds counter</template>'), context: { widgetType: 'Counter' } })
			// A provenance-only or unavailable mapped source never blocks the readiness claim.
			expect(exported.manifest!.readiness.blockingDiagnostics.filter(d => d.blocking)).toEqual([])
			expect(exported.manifest!.readiness.implementationReady).toBe(true)
		})

		it('marks a mapped path that leaves its root through a link unavailable', async () => {
			const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
			const outside = await mkdtemp(join(tmpdir(), 'uiux-handoff-outside-'))
			temporaryRoots.push(outside)
			await writeFile(join(outside, 'secret.txt'), 'outside the root')
			await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
			await symlink(outside, join(root, 'kit', 'adapters', 'linked'))
			const exported = await exportCounterView(root, persistence, counterWithSources(JSON.stringify({
				Counter: { semantic: { path: 'adapters/linked/secret.txt' }, renderer: { path: 'adapters/counter.mjs' } },
			})))
			const reference = exported.manifest!.implementationReferences.find(r => r.widgetType === 'Counter')!
			expect(reference.semanticSource.availability).toBe('unavailable')
			expect(reference.semanticSource.contentDigest).toBeUndefined()
			expect(exported.manifest!.artifactRefs.some(ref => ref.artifact === sha('outside the root'))).toBe(false)
		})

		it('records the entry-module fallback for an Adapter without source mappings', async () => {
			const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
			const exported = await exportCounterView(root, persistence, makeCounterAdapterSource())
			const reference = exported.manifest!.implementationReferences.find(r => r.widgetType === 'Counter')!
			const digest = sha(await readFile(join(root, 'kit', 'adapters', 'counter.mjs')))
			const expected = {
				availability: 'materialized',
				provenance: { package: '@workspace', path: './adapters/counter.mjs', revision: digest, selection: 'entry-module-fallback' },
				contentDigest: digest,
			}
			expect(reference.semanticSource).toEqual(expected)
			expect(reference.rendererSource).toEqual(expected)
			expect(reference.designSystemSource).toBeUndefined()
			// UIUX's own RootShell reference carries no selection.
			expect(exported.manifest!.implementationReferences.find(r => r.widgetType === 'RootShell')!.semanticSource.provenance).not.toHaveProperty('selection')
		})

		it('exports an identical bundle identity for unchanged mapped sources and a new one when a mapped file changes', async () => {
			const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
			await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
			await writeFile(join(root, 'kit', 'adapters', 'notes.md'), 'v1')
			const mapped = counterWithSources(JSON.stringify({ Counter: { semantic: { path: 'adapters/counter.mjs' }, renderer: { path: 'adapters/notes.md' }, supporting: [{ url: 'https://example.com/a' }] } }))
			const first = await exportCounterView(root, persistence, mapped)
			const again = await currentSchemaHandoff(persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
			if (again.status !== 'exported') throw new Error('Expected an exported bundle.')
			expect(again.manifest!.implementationReferences).toEqual(first.manifest!.implementationReferences)
			expect(again.manifest!.bundleIdentity).toBe(first.manifest!.bundleIdentity)
			await writeFile(join(root, 'kit', 'adapters', 'notes.md'), 'v2')
			const changed = await currentSchemaHandoff(persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
			if (changed.status !== 'exported') throw new Error('Expected an exported bundle.')
			expect(changed.manifest!.bundleIdentity).not.toBe(first.manifest!.bundleIdentity)
		})
	})

	// Scenario 01a14e30-3071-774a-bdc4-61ff3c92e303 (Rules 01a115cd-c5a5-… and 01a115cd-c749-…).
	it('keeps evidence fresh in readiness and export after a Spec-only or metadata edit of its View', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'Spec Only View')
		const r1 = await persistence.views.create(VIEW_1_ID, view)
		const captured = await putFormalEvidence(persistence, VIEW_1_ID, r1, true)
		const handoff = currentSchemaHandoff(persistence)

		const edited = { ...view, name: 'Renamed View', feature: 'billing', spec: { ...view.spec, intent: 'A new intent, same render input' } }
		const casRes = await persistence.views.compareAndSwap({ key: VIEW_1_ID, expectedRevision: r1, resource: edited })
		expect(casRes.ok).toBe(true)
		if (!casRes.ok) throw new Error('CAS failed')
		expect(casRes.revision).not.toBe(r1)

		const assessed = await handoff.assessReadiness({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(assessed.readiness?.implementationReady).toBe(true)
		expect(assessed.readiness?.blockingDiagnostics.some(b => b.code === 'handoff.stale_view_evidence')).toBe(false)
		const exported = await handoff.exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exported.status).toBe('exported')
		if (exported.status === 'exported') expect(exported.manifest?.evidenceRefs.some(ref => ref.evidence === captured)).toBe(true)
	})

	// Rule 01a115cd-c53c-…: a capture that records no render-input digest is stale, even unchanged.
	it('excludes a capture that records no render-input digest from readiness and export', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		const view = createSampleView(VIEW_1_ID, 'Legacy Capture View')
		const r1 = await persistence.views.create(VIEW_1_ID, view)
		const captured = await putFormalEvidence(persistence, VIEW_1_ID, r1, true)
		const record = JSON.parse(Buffer.from((await persistence.artifacts.read(captured))!).toString('utf8')) as FormalEvidenceRecord
		const { renderInputDigest: _omitted, ...provenance } = record.provenance
		void _omitted
		const legacy = (await persistence.artifacts.put(canonicalJsonBytes({ ...record, provenance }))).identity
		expect(legacy).not.toBe(captured)
		// The same capture without the digest is left out; the one that records it is kept.
		const handoff = currentSchemaHandoff(persistence)
		const exported = await handoff.exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exported.status).toBe('exported')
		if (exported.status === 'exported') expect(exported.manifest?.evidenceRefs.map(ref => ref.evidence)).toEqual([captured])
	})

	// Scenario 01a118a1-d3f5-7ea8-875c-6ddf0ec00602: the change is an IR change.
	it('excludes stale evidence from readiness and export when View revision changes (r1 -> r2 regression)', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

		const view = createSampleView(VIEW_1_ID, 'Revision Test View')
		const r1 = await persistence.views.create(VIEW_1_ID, view)

		// Capture evidence at r1
		const r1EvidenceDigest = await putFormalEvidence(persistence, VIEW_1_ID, r1, true)

		const handoff = currentSchemaHandoff(persistence)
		const formalCapture = createFormalCaptureService(persistence)

		// Assessment at r1: must be ready
		const assessR1 = await handoff.assessReadiness({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(assessR1.readiness?.implementationReady).toBe(true)

		// Mutate the View's IR to r2: what was rendered changed (Rule 01a115cd-c5a5-…).
		const updatedView = { ...view, ir: { type: 'RootShell', id: 'root', slots: { content: [] } } }
		const casRes = await persistence.views.compareAndSwap({
			key: VIEW_1_ID,
			expectedRevision: r1,
			resource: updatedView,
		})
		expect(casRes.ok).toBe(true)
		if (!casRes.ok) throw new Error('CAS failed')
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

		const service = currentSchemaHandoff(persistence)
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

	// Rule 01a115cd-cc36-7160-a2b6-baadcf98e40b: a bundle records every active Adapter, so an Adapter set
	// that is invalid anywhere, even in an Adapter that provides no Widget type the closure uses, cannot
	// be recorded: it blocks, and no partial set of Adapters is recorded (Rule 01a115cd-aef9-7b93-9619-96196f63cfde).
	it('blocks readiness when an Adapter of the active set cannot load, even one no closure Widget uses, and records no partial set', async () => {
		const { root, persistence } = await createTestWorkspace([
			{ moduleSpecifier: './adapters/counter.mjs' },
			{ moduleSpecifier: './adapters/broken.mjs' },
		])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		await writeFile(join(root, 'kit', 'adapters', 'broken.mjs'), 'export const broken = syntax error !@#$;')

		const view = createSampleView(VIEW_1_ID, 'Counter View')
		const viewRev = await persistence.views.create(VIEW_1_ID, view)
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const handoff = currentSchemaHandoff(persistence)

		const assess = await handoff.assessReadiness({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(assess.readiness?.implementationReady).toBe(false)
		expect(assess.readiness?.blockingDiagnostics).toContainEqual(expect.objectContaining({ code: 'adapter.manifest_load_failed', path: '/adapters/1/moduleSpecifier', blocking: true }))

		// The bundle is still exported, as a diagnostic snapshot.
		const exportRes = await handoff.exportHandoff({
			roots: [{ type: 'view', viewId: VIEW_1_ID }],
		})
		expect(exportRes.status).toBe('exported')
		const manifest = exportRes.manifest!
		expect(manifest.readiness.implementationReady).toBe(false)
		expect(manifest.readiness.coverage.validation.complete).toBe(false)
		expect(manifest.provenance.adapters).toEqual([])
		expect(manifest.implementationReferences.find(reference => reference.widgetType === 'Counter')?.semanticSource.availability).toBe('unavailable')
	})

	it('records every active Adapter in Adapter-list order, including one that provides no Widget type the closure uses (#92)', async () => {
		// The list order is the reverse of the Adapter IDs' sort order: `zz-badge` before `my-counter`.
		const { root, persistence } = await createTestWorkspace([
			{ moduleSpecifier: './adapters/badge.mjs' },
			{ moduleSpecifier: './adapters/counter.mjs' },
		])
		await writeBadgeAdapter(root)
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		const viewRev = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'Counter View'))
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)
		const handoff = currentSchemaHandoff(persistence, { checkAdapterSet: set => checkAdapterSetRuntime(root, persistence.layout, set) })

		const exported = await handoff.exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exported.status).toBe('exported')
		const manifest = exported.manifest!
		expect(manifest.readiness.implementationReady).toBe(true)
		expect(manifest.provenance.adapters.map(adapter => [adapter.moduleSpecifier, adapter.adapterId])).toEqual([
			['./adapters/badge.mjs', 'zz-badge'],
			['./adapters/counter.mjs', 'my-counter'],
		])
		for (const adapter of manifest.provenance.adapters) expect(adapter.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
		// Only the used Widget types get implementation references; the unused Adapter adds provenance only.
		expect(manifest.implementationReferences.map(reference => reference.widgetType)).toEqual(['Counter', 'RootShell'])
		expect(validateHandoffManifest(manifest).ok).toBe(true)

		// Clause 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5: the unused Adapter's `contentDigest` covers the module
		// it imports, not only its entry module.
		const badgeDigest = manifest.provenance.adapters[0]!.contentDigest
		await writeBadgeAdapter(root, 'Changed')
		const again = await handoff.exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(again.manifest!.provenance.adapters.map(adapter => adapter.adapterId)).toEqual(['zz-badge', 'my-counter'])
		expect(again.manifest!.provenance.adapters[0]!.contentDigest).not.toBe(badgeDigest)
		expect(again.manifest!.provenance.adapters[1]!.contentDigest).toBe(manifest.provenance.adapters[1]!.contentDigest)
	})

	// Clause 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5: an entry needs a `packageVersion` or a `contentDigest`.
	it('blocks, rather than failing the export, when a local Adapter\'s module graph cannot be read for its content digest', async () => {
		const { root, persistence } = await createTestWorkspace([
			{ moduleSpecifier: './adapters/counter.mjs' },
			{ moduleSpecifier: './adapters/badge.mjs' },
		])
		await writeBadgeAdapter(root)
		// The unverifiable Adapter sits at Workspace Adapter-list index 1 (the recorded set has one entry), so the path proves it names the list index.
		// Node loads it, but the browser-platform bundle the digest is computed from cannot resolve a Node built-in.
		await writeFile(join(root, 'kit', 'adapters', 'badge.mjs'), `import 'node:fs';\n${makeBadgeAdapterSource()}`)
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		const viewRev = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'Counter View'))
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const exported = await currentSchemaHandoff(persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exported.status).toBe('exported')
		const manifest = exported.manifest!
		expect(manifest.readiness.implementationReady).toBe(false)
		expect(manifest.readiness.blockingDiagnostics).toContainEqual(expect.objectContaining({ code: 'handoff.adapter_provenance_unverifiable', path: '/adapters/1', blocking: true }))
		expect(manifest.provenance.adapters.map(adapter => adapter.adapterId)).toEqual(['my-counter'])
		// Its entry module is not stored either; the bundle names no Adapter it does not record.
		expect(manifest.artifactRefs.some(reference => reference.context?.adapterId === 'zz-badge')).toBe(false)
	})

	it('refuses the sources of an Adapter whose Widget plugins come from its own widget-core copy, as the server-side check does (#123)', async () => {
		const { root, persistence } = await createTestWorkspace([
			{ moduleSpecifier: './adapters/badge.mjs' },
			{ moduleSpecifier: './adapters/counter.mjs' },
		])
		await writeBadgeAdapter(root)
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), await bundleAdapterWithOwnWidgetCore({ source: makeCounterAdapterSource(), resolveDir: join(root, 'kit') }))
		const viewRev = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'Counter View'))
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)
		// The check the server injects into the application session (Clause 01a116f0-cae2-7c64-9c76-d472f252789a).
		const handoff = currentSchemaHandoff(persistence, { checkAdapterSet: set => checkAdapterSetRuntime(root, persistence.layout, set) })

		const assess = await handoff.assessReadiness({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(assess.readiness?.implementationReady).toBe(false)
		// The diagnostic names the Adapter by its Product Kit index, past the Adapter before it.
		expect(assess.readiness?.blockingDiagnostics).toContainEqual(expect.objectContaining({ code: 'adapter.runtime_widget_core_incompatible', path: '/adapters/1/manifest/widgetPlugins/0', blocking: true }))

		const exported = await handoff.exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exported.status).toBe('exported')
		const manifest = exported.manifest!
		expect(manifest.readiness.implementationReady).toBe(false)
		expect(manifest.implementationReferences.find(reference => reference.widgetType === 'Counter')?.semanticSource.availability).toBe('unavailable')
		expect(manifest.provenance.adapters).toEqual([])
		expect(manifest.artifactRefs.some(reference => reference.kind === 'adapter-module' || (reference.kind === 'widget-source' && reference.context?.widgetType === 'Counter'))).toBe(false)
	})

	it('keeps an Adapter that cannot be evaluated in the server worker non-blocking, with a note (#123)', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		// Loads from the Workspace, but fails once inlined into the Preview bundle (a data: module), as a top level that needs a browser does in the server worker.
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), `if (import.meta.url.startsWith('data:')) throw new Error('needs a browser');\n${makeCounterAdapterSource()}`)
		const viewRev = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'Counter View'))
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)
		const handoff = currentSchemaHandoff(persistence, { checkAdapterSet: set => checkAdapterSetRuntime(root, persistence.layout, set) })

		const assess = await handoff.assessReadiness({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(assess.readiness?.implementationReady).toBe(true)
		expect(assess.readiness?.blockingDiagnostics).toContainEqual(expect.objectContaining({ code: 'preview.bundle_failed', blocking: false }))
	})

	it('materializes the sources of an Adapter that imports the host widget-core under the same check (#123)', async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())
		const viewRev = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'Counter View'))
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)
		const handoff = currentSchemaHandoff(persistence, { checkAdapterSet: set => checkAdapterSetRuntime(root, persistence.layout, set) })

		const exported = await handoff.exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exported.status).toBe('exported')
		expect(exported.manifest?.readiness.implementationReady).toBe(true)
		expect(exported.manifest?.implementationReferences.find(reference => reference.widgetType === 'Counter')?.semanticSource.availability).toBe('materialized')
		expect(exported.manifest?.provenance.adapters.map(adapter => adapter.adapterId)).toEqual(['my-counter'])
	})

	// Clause 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5: `configDigest` is the `sha256:` identity of the
	// canonical JSON of the Adapter entry's `config`, absent when the entry has none.
	it('records each Adapter\'s configuration digest in the provenance, and none for an entry without configuration', async () => {
		const config = { tone: 'warm', levels: [1, 2], label: 'Configured' }
		const configured = makeCounterAdapterSource().replace('providers: [],', `providers: [],
  configSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },`)
		const { root, persistence } = await createTestWorkspace([
			{ moduleSpecifier: './adapters/counter.mjs', config },
		])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), configured)
		const viewRev = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'Counter View'))
		await putFormalEvidence(persistence, VIEW_1_ID, viewRev, true)

		const exported = await currentSchemaHandoff(persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exported.status).toBe('exported')
		const [adapter] = exported.manifest!.provenance.adapters
		expect(adapter?.configDigest).toBe(`sha256:${createHash('sha256').update(canonicalJsonBytes(config)).digest('hex')}`)
		// Member order does not change the canonical JSON, so it does not change the digest.
		expect(adapter?.configDigest).toBe(`sha256:${createHash('sha256').update(canonicalJsonBytes({ label: 'Configured', levels: [1, 2], tone: 'warm' })).digest('hex')}`)

		const unconfigured = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(unconfigured.root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(unconfigured.root, 'kit', 'adapters', 'counter.mjs'), configured)
		const otherRev = await unconfigured.persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'Counter View'))
		await putFormalEvidence(unconfigured.persistence, VIEW_1_ID, otherRev, true)
		const plain = await currentSchemaHandoff(unconfigured.persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(plain.status).toBe('exported')
		expect(plain.manifest!.provenance.adapters).toHaveLength(1)
		expect(Object.hasOwn(plain.manifest!.provenance.adapters[0]!, 'configDigest')).toBe(false)
	})

	it('proves end-to-end integration: real Playwright formal capture output directly satisfies handoff readiness and export', { timeout: 30_000 }, async () => {
		const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/counter.mjs' }])
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), makeCounterAdapterSource())

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
		// Clause 01a1161c-008a-…: the capture records the active Adapter set, with no host path.
		const captured = await persistence.artifacts.readCandidateJson(realEvidenceDigest!) as FormalEvidenceRecord
		expect(captured.provenance.adapters).toEqual([expect.objectContaining({ moduleSpecifier: './adapters/counter.mjs', adapterId: 'my-counter', apiVersion: '1', contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })])
		expect(JSON.stringify(captured)).not.toContain(root)

		// 2. Assess readiness using the real formal capture
		const handoff = currentSchemaHandoff(persistence)
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

function makeOrderAdapterSource(): string {
	return `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';

const plugin = (type) => createWidgetPlugin(type)
  .interfaces()
  .state(s => s.count({ authorWritable: true, validate: (v) => typeof v === 'number', default: () => 1 }))
  .done();
export const orderSummaryPlugin = plugin('OrderSummary');
export const productCardPlugin = plugin('ProductCard');
const render = (label) => defineComponent({ name: label, setup: () => () => h('div', label) });

export const manifest = {
  id: 'order-kit',
  apiVersion: '1',
  widgetPlugins: [orderSummaryPlugin, productCardPlugin],
  catalog: { widgets: {} },
  renderers: [{ type: 'OrderSummary', component: render('OrderSummary') }, { type: 'ProductCard', component: render('ProductCard') }],
  providers: [],
};
`
}

const ORDER_CARD_FILES = {
	'src/components/order-summary-card/OrderSummaryCard.vue': '<template><section class="order-summary-card"><slot /></section></template>\n',
	'src/components/order-summary-card/index.ts': 'export { default as OrderSummaryCard } from \'./OrderSummaryCard.vue\'\n',
} as const

/** A Workspace whose Product Kit maps `OrderSummary` to a registry component and `ProductCard` to an external export, with a View that uses both. */
async function productKitHandoffWorkspace(): Promise<{ root: string; persistence: FileNativePersistence }> {
	const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: './adapters/order.mjs' }])
	await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
	await writeFile(join(root, 'kit', 'adapters', 'order.mjs'), makeOrderAdapterSource())
	for (const [path, content] of Object.entries(ORDER_CARD_FILES)) {
		await mkdir(join(root, 'kit', path, '..'), { recursive: true })
		await writeFile(join(root, 'kit', path), content)
	}
	await writeFile(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', private: true, dependencies: { '@acme/ds': '^2.0.0' } }))
	await mkdir(join(root, 'kit', 'node_modules', '@acme', 'ds'), { recursive: true })
	await writeFile(join(root, 'kit', 'node_modules', '@acme', 'ds', 'package.json'), JSON.stringify({ name: '@acme/ds', version: '2.3.4' }))
	const current = (await persistence.productKit.read())!
	const swapped = await persistence.productKit.compareAndSwap({
		key: 'product-kit',
		expectedRevision: current.revision,
		resource: {
			...current.resource,
			designSystems: ['@acme/ds'],
			components: { 'order-summary-card': { files: Object.keys(ORDER_CARD_FILES), layer: 'product' } },
			widgets: { OrderSummary: { component: 'order-summary-card' }, ProductCard: { import: '@acme/ds', export: 'ProductCard' } },
		},
	})
	expect(swapped.ok).toBe(true)
	const view = createSampleView(VIEW_1_ID, 'Order View')
	await persistence.views.create(VIEW_1_ID, {
		...view,
		ir: {
			type: 'RootShell',
			id: 'root',
			slots: {
				content: [
					{ type: 'OrderSummary', id: 'summary-1', props: {}, bindings: {}, events: {} },
					{ type: 'ProductCard', id: 'card-1', props: {}, bindings: {}, events: {} },
				],
			},
		},
	} as ViewResource)
	return { root, persistence }
}

describe('Handoff Product Kit references (Feature 01a111e4-0272-…)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	// Scenario 01a11bb1-c2b2-7e8c-a058-29a8320af7ff: Handoff names the mapped registry component with its digest.
	it('names the mapped registry component with its digest, materializes its files, and snapshots the Product Kit', async () => {
		const { root, persistence } = await productKitHandoffWorkspace()
		await putFormalEvidence(persistence, VIEW_1_ID, (await persistence.views.readRevision(VIEW_1_ID))!, true)

		const exported = await currentSchemaHandoff(persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exported.status, JSON.stringify(exported.diagnostics)).toBe('exported')
		const manifest = exported.manifest!

		// Clause 01a11bb1-bbed-…: { name, componentDigest, files, add }, each file stored by content identity.
		const fileDigests: Record<string, string> = {}
		for (const [path, content] of Object.entries(ORDER_CARD_FILES))
			fileDigests[path] = `sha256:${createHash('sha256').update(content).digest('hex')}`
		const orderSummary = manifest.implementationReferences.find(reference => reference.widgetType === 'OrderSummary')
		expect(orderSummary?.component).toEqual({
			name: 'order-summary-card',
			componentDigest: `sha256:${createHash('sha256').update(canonicalJsonBytes(fileDigests)).digest('hex')}`,
			files: Object.entries(fileDigests).map(([path, digest]) => ({ path, digest })),
			add: 'uiux components add order-summary-card',
		})
		for (const [path, digest] of Object.entries(fileDigests)) {
			expect(manifest.artifactRefs).toContainEqual({ kind: 'component-file', artifact: digest, context: { component: 'order-summary-card', path } })
			expect(new TextDecoder().decode(await persistence.artifacts.read(digest))).toBe(ORDER_CARD_FILES[path as keyof typeof ORDER_CARD_FILES])
		}

		// An external export names its package and the installed version.
		const productCard = manifest.implementationReferences.find(reference => reference.widgetType === 'ProductCard')
		expect(productCard?.component).toEqual({ import: '@acme/ds', export: 'ProductCard', package: '@acme/ds', version: '2.3.4' })

		// Rule 01a11bb1-bd7c-…: the Product Kit file travels as a resource snapshot; Clause 01a115cd-d7ba-…: its provenance.
		const productKitFile = (await persistence.productKit.read())!
		expect(manifest.resources).toContainEqual({ type: 'product-kit', identity: { id: 'product-kit' }, revision: productKitFile.revision, snapshot: productKitFile.resource })
		expect(manifest.provenance.productKit).toEqual(await readWorkspaceProductKitProvenance(persistence))
		expect(manifest.provenance.adapters[0]?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

		// No host path enters what the Product Kit adds to the manifest (the Adapter `moduleIdentity` is a
		// resolved file URL, unchanged here).
		const real = await realpath(root)
		for (const part of [manifest.provenance.productKit, orderSummary?.component, productCard?.component, manifest.resources.find(resource => resource.type === 'product-kit')]) {
			expect(JSON.stringify(part)).not.toContain(root)
			expect(JSON.stringify(part)).not.toContain(real)
		}
		expect(manifest.readiness.implementationReady).toBe(true)
	})

	it('does not count a capture recorded without Product Kit provenance as fresh Evidence (owner ruling 8 of 2026-10-10)', async () => {
		const { persistence } = await productKitHandoffWorkspace()
		await putFormalEvidence(persistence, VIEW_1_ID, (await persistence.views.readRevision(VIEW_1_ID))!, true, false)
		const assessed = await currentSchemaHandoff(persistence).assessReadiness({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(assessed.readiness?.implementationReady).toBe(false)
		expect(assessed.readiness?.blockingDiagnostics).toContainEqual(expect.objectContaining({ code: 'handoff.stale_view_evidence', path: `/views/${VIEW_1_ID}` }))
	})

	// Owner ruling 4 of 2026-10-15 (https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18942505).
	it('omits the version of an external export whose installed version cannot be determined', async () => {
		const { root, persistence } = await productKitHandoffWorkspace()
		await rm(join(root, 'kit', 'node_modules', '@acme', 'ds'), { recursive: true })
		await putFormalEvidence(persistence, VIEW_1_ID, (await persistence.views.readRevision(VIEW_1_ID))!, true)
		const exported = await currentSchemaHandoff(persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exported.status, JSON.stringify(exported.diagnostics)).toBe('exported')
		const component = exported.manifest!.implementationReferences.find(reference => reference.widgetType === 'ProductCard')?.component
		expect(component).toEqual({ import: '@acme/ds', export: 'ProductCard', package: '@acme/ds' })
		expect(Object.hasOwn(component!, 'version')).toBe(false)
	})

	for (const [title, arrange] of [
		['a component file that is a symbolic link', async (root: string) => {
			const linked = join(root, 'kit', 'src', 'components', 'order-summary-card', 'index.ts')
			await writeFile(join(root, 'kit', 'src', 'components', 'order-summary-card', 'real-index.ts'), 'export {}\n')
			await rm(linked)
			await symlink('./real-index.ts', linked)
		}],
		['component files that lie outside kit/src/ by their real path (kit/src is a link)', async (root: string) => {
			await rename(join(root, 'kit', 'src'), join(root, 'kit', 'real-src'))
			await symlink('./real-src', join(root, 'kit', 'src'))
		}],
	] as const) {
		it(`names no component, with handoff.component_unavailable, for ${title}`, async () => {
			const { root, persistence } = await productKitHandoffWorkspace()
			await arrange(root)
			await putFormalEvidence(persistence, VIEW_1_ID, (await persistence.views.readRevision(VIEW_1_ID))!, true)
			const exported = await currentSchemaHandoff(persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
			expect(exported.status, JSON.stringify(exported.diagnostics)).toBe('exported')
			const manifest = exported.manifest!
			expect(manifest.implementationReferences.find(reference => reference.widgetType === 'OrderSummary')?.component).toBeUndefined()
			expect(manifest.readiness.blockingDiagnostics).toContainEqual(expect.objectContaining({ code: 'handoff.component_unavailable', blocking: false, path: '/product-kit/widgets/OrderSummary' }))
			expect(manifest.artifactRefs.some(reference => reference.kind === 'component-file')).toBe(false)
			// The external export is unaffected.
			expect(manifest.implementationReferences.find(reference => reference.widgetType === 'ProductCard')?.component).toMatchObject({ package: '@acme/ds', version: '2.3.4' })
		})
	}
})

// Issue #57: formal capture records the active Adapter set (Clause 01a1161c-008a-…), and a capture is
// stale once that set differs in selection, order, content or configuration (Rule 01a115cd-c6de-…);
// one that records none has unknown freshness (Rule 01a1161b-ff68-…). Handoff readiness and the bundle
// accept only fresh captures (Rules 01a115cd-ca1a-… and 01a115cd-ca50-…).
describe('Adapter-driven Evidence freshness (issue #57)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	const COUNTER = './adapters/counter.mjs'
	const BADGE = './adapters/badge.mjs'
	const CONFIGURABLE_COUNTER = makeCounterAdapterSource().replace('providers: [],', `providers: [],
  configSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },`)

	async function adapterWorkspace(adapters: WorkspaceAdapterSelection[] = [{ moduleSpecifier: COUNTER }]): Promise<{ root: string; persistence: FileNativePersistence; evidence: string }> {
		const { root, persistence } = await createTestWorkspace(adapters)
		await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), CONFIGURABLE_COUNTER)
		await writeFile(join(root, 'kit', 'adapters', 'badge.mjs'), makeCounterAdapterSource().replaceAll('Counter', 'Badge').replace('\'my-counter\'', '\'my-badge\''))
		const viewRevision = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'Counter View'))
		return { root, persistence, evidence: await putFormalEvidence(persistence, VIEW_1_ID, viewRevision, true) }
	}

	/** The Adapter and Product Kit conditions of the stored capture against the current Workspace; `undefined` when both hold. */
	async function provenanceCondition(persistence: FileNativePersistence, evidence: string) {
		const record = await persistence.artifacts.readCandidateJson(evidence) as FormalEvidenceRecord
		return provenanceFreshness(record, {
			...adapterFreshnessContext(await readCurrentAdapterProvenance(persistence)),
			...productKitFreshnessContext(await readCurrentProductKitProvenance(persistence)),
		})
	}

	async function staleInHandoff(persistence: FileNativePersistence): Promise<boolean> {
		const assessed = await currentSchemaHandoff(persistence).assessReadiness({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		return assessed.readiness!.blockingDiagnostics.some(diagnostic => diagnostic.code === 'handoff.stale_view_evidence')
	}

	async function setAdapters(persistence: FileNativePersistence, adapters: WorkspaceAdapterSelection[]): Promise<void> {
		const current = (await persistence.productKit.read())!
		const swapped = await persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: current.revision, resource: { ...current.resource, adapters } })
		expect(swapped.ok).toBe(true)
	}

	it('records every active Adapter in Adapter-list order without a host path, and keeps the capture fresh while nothing changes', async () => {
		const { root, persistence, evidence } = await adapterWorkspace([{ moduleSpecifier: COUNTER, config: { tone: 'warm' } }, { moduleSpecifier: BADGE }])
		const record = await persistence.artifacts.readCandidateJson(evidence) as FormalEvidenceRecord
		expect(record.provenance.adapters?.map(adapter => [adapter.moduleSpecifier, adapter.adapterId, adapter.apiVersion])).toEqual([[COUNTER, 'my-counter', '1'], [BADGE, 'my-badge', '1']])
		for (const adapter of record.provenance.adapters ?? []) expect(adapter.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
		expect(record.provenance.adapters?.[0]?.configDigest).toMatch(/^sha256:/)
		expect(Object.hasOwn(record.provenance.adapters?.[1] ?? {}, 'configDigest')).toBe(false)
		expect(JSON.stringify(record.provenance)).not.toContain(root)
		expect(await provenanceCondition(persistence, evidence)).toBeUndefined()
		expect(await staleInHandoff(persistence)).toBe(false)
	})

	it('stales the capture once an Adapter module changes', async () => {
		const { root, persistence, evidence } = await adapterWorkspace()
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), `${CONFIGURABLE_COUNTER}\n// The renderer changed.\n`)
		expect(await provenanceCondition(persistence, evidence)).toEqual({ isStale: true, reason: ADAPTER_CHANGED_REASON })
		expect(await staleInHandoff(persistence)).toBe(true)
		// Restoring the module restores freshness: the comparison is by content, not by time.
		await writeFile(join(root, 'kit', 'adapters', 'counter.mjs'), CONFIGURABLE_COUNTER)
		expect(await provenanceCondition(persistence, evidence)).toBeUndefined()
	})

	it('stales the capture once an Adapter\'s configuration changes', async () => {
		const { persistence, evidence } = await adapterWorkspace([{ moduleSpecifier: COUNTER, config: { tone: 'warm' } }])
		await setAdapters(persistence, [{ moduleSpecifier: COUNTER, config: { tone: 'cool' } }])
		expect(await provenanceCondition(persistence, evidence)).toEqual({ isStale: true, reason: ADAPTER_CHANGED_REASON })
		expect(await staleInHandoff(persistence)).toBe(true)
	})

	it('stales the capture once the Adapter list gains, loses or reorders an Adapter', async () => {
		const { persistence, evidence } = await adapterWorkspace([{ moduleSpecifier: COUNTER }, { moduleSpecifier: BADGE }])
		for (const adapters of [[{ moduleSpecifier: BADGE }, { moduleSpecifier: COUNTER }], [{ moduleSpecifier: COUNTER }], []]) {
			await setAdapters(persistence, adapters)
			expect(await provenanceCondition(persistence, evidence), JSON.stringify(adapters)).toEqual({ isStale: true, reason: ADAPTER_CHANGED_REASON })
		}
		await setAdapters(persistence, [{ moduleSpecifier: COUNTER }, { moduleSpecifier: BADGE }])
		expect(await provenanceCondition(persistence, evidence)).toBeUndefined()
		expect(await staleInHandoff(persistence)).toBe(false)
	})

	it('gives a capture that records no Adapter provenance unknown freshness, which Handoff does not accept', async () => {
		const { persistence } = await adapterWorkspace()
		const legacy = await putFormalEvidence(persistence, VIEW_1_ID, (await persistence.views.readRevision(VIEW_1_ID))!, true, true, false)
		expect(await provenanceCondition(persistence, legacy)).toEqual({ isStale: true, unknown: true, reason: ADAPTER_PROVENANCE_MISSING_REASON })
		const exported = await currentSchemaHandoff(persistence).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
		expect(exported.manifest?.evidenceRefs.map(ref => ref.evidence)).not.toContain(legacy)
	})

	it('gives every capture unknown freshness while the current Adapter set does not resolve', async () => {
		const { persistence, evidence } = await adapterWorkspace()
		await setAdapters(persistence, [{ moduleSpecifier: './adapters/missing.mjs' }])
		expect(await readCurrentAdapterProvenance(persistence)).toEqual({ state: 'unavailable' })
		expect(await provenanceCondition(persistence, evidence)).toEqual({ isStale: true, unknown: true, reason: ADAPTER_PROVENANCE_UNAVAILABLE_REASON })
	})

	// Issue #304: provenance whose content digest cannot be computed, and provenance through the server's resolution.
	describe('when an Adapter\'s provenance cannot be computed or comes from the server\'s resolution (issue #304)', () => {
		/** A Workspace whose one Adapter is the package `acme-adapter` 1.0.0, so its provenance has a package version. */
		async function packageAdapterWorkspace(): Promise<{ root: string; persistence: FileNativePersistence; evidence: string }> {
			const { root, persistence } = await createTestWorkspace([{ moduleSpecifier: 'acme-adapter' }])
			await mkdir(join(root, 'kit', 'node_modules', 'acme-adapter'), { recursive: true })
			await writeFile(join(root, 'kit', 'package.json'), JSON.stringify({ private: true, dependencies: { 'acme-adapter': '1.0.0' } }))
			await writeFile(join(root, 'kit', 'node_modules', 'acme-adapter', 'package.json'), JSON.stringify({ name: 'acme-adapter', version: '1.0.0', type: 'module', main: './index.mjs' }))
			await writeFile(join(root, 'kit', 'node_modules', 'acme-adapter', 'index.mjs'), `${CONFIGURABLE_COUNTER}\nimport './dep.mjs'\n`)
			await writeFile(join(root, 'kit', 'node_modules', 'acme-adapter', 'dep.mjs'), 'export {}\n')
			const viewRevision = await persistence.views.create(VIEW_1_ID, createSampleView(VIEW_1_ID, 'Counter View'))
			return { root, persistence, evidence: await putFormalEvidence(persistence, VIEW_1_ID, viewRevision, true) }
		}

		// A file the bundle cannot read stands in for a transient failure; root reads it regardless.
		it.skipIf(process.getuid?.() === 0)('gives a capture unknown freshness, never an Adapter change, while a package Adapter\'s content digest cannot be computed (Rule 01a164bc-4e09)', async () => {
			const { root, persistence, evidence } = await packageAdapterWorkspace()
			const record = await persistence.artifacts.readCandidateJson(evidence) as FormalEvidenceRecord
			expect(record.provenance.adapters).toEqual([expect.objectContaining({ moduleSpecifier: 'acme-adapter', packageVersion: '1.0.0', contentDigest: expect.stringMatching(/^sha256:/) })])
			expect(await provenanceCondition(persistence, evidence)).toBeUndefined()

			// A transient failure to bundle the graph: a module of it cannot be read for a moment.
			const dependency = join(root, 'kit', 'node_modules', 'acme-adapter', 'dep.mjs')
			await chmod(dependency, 0o000)
			expect(await readCurrentAdapterProvenance(persistence)).toEqual({ state: 'unavailable' })
			expect(await provenanceCondition(persistence, evidence)).toEqual({ isStale: true, unknown: true, reason: ADAPTER_PROVENANCE_UNAVAILABLE_REASON })
			expect(await staleInHandoff(persistence)).toBe(true)

			// Once it recovers, the capture is fresh again.
			await chmod(dependency, 0o644)
			expect(await provenanceCondition(persistence, evidence)).toBeUndefined()
			expect(await staleInHandoff(persistence)).toBe(false)
		})

		it('exports the same Handoff bundle, byte for byte, through the server\'s resolution as through the files on disk while no kit build runs', async () => {
			const { root, persistence } = await adapterWorkspace([{ moduleSpecifier: COUNTER, config: { tone: 'warm' } }, { moduleSpecifier: BADGE }])
			const exportBundle = async (options: Parameters<typeof createHandoffExportService>[1]) => {
				const exported = await currentSchemaHandoff(persistence, options).exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
				expect(exported.status, JSON.stringify(exported.diagnostics)).toBe('exported')
				return exported.manifest!
			}
			const fromDisk = await exportBundle({})
			const resolve = vi.fn((adapters: readonly WorkspaceAdapterSelection[]) => resolveSelectedWorkspaceAdapterList(root, undefined, adapters))
			const throughServer = await exportBundle({ adapterProvenance: { resolve } })
			expect(resolve).toHaveBeenCalled()
			// The closure's Adapters, their catalogs included, come from the one resolution of the whole list.
			for (const [adapters] of resolve.mock.calls) expect(adapters.map(adapter => adapter.moduleSpecifier)).toEqual([COUNTER, BADGE])
			expect(throughServer.bundleIdentity).toBe(fromDisk.bundleIdentity)
			expect(canonicalJsonBytes({ ...throughServer, exportedAt: '' })).toEqual(canonicalJsonBytes({ ...fromDisk, exportedAt: '' }))
			expect(fromDisk.evidenceRefs.length).toBeGreaterThan(0)
		})

		it('gives every capture unknown freshness and records no Adapter provenance in Handoff while a kit build is running or its last run failed (Rule 01a167d8-acd9)', async () => {
			const { persistence } = await adapterWorkspace()
			for (const state of ['building', 'failed'] as const) {
				const handoff = currentSchemaHandoff(persistence, { adapterProvenance: { kitBuild: () => ({ state }) } })
				const assessed = await handoff.assessReadiness({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
				expect(assessed.readiness!.blockingDiagnostics.some(diagnostic => diagnostic.code === 'handoff.stale_view_evidence'), state).toBe(true)
				const exported = await handoff.exportHandoff({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
				expect(exported.manifest?.provenance.adapters, state).toEqual([])
				expect(exported.manifest?.readiness.blockingDiagnostics, state).toContainEqual(expect.objectContaining({ code: 'handoff.adapter_provenance_unverifiable', path: '/adapters', blocking: true }))
				expect(exported.manifest?.readiness.implementationReady, state).toBe(false)
			}
			const ready = await currentSchemaHandoff(persistence, { adapterProvenance: { kitBuild: () => ({ state: 'ready' }) } }).assessReadiness({ roots: [{ type: 'view', viewId: VIEW_1_ID }] })
			expect(ready.readiness!.blockingDiagnostics.some(diagnostic => diagnostic.code === 'handoff.stale_view_evidence')).toBe(false)
		})
	})
})
