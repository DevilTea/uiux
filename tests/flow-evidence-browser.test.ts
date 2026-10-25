import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { validateFormalEvidenceRecord } from '../src/domain/evidence/schema'
import type { FlowResource } from '../src/domain/flows/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { provisionToken, sessionCookieFor } from './support/access'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * Formal UX Flow Evidence against the built server and a real Playwright capture (Clause
 * 01a172cc-e195-711b-bfa9-5de6c1c8ff87): a two-step Flow is traced, each entered View and Variant is
 * formally captured, and the stored `flow_trace` record references those captures.
 */

const VIEW_A = '11111111-1111-4111-8111-111111111111'
const VIEW_B = '33333333-3333-4333-8333-333333333333'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const STEP_A = '44444444-4444-4444-8444-444444444444'
const STEP_B = '55555555-5555-4555-8555-555555555555'
const roots: string[] = []
const servers: ChildProcess[] = []

afterEach(async () => {
	for (const server of servers.splice(0)) server.kill('SIGTERM')
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function view(id: string, name: string): ViewResource {
	return {
		id,
		name,
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: { done: { state: {} } },
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

const flow: FlowResource = {
	id: FLOW_ID,
	name: 'Two steps',
	entryStepId: STEP_A,
	steps: {
		[STEP_A]: { target: { viewId: VIEW_A }, transitions: [{ trigger: { widgetId: 'root', event: 'press' }, targetStepId: STEP_B }] },
		[STEP_B]: { target: { viewId: VIEW_B, variantName: 'done' }, transitions: [] },
	},
}

async function startServer(root: string): Promise<{ origin: string; cookie: { name: string; value: string } }> {
	const token = await provisionToken(root, { nickname: 'tester', kind: 'human', preset: 'owner' })
	const probe = createServer()
	await new Promise<void>((done, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', () => done()) })
	const { port } = probe.address() as AddressInfo
	await new Promise<void>((done, fail) => probe.close(error => error ? fail(error) : done()))
	const server = spawn(process.execPath, [resolve(process.cwd(), '.output/server/index.mjs')], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), UIUX_WORKSPACE_ROOT: root, UIUX_PACKAGE_ROOT: process.cwd() },
	})
	servers.push(server)
	let output = ''
	server.stdout?.setEncoding('utf8').on('data', chunk => { output += chunk })
	server.stderr?.setEncoding('utf8').on('data', chunk => { output += chunk })
	const origin = `http://127.0.0.1:${port}`
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		if (server.exitCode !== null) throw new Error(`The test server exited before it was ready:\n${output}`)
		try {
			if ((await fetch(`${origin}/api/health`)).status === 200) return { origin, cookie: await sessionCookieFor(origin, token) }
		}
		catch { await new Promise(done => setTimeout(done, 100)) }
	}
	throw new Error(`The test server was not ready in time:\n${output}`)
}

describe('formal UX Flow Evidence over a real capture', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('captures each entered View and Variant and stores a trace that references the captures', async () => {
		const root = await mkdtemp(join(tmpdir(), 'uiux-flow-trace-'))
		roots.push(root)
		await writeCurrentWorkspace(root, {
			i18n: { defaultLocale: 'en-US' },
			adapters: [],
			viewports: { desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } } },
			themes: { light: { label: 'Light' } },
		})
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await persistence.locales.create('en-US', {})
		await persistence.views.create(VIEW_A, view(VIEW_A, 'First'))
		await persistence.views.create(VIEW_B, view(VIEW_B, 'Second'))
		await persistence.flows.create(FLOW_ID, flow)
		const server = await startServer(root)
		const app = createWorkspaceApplicationSession(persistence, { serverOrigin: server.origin, captureCookie: () => server.cookie })

		const renderContext = { locale: 'en-US', viewportId: 'desktop', themeId: 'light' }
		const outcome = await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext })
		expect(outcome.status, JSON.stringify(outcome)).toBe('captured')
		if (outcome.status !== 'captured') return

		// One formal capture per distinct View and Variant the recipe enters.
		expect(outcome.captures.map(capture => [capture.viewId, capture.variantName])).toEqual([[VIEW_A, undefined], [VIEW_B, 'done']])
		const record = JSON.parse(Buffer.from((await persistence.artifacts.read(outcome.evidenceDigest))!).toString('utf8'))
		expect(record).toEqual(JSON.parse(JSON.stringify(outcome.evidence)))
		expect(validateFormalEvidenceRecord(record).diagnostics).toEqual([])
		expect(record).toMatchObject({
			schemaVersion: 1,
			kind: 'flow_trace',
			executionContext: { flowId: FLOW_ID, ...renderContext },
			coverage: { complete: true },
			artifactRefs: [],
		})
		expect(record.data.steps).toEqual([
			{ stepId: STEP_A, viewId: VIEW_A, trigger: { widgetId: 'root', event: 'press' }, resultStepId: STEP_B, valid: true, captureRef: outcome.captures[0]!.evidenceDigest },
			{ stepId: STEP_B, viewId: VIEW_B, variantName: 'done', valid: true, captureRef: outcome.captures[1]!.evidenceDigest },
		])
		expect(record.data.recipe.actions.map((action: { type: string, stepId: string }) => [action.type, action.stepId])).toEqual([['enter', STEP_A], ['trigger', STEP_A], ['enter', STEP_B]])
		expect(record.evidenceRefs).toEqual(outcome.captures.map(capture => ({ kind: 'formal_capture', evidence: capture.evidenceDigest })).sort((a, b) => a.evidence.localeCompare(b.evidence)))
		expect(record.provenance.resources).toEqual(expect.arrayContaining([
			expect.objectContaining({ identity: { type: 'flow', id: FLOW_ID } }),
			expect.objectContaining({ identity: { type: 'view', id: VIEW_A } }),
			expect.objectContaining({ identity: { type: 'view', id: VIEW_B } }),
		]))
		// Each referenced capture is a stored formal capture of that View and Variant, with its screenshot.
		for (const capture of outcome.captures) {
			const stored = JSON.parse(Buffer.from((await persistence.artifacts.read(capture.evidenceDigest))!).toString('utf8'))
			expect(stored).toMatchObject({ kind: 'formal_capture', executionContext: { viewId: capture.viewId }, artifactRefs: [capture.screenshotDigest] })
			expect(await persistence.artifacts.read(capture.screenshotDigest)).toBeDefined()
		}

		// The stored recipe replays to a trace of the same steps (a screenshot of a page may differ in bytes between runs, so the captures' identities are not compared).
		const again = await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext, recipe: record.data.recipe })
		expect(again.status).toBe('captured')
		if (again.status === 'captured') {
			expect(again.evidence.data?.recipe).toEqual(record.data.recipe)
			const withoutCaptures = (steps: Array<Record<string, unknown>>) => steps.map(step => Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'captureRef')))
			expect(withoutCaptures(again.evidence.data?.steps as Array<Record<string, unknown>>)).toEqual(withoutCaptures(record.data.steps))
		}
		const narrower = await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext, recipe: { actions: [record.data.recipe.actions[0]] } })
		expect(narrower).toMatchObject({ status: 'captured' })
		if (narrower.status === 'captured') {
			expect(narrower.evidenceDigest).not.toBe(outcome.evidenceDigest)
			expect(narrower.captures).toHaveLength(1)
		}

		// An unknown Locale is the caller's render context, refused before anything is recorded.
		expect(await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext: { ...renderContext, locale: 'fr-FR' } })).toMatchObject({ status: 'invalid' })
	})
})
