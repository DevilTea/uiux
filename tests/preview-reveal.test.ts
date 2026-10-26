import { describe, expect, it } from 'vitest'

import { declaredRuntimeFeatures } from '../src/preview/declared-features'
import { GeometryStreamCoordinator, type GeometryDemand, type GeometryStreamContext } from '../src/preview/geometry-streams'
import { nearestScrollDelta } from '../src/preview/reveal'
import {
	REVEAL_GEOMETRY_FEATURE,
	type GeometryAcquireRequest,
	type GeometryReleaseRequest,
	type GeometryRevealRequest,
} from '../src/preview/protocol/schema'

/**
 * Issue #105: the Workbench side of `geometry.reveal` (Clause 01a11a59-d8be-78aa-bdc7-28aa62bd9444,
 * Rules 01a11a59-e876-780b-832c-0a139baabc95 and 01a11a59-ea08-74ff-8a88-6e70b4fa3a84) and the
 * arithmetic of the runtime's scroll (Clause 01a11a70-3d8d-7e52-9412-8a92797814e6). The DOM side of
 * the scroll, and the navigation itself, are covered in tests/geometry-reveal-browser.test.ts.
 */

const viewId = '11111111-1111-4111-8111-111111111111'
const base: GeometryStreamContext = { previewSessionId: 's', runtimeGenerationId: 'g1', viewId }
type Sent = GeometryAcquireRequest | GeometryReleaseRequest | GeometryRevealRequest

function coordinator(options: { reveal?: boolean; ready?: boolean; reject?: boolean } = {}) {
	const sent: Sent[] = []
	let next = 0
	const streams = new GeometryStreamCoordinator({
		send: (message) => { sent.push(message) },
		sendReveal: (message) => {
			if (options.reject) return false
			sent.push(message)
			return true
		},
		mintId: () => `id-${++next}`,
	})
	streams.setContext(base)
	streams.setMultiTarget(true)
	streams.setRevealSupported(options.reveal ?? true)
	streams.setReady(options.ready ?? true)
	return { streams, sent }
}

const highlight = (widgetId: string, navigationRequestId: string): GeometryDemand => ({
	consumerId: 'selection', widgetId, tier: 'highlight', navigationRequestId,
})

describe('the Workbench sends geometry.reveal on an open stream', () => {
	it('sends one reveal right after the stream opens, on the stream context with an empty payload and no geometryRevision', () => {
		const { streams, sent } = coordinator()
		streams.setDemand([highlight('a', 'nav-1')])
		expect(sent.map(message => message.type)).toEqual(['geometry.acquire.request'])
		expect(streams.reveal('a', 'nav-1')).toBe(true)
		expect(sent.at(-1)).toEqual({
			type: 'geometry.reveal',
			context: { previewSessionId: 's', runtimeGenerationId: 'g1', viewId, navigationRequestId: 'nav-1', widgetId: 'a' },
			payload: {},
		})
		expect(sent.at(-1)!.context).not.toHaveProperty('geometryRevision')
		// It opens no stream and releases none.
		expect(sent.map(message => message.type)).toEqual(['geometry.acquire.request', 'geometry.reveal'])
		expect(streams.snapshot().streams).toEqual([{ widgetId: 'a', navigationRequestId: 'nav-1' }])
	})

	it('sends nothing for a runtime that did not declare the feature', () => {
		const { streams, sent } = coordinator({ reveal: false })
		streams.setDemand([highlight('a', 'nav-1')])
		expect(streams.reveal('a', 'nav-1')).toBe(false)
		expect(sent.map(message => message.type)).toEqual(['geometry.acquire.request'])
	})

	it('names only the open stream of the Widget: another or superseded identity, an unknown Widget or a closed gate sends nothing', () => {
		const { streams, sent } = coordinator()
		streams.setDemand([highlight('a', 'nav-1')])
		expect(streams.reveal('b', 'nav-1')).toBe(false)
		expect(streams.reveal('a', 'other')).toBe(false)
		streams.setDemand([highlight('a', 'nav-2')])
		expect(streams.reveal('a', 'nav-1')).toBe(false)
		streams.setReady(false)
		expect(streams.reveal('a', 'nav-2')).toBe(false)
		expect(sent.filter(message => message.type === 'geometry.reveal')).toEqual([])
	})

	it('reports a reveal that the bridge did not send as unsent, so the request is kept', () => {
		const { streams, sent } = coordinator({ reject: true })
		streams.setDemand([highlight('a', 'nav-1')])
		expect(streams.reveal('a', 'nav-1')).toBe(false)
		expect(sent.filter(message => message.type === 'geometry.reveal')).toEqual([])
	})

	it('is never sent by stream lifecycle: reopening, superseding and a context change open streams without a reveal', () => {
		const { streams, sent } = coordinator()
		streams.setDemand([highlight('a', 'nav-1')])
		streams.setDemand([highlight('a', 'nav-2')])
		streams.setContext({ ...base, variantId: 'compact' })
		streams.setDemand([{ consumerId: 'pin:t', widgetId: 'a', tier: 'pin' }])
		streams.invalidateContentBox()
		expect(sent.filter(message => message.type === 'geometry.reveal')).toEqual([])
	})
})

describe('geometry.reveal is a feature of a Workbench Preview', () => {
	it('is declared for a Workbench Preview, and not for the formal capture harness or a version frame', () => {
		expect(declaredRuntimeFeatures({ harness: false, version: false })).toContain(REVEAL_GEOMETRY_FEATURE)
		expect(declaredRuntimeFeatures({ harness: true, version: false })).not.toContain(REVEAL_GEOMETRY_FEATURE)
		expect(declaredRuntimeFeatures({ harness: false, version: true })).not.toContain(REVEAL_GEOMETRY_FEATURE)
	})
})

describe('the least movement that brings a box into view', () => {
	it('needs none for a box already inside the visible interval', () => {
		expect(nearestScrollDelta(10, 50, 0, 100)).toBe(0)
		expect(nearestScrollDelta(0, 100, 0, 100)).toBe(0)
	})

	it('aligns the nearest edge: a box below scrolls forward until its end shows, a box above scrolls back until its start shows', () => {
		expect(nearestScrollDelta(500, 540, 0, 100)).toBe(440)
		expect(nearestScrollDelta(-300, -260, 0, 100)).toBe(-300)
		expect(nearestScrollDelta(90, 140, 0, 100)).toBe(40)
		expect(nearestScrollDelta(-30, 20, 0, 100)).toBe(-30)
	})

	it('aligns the edge nearest to the area for a box larger than it: the start of one below, the end of one above', () => {
		expect(nearestScrollDelta(500, 900, 0, 100)).toBe(500)
		expect(nearestScrollDelta(-900, -500, 0, 100)).toBe(-600)
		// A box that covers the whole area leaves it where it is.
		expect(nearestScrollDelta(-50, 300, 0, 100)).toBe(0)
	})
})
