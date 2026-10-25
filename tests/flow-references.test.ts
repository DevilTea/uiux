import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { flowReferenceDiagnostics } from '../src/domain/flows/references'
import type { FlowResource } from '../src/domain/flows/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createCurrentWorkspace } from './support/workspace-layout'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const GONE_VIEW_ID = '99999999-9999-4999-8999-999999999999'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY = '44444444-4444-4444-8444-444444444444'
const SECOND = '55555555-5555-4555-8555-555555555555'
const THIRD = '66666666-6666-4666-8666-666666666666'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const view = (variants: readonly string[], widgets: readonly string[]) => ({ variantNames: new Set(variants), widgetIds: new Set(widgets) })

describe('Flow reference diagnostics (Rule 01a11544-629c-7dbf-8e41-36c8e37537b3)', () => {
	it('reports a missing View, Variant and Widget at the reference path and keeps a valid reference silent', async () => {
		const flow = {
			id: FLOW_ID,
			name: 'Refs',
			entryStepId: ENTRY,
			steps: {
				[ENTRY]: { target: { viewId: VIEW_ID, variantName: 'loading' }, transitions: [{ trigger: { widgetId: 'ghost', event: 'press' }, targetStepId: SECOND }, { trigger: { widgetId: 'go', event: 'undeclared' }, targetStepId: SECOND }] },
				[SECOND]: { target: { viewId: GONE_VIEW_ID, variantName: 'x' }, transitions: [{ trigger: { widgetId: 'nothing', event: 'press' }, targetStepId: ENTRY }] },
			},
		}
		const diagnostics = await flowReferenceDiagnostics(flow, async id => id === VIEW_ID ? view(['empty'], ['root', 'go']) : null)
		expect(diagnostics.map(d => [d.code, d.path])).toEqual([
			['flow.missing_variant', `/steps/${ENTRY}/target/variantName`],
			['flow.missing_widget', `/steps/${ENTRY}/transitions/0/trigger/widgetId`],
			['flow.missing_view', `/steps/${SECOND}/target/viewId`],
		])
		expect(flow.steps[ENTRY].target.variantName).toBe('loading')
	})

	it('does not conclude what is unknown, and never checks an Event name', async () => {
		const flow = { steps: { [ENTRY]: { target: { viewId: VIEW_ID, variantName: 'anything' }, transitions: [{ trigger: { widgetId: 'w', event: 'whatever' }, targetStepId: ENTRY }] } } }
		expect(await flowReferenceDiagnostics(flow, async () => ({}))).toEqual([])
		expect(await flowReferenceDiagnostics(flow, async () => view(['anything'], ['w']))).toEqual([])
	})

	it('skips what a Flow read with diagnostics holds in the wrong shape', async () => {
		const never = async () => { throw new Error('no View lookup expected') }
		expect(await flowReferenceDiagnostics(undefined, never)).toEqual([])
		expect(await flowReferenceDiagnostics({ steps: [] }, never)).toEqual([])
		expect(await flowReferenceDiagnostics({ steps: { [ENTRY]: null, [SECOND]: { target: { viewId: 'nope' } }, [THIRD]: { target: 7 } } }, never)).toEqual([])
	})
})

describe('Flow reads report reference diagnostics', () => {
	it('adds them to the point read and the list diagnostic count without changing the Flow', async () => {
		const { app, persistence } = await seededSession()
		const flow: FlowResource = {
			id: FLOW_ID,
			name: 'Dangling',
			entryStepId: ENTRY,
			steps: {
				[ENTRY]: { target: { viewId: VIEW_ID, variantName: 'nope' }, transitions: [{ trigger: { widgetId: 'ghost', event: 'press' }, targetStepId: SECOND }, { trigger: { widgetId: 'root', event: 'press' }, targetStepId: SECOND }] },
				[SECOND]: { target: { viewId: GONE_VIEW_ID }, transitions: [] },
			},
		}
		await persistence.flows.create(FLOW_ID, flow)

		const read = await app.readPointResource('flow', FLOW_ID)
		expect(read?.diagnostics.map(d => d.code).sort()).toEqual(['flow.missing_variant', 'flow.missing_view', 'flow.missing_widget'])
		expect(read?.resource).toEqual(flow)

		const listed = await app.listPointResources({ kinds: ['flow'], limit: 10 })
		expect(listed.status).toBe('ok')
		if (listed.status === 'ok') expect(listed.page.items.find(item => item.key === FLOW_ID)?.diagnosticCount).toBe(3)
	})

	it('reports no diagnostics for a Flow whose references exist', async () => {
		const { app, persistence } = await seededSession()
		await persistence.flows.create(FLOW_ID, { id: FLOW_ID, name: 'Fine', entryStepId: ENTRY, steps: { [ENTRY]: { target: { viewId: VIEW_ID }, transitions: [{ trigger: { widgetId: 'root', event: 'anything' }, targetStepId: ENTRY }] } } })
		expect((await app.readPointResource('flow', FLOW_ID))?.diagnostics).toEqual([])
	})
})

async function seededSession() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-flow-references-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: { light: {} } })
	const resource: ViewResource = {
		id: VIEW_ID,
		name: 'Fixture',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
	await persistence.views.create(VIEW_ID, resource)
	await persistence.locales.create('en-US', { title: 'Title' })
	return { persistence, app: createWorkspaceApplicationSession(persistence) }
}
