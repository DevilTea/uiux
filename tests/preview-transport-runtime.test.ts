import { describe, expect, it } from 'vitest'
import {
	PREVIEW_WIRE_CHANNEL,
	PREVIEW_CONTEXT_CHANNEL,
	isPreviewTransportEnvelope,
	createInMemoryTransportPair,
} from '../src/preview/protocol/transport'
import {
	WorkbenchPreviewProtocolBridge,
	RuntimePreviewProtocolBridge,
} from '../src/preview/protocol/bridge'
import {
	collectWidgetTypesFromIr,
	materializePreviewView,
	buildRootShellAdapterBundle,
} from '../src/preview/preview-runtime'
import type { ViewResource } from '../src/domain/views/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'

const VIEW_ID = '11111111-2222-4333-8444-555555555555'

function testContext(overrides: Partial<ResolvedRenderContext> = {}): ResolvedRenderContext {
	return {
		viewId: VIEW_ID,
		locale: 'en-US',
		viewportId: 'desktop',
		viewport: { width: 1280, height: 800 },
		themeId: 'light',
		...overrides,
	}
}

describe('preview protocol transport & runtime materialization', () => {
	describe('transport envelopes', () => {
		it('recognizes valid wire, context, and highlight transport envelopes', () => {
			expect(isPreviewTransportEnvelope({
				channel: PREVIEW_WIRE_CHANNEL,
				message: {
					type: 'capability.declare',
					context: { previewSessionId: 's1', runtimeGenerationId: 'g1' },
					payload: { protocolVersion: 1, features: [] },
				},
			})).toBe(true)

			expect(isPreviewTransportEnvelope({
				channel: PREVIEW_CONTEXT_CHANNEL,
				payload: {
					viewId: VIEW_ID,
					locale: 'en-US',
					viewportId: 'desktop',
					viewport: { width: 1280, height: 800 },
					themeId: 'light',
				},
			})).toBe(true)

			// The legacy in-iframe highlight channel is retired: Workbench draws every outline.
			expect(isPreviewTransportEnvelope({
				channel: 'uiux:preview:highlight',
				payload: { widgetId: 'root' },
			})).toBe(false)

			// The ad hoc targeting channel is retired: targeting travels in the protocol envelope.
			expect(isPreviewTransportEnvelope({
				channel: 'uiux:preview:targeting',
				payload: { type: 'select', widgetId: 'root', viewId: VIEW_ID },
			})).toBe(false)

			expect(isPreviewTransportEnvelope(null)).toBe(false)
			expect(isPreviewTransportEnvelope({})).toBe(false)
			expect(isPreviewTransportEnvelope({ channel: 'unknown' })).toBe(false)
		})
	})

	describe('protocol bridge handshake over transport seam', () => {
		it('completes bidirectional handshake and transitions session to open', () => {
			const { workbenchTransport, runtimeTransport, onWorkbenchReceive, onRuntimeReceive } = createInMemoryTransportPair()

			const sessionId = 'session-test-1'
			const generationId = 'gen-test-1'

			const workbenchBridge = new WorkbenchPreviewProtocolBridge(
				sessionId,
				workbenchTransport,
				declaration => declaration.protocolVersion === 1
					? { ok: true }
					: { ok: false, reason: 'capability.unsupported_protocol_version' },
			)

			const runtimeBridge = new RuntimePreviewProtocolBridge(
				sessionId,
				generationId,
				{ protocolVersion: 1, features: ['geometry'] },
				runtimeTransport,
			)

			onWorkbenchReceive(message => {
				workbenchBridge.receive(message)
			})
			onRuntimeReceive(message => {
				runtimeBridge.receive(message)
			})

			workbenchBridge.admitGeneration(generationId, 'initial')

			expect(runtimeBridge.snapshot().ackObserved).toBe(false)
			expect(workbenchBridge.snapshot().session.currentGenerationPhase).toBe('bootstrap')

			runtimeBridge.declareCapabilities()

			expect(runtimeBridge.snapshot().ackObserved).toBe(true)
			expect(workbenchBridge.snapshot().session.currentGenerationPhase).toBe('open')
		})
	})

	describe('view runtime materialization', () => {
		it('collects all widget types from View IR recursively', () => {
			const ir = {
				id: 'root',
				type: 'RootShell',
				slots: {
					content: [
						{
							id: 'card',
							type: 'Card',
							slots: {
								inner: [{ id: 'btn', type: 'Button' }],
							},
						},
					],
				},
			}
			const types = collectWidgetTypesFromIr(ir)
			expect(types).toEqual(['RootShell', 'Card', 'Button'])
		})

		it('materializes a RootShell View into an active LiveViewRuntimeController', () => {
			const view: ViewResource = {
				id: VIEW_ID,
				name: 'RootShell View',
				ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
				variants: {},
				spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
			}
			const context = testContext()
			const result = materializePreviewView({ view, context })

			expect(result.status).toBe('ready')
			if (result.status !== 'ready') return

			const controller = result.controller
			if (!controller) throw new Error('Expected a live View runtime controller.')
			expect(controller.runtime.blueprint.root.type).toBe('RootShell')
			expect(controller.context.locale).toBe('en-US')
			controller.dispose()
		})

		it('reports adapter.materialization_unavailable when IR contains unmaterialized adapter widget types', () => {
			const view: ViewResource = {
				id: VIEW_ID,
				name: 'External Adapter View',
				ir: {
					type: 'RootShell',
					id: 'root',
					slots: {
						content: [
							{ id: 'counter-1', type: 'Counter' },
							{ id: 'slider-1', type: 'Slider' },
						],
					},
				},
				variants: {},
				spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
			}
			const context = testContext()
			const result = materializePreviewView({ view, context })

			expect(result.status).toBe('adapter_unavailable')
			if (result.status !== 'adapter_unavailable') return

			expect(result.unsupportedTypes).toEqual(['Counter', 'Slider'])
			expect(result.diagnostics).toHaveLength(1)
			expect(result.diagnostics[0]?.code).toBe('adapter.materialization_unavailable')
			expect(result.diagnostics[0]?.message).toContain('server-to-browser module transport contract')
		})

		it('builds a functioning RootShell adapter bundle', () => {
			const result = buildRootShellAdapterBundle('en-US')
			expect(result.state).toBe('ready')
			if (result.state !== 'ready') return
			const bundle = result.bundle
			expect(bundle.pluginsByType.has('RootShell')).toBe(true)
			expect(bundle.renderer).toBeDefined()
			expect(bundle.system).toBeDefined()
		})
	})
})
