import { describe, expect, it, vi } from 'vitest'

import { measureRenderedContentBoxQuad } from '../src/preview/rendered-content-quad'

function elementWith(getBoxQuads?: (...args: unknown[]) => Iterable<unknown>): Element {
	return { ...(getBoxQuads ? { getBoxQuads } : {}) } as unknown as Element
}

const quad = {
	p1: { x: 10, y: 20 },
	p2: { x: 210, y: 40 },
	p3: { x: 190, y: 180 },
	p4: { x: -10, y: 160 },
}

describe('rendered iframe content-box quad measurement', () => {
	it('fails closed when no reliable quad API is available instead of consulting a bounding box', () => {
		const element = { getBoundingClientRect: vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 })) } as unknown as Element
		expect(measureRenderedContentBoxQuad(element)).toEqual({ status: 'unavailable', reason: 'api-unavailable' })
		expect(element.getBoundingClientRect).not.toHaveBeenCalled()
	})

	it('requests the actual content box and returns all four rendered corners', () => {
		const getBoxQuads = vi.fn(() => [quad])
		expect(measureRenderedContentBoxQuad(elementWith(getBoxQuads))).toEqual({
			status: 'available',
			quad,
		})
		expect(getBoxQuads).toHaveBeenCalledWith({ box: 'content' })
	})

	it('preserves non-axis-aligned quad geometry rather than reducing it to bounds', () => {
		const result = measureRenderedContentBoxQuad(elementWith(() => [quad]))
		expect(result.status).toBe('available')
		if (result.status !== 'available') return
		expect(result.quad.p1).toEqual({ x: 10, y: 20 })
		expect(result.quad.p2).toEqual({ x: 210, y: 40 })
		expect(result.quad.p3).toEqual({ x: 190, y: 180 })
		expect(result.quad.p4).toEqual({ x: -10, y: 160 })
	})

	it('rejects zero or multiple returned fragments as ambiguous for one iframe content viewport', () => {
		expect(measureRenderedContentBoxQuad(elementWith(() => []))).toEqual({ status: 'unavailable', reason: 'ambiguous-fragments' })
		expect(measureRenderedContentBoxQuad(elementWith(() => [quad, quad]))).toEqual({ status: 'unavailable', reason: 'ambiguous-fragments' })
	})

	it('rejects non-finite rendered corner coordinates', () => {
		expect(measureRenderedContentBoxQuad(elementWith(() => [{ ...quad, p3: { x: Number.POSITIVE_INFINITY, y: 2 } }]))).toEqual({
			status: 'unavailable', reason: 'invalid-geometry',
		})
	})

	it('treats browser measurement exceptions as unavailable without substituting a heuristic', () => {
		const getBoxQuads = () => { throw new Error('browser refused geometry') }
		expect(measureRenderedContentBoxQuad(elementWith(getBoxQuads))).toEqual({ status: 'unavailable', reason: 'measurement-failed' })
	})

	it('owns a defensive copy of browser-returned point objects', () => {
		const mutable = structuredClone(quad)
		const result = measureRenderedContentBoxQuad(elementWith(() => [mutable]))
		expect(result.status).toBe('available')
		mutable.p1.x = 999
		if (result.status === 'available') expect(result.quad.p1.x).toBe(10)
	})
})
