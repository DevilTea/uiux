import { describe, expect, it, vi } from 'vitest'

import {
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	type BridgeReceiveResult,
} from '../src/preview/protocol/bridge'
import {
	createPreviewProtocolMessagePortTransport,
	subscribePreviewProtocolMessagePort,
} from '../src/preview/protocol/message-port'
import type {
	GeometryAcquireResponse,
} from '../src/preview/protocol/schema'

const compatible = { ok: true } as const
const declaration = { protocolVersion: 1, features: ['geometry', 'contour'] } as const

describe('Preview MessagePort channel integration', () => {
	it('round-trips capability handshake and geometry through the channel instead of bypassing the bridge', async () => {
		const channel = new MessageChannel()
		const workbenchResults: BridgeReceiveResult[] = []
		const runtimeResults: BridgeReceiveResult[] = []
		const workbench = new WorkbenchPreviewProtocolBridge(
			'session-a',
			createPreviewProtocolMessagePortTransport(channel.port1),
			() => compatible,
		)
		const runtime = new RuntimePreviewProtocolBridge(
			'session-a',
			'generation-a',
			declaration,
			createPreviewProtocolMessagePortTransport(channel.port2),
		)
		const workbenchSubscription = subscribePreviewProtocolMessagePort(
			channel.port1,
			input => workbenchResults.push(workbench.receive(input)),
		)
		const runtimeSubscription = subscribePreviewProtocolMessagePort(
			channel.port2,
			input => runtimeResults.push(runtime.receive(input)),
		)

		try {
			expect(workbench.admitGeneration('generation-a', 'initial').status).toBe('admitted')
			expect(runtime.sendGeometry(acquireResponse())).toEqual({ status: 'gated' })

			runtime.declareCapabilities()
			await waitFor(() => workbenchResults.some(result => result.status === 'ack-dispatched'))
			await waitFor(() => runtimeResults.some(result =>
				result.status === 'accepted' && result.message.type === 'capability.ack'))

			expect(runtime.snapshot().ackObserved).toBe(true)
			expect(runtime.sendGeometry(acquireResponse())).toEqual({ status: 'sent' })
			await waitFor(() => workbenchResults.some(result =>
				result.status === 'accepted' && result.message.type === 'geometry.acquire.response'))

			expect(workbenchResults.at(-1)).toMatchObject({
				status: 'accepted',
				message: { type: 'geometry.acquire.response' },
			})
		}
		finally {
			workbenchSubscription.dispose()
			runtimeSubscription.dispose()
			channel.port1.close()
			channel.port2.close()
		}
	})

	it('keeps malformed and wrong-direction channel traffic behind bridge validation', async () => {
		const channel = new MessageChannel()
		const results: BridgeReceiveResult[] = []
		const workbench = new WorkbenchPreviewProtocolBridge(
			'session-a',
			createPreviewProtocolMessagePortTransport(channel.port1),
			() => compatible,
		)
		workbench.admitGeneration('generation-a', 'initial')
		const subscription = subscribePreviewProtocolMessagePort(
			channel.port1,
			input => results.push(workbench.receive(input)),
		)

		try {
			channel.port2.postMessage({
				type: 'capability.ack',
				context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' },
				payload: {},
			})
			channel.port2.postMessage({
				type: 'capability.declare',
				context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' },
				payload: { protocolVersion: 1, features: ['geometry', 'geometry'] },
			})
			await waitFor(() => results.length === 2)

			expect(results[0]).toEqual({ status: 'wrong-direction' })
			expect(results[1]?.status).toBe('invalid')
			expect(workbench.snapshot().session).toMatchObject({ currentGenerationPhase: 'bootstrap' })
		}
		finally {
			subscription.dispose()
			channel.port1.close()
			channel.port2.close()
		}
	})

	it('starts addEventListener-based ports, detaches idempotently, and never closes caller-owned ports', () => {
		const listeners = new Set<(event: Readonly<{ data: unknown }>) => void>()
		const start = vi.fn()
		const close = vi.fn()
		const removeEventListener = vi.fn((_type: 'message', listener: (event: Readonly<{ data: unknown }>) => void) => {
			listeners.delete(listener)
		})
		const port = {
			postMessage: vi.fn(),
			addEventListener: vi.fn((_type: 'message', listener: (event: Readonly<{ data: unknown }>) => void) => {
				listeners.add(listener)
			}),
			removeEventListener,
			start,
			close,
		}
		const received: unknown[] = []
		const subscription = subscribePreviewProtocolMessagePort(port, input => received.push(input))

		expect(start).toHaveBeenCalledTimes(1)
		for (const listener of listeners) listener({ data: { hello: 'world' } })
		expect(received).toEqual([{ hello: 'world' }])

		subscription.dispose()
		subscription.dispose()
		expect(removeEventListener).toHaveBeenCalledTimes(1)
		expect(close).not.toHaveBeenCalled()
		for (const listener of listeners) listener({ data: { ignored: true } })
		expect(received).toEqual([{ hello: 'world' }])
	})

	it('propagates postMessage failures so ACK dispatch cannot falsely open the Workbench gate', () => {
		const transport = createPreviewProtocolMessagePortTransport({
			postMessage() {
				throw new Error('structured clone failed')
			},
		})
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', transport, () => compatible)
		workbench.admitGeneration('generation-a', 'initial')

		expect(() => workbench.receive({
			type: 'capability.declare',
			context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' },
			payload: declaration,
		})).toThrow('structured clone failed')
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationPhase: 'awaiting-ack' })
	})
})

function acquireResponse(): GeometryAcquireResponse {
	return {
		type: 'geometry.acquire.response',
		context: {
			previewSessionId: 'session-a',
			runtimeGenerationId: 'generation-a',
			viewId: '11111111-1111-4111-8111-111111111111',
			widgetId: 'widget-a',
			geometryRevision: 1,
		},
		payload: {
			rect: { x: 0, y: 0, width: 100, height: 50 },
			regions: [],
		},
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 1_000 })
}
