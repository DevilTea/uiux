import { describe, expect, it, vi } from 'vitest'
import { measureAxisAlignedContentBoxQuad, measureContentBoxQuad } from '../src/preview/axis-aligned-content-quad'
import { deriveOuterMapping } from '../src/preview/derived-outer-mapping'

type Style = Record<string, string>
type Fake = { parentElement: Fake | null; offsetWidth: number; offsetHeight: number; style: Style; getBoundingClientRect: () => { left: number; top: number; width: number; height: number } }

/** A fake iframe inside a chain of ancestors whose computed styles the test controls. */
function chain(ancestorStyles: Style[], ownStyle: Style = {}, rect = { left: 100, top: 50, width: 640, height: 400 }, size = { width: 1280, height: 800 }): Fake {
	let parent: Fake | null = null
	for (const style of [...ancestorStyles].reverse()) {
		parent = { parentElement: parent, offsetWidth: 0, offsetHeight: 0, style, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }
	}
	return { parentElement: parent, offsetWidth: size.width, offsetHeight: size.height, style: ownStyle, getBoundingClientRect: () => rect }
}
const deps = { getComputedStyle: (element: unknown) => (element as Fake).style }

describe('axis-aligned outer mapping proof (engines without getBoxQuads)', () => {
	it('derives the exact quad for a uniformly scaled, translated frame', () => {
		const element = chain([{ transform: 'matrix(0.5, 0, 0, 0.5, 0, 0)' }, { transform: 'none' }])
		const result = measureAxisAlignedContentBoxQuad(element, deps)
		expect(result).toEqual({
			status: 'available',
			source: 'axis-aligned-proof',
			quad: { p1: { x: 100, y: 50 }, p2: { x: 740, y: 50 }, p3: { x: 740, y: 450 }, p4: { x: 100, y: 450 } },
		})
		if (result.status !== 'available') return
		const mapping = deriveOuterMapping({ width: 1280, height: 800 }, result.quad)
		expect(mapping).toMatchObject({ status: 'affine', mapping: { a: 0.5, b: 0, c: 0, d: 0.5, e: 100, f: 50 } })
	})

	it('insets the border and padding, scaled, to reach the content box', () => {
		const element = chain([], { borderLeftWidth: '2px', borderTopWidth: '2px', borderRightWidth: '2px', borderBottomWidth: '2px', paddingLeft: '4px' }, { left: 0, top: 0, width: 642, height: 402 }, { width: 1284, height: 804 })
		const result = measureAxisAlignedContentBoxQuad(element, deps)
		expect(result.status).toBe('available')
		if (result.status !== 'available') return
		expect(result.quad.p1).toEqual({ x: 3, y: 1 })
		expect(result.quad.p3).toEqual({ x: 641, y: 401 })
	})

	it.each([
		['a rotation', { transform: 'matrix(0.866, 0.5, -0.5, 0.866, 0, 0)' }, 'non-axis-aligned-transform'],
		['a skew', { transform: 'matrix(1, 0, 0.3, 1, 0, 0)' }, 'non-axis-aligned-transform'],
		['a flip', { transform: 'matrix(-1, 0, 0, 1, 0, 0)' }, 'non-axis-aligned-transform'],
		['a nonuniform scale', { transform: 'matrix(0.5, 0, 0, 0.75, 0, 0)' }, 'nonuniform-scale'],
		['a 3D transform', { transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)' }, 'three-dimensional-transform'],
		['the rotate property', { rotate: '15deg' }, 'non-axis-aligned-transform'],
		['a nonuniform scale property', { scale: '1 2' }, 'nonuniform-scale'],
		['a motion path', { offsetPath: 'path("M0 0 L10 10")' }, 'motion-path'],
	])('fails closed on %s anywhere in the ancestor chain', (_label, style, reason) => {
		const rect = vi.fn(() => ({ left: 0, top: 0, width: 640, height: 400 }))
		const element = chain([{ transform: 'none' }, style as Style])
		element.getBoundingClientRect = rect
		expect(measureAxisAlignedContentBoxQuad(element, deps)).toEqual({ status: 'unavailable', reason })
		// No bounding box is consulted once the proof fails.
		expect(rect).not.toHaveBeenCalled()
	})

	it('accepts identity rotate and uniform scale properties', () => {
		const element = chain([{ rotate: '0deg', scale: '0.5' }], {}, { left: 0, top: 0, width: 640, height: 400 })
		expect(measureAxisAlignedContentBoxQuad(element, deps).status).toBe('available')
	})

	it('rejects a measured box whose aspect disagrees with the layout box (an unproven transform)', () => {
		const element = chain([], {}, { left: 0, top: 0, width: 640, height: 300 })
		expect(measureAxisAlignedContentBoxQuad(element, deps)).toEqual({ status: 'unavailable', reason: 'nonuniform-scale' })
	})

	it('reports an empty or detached element as unavailable', () => {
		expect(measureAxisAlignedContentBoxQuad(chain([], {}, undefined, { width: 0, height: 0 }), deps)).toEqual({ status: 'unavailable', reason: 'empty-box' })
		expect(measureAxisAlignedContentBoxQuad(chain([], {}, { left: 0, top: 0, width: 0, height: 0 }), deps)).toEqual({ status: 'unavailable', reason: 'detached' })
	})

	it('prefers the browser quad API when it exists', () => {
		const quad = { p1: { x: 10, y: 20 }, p2: { x: 210, y: 40 }, p3: { x: 190, y: 180 }, p4: { x: -10, y: 160 } }
		const element = { getBoxQuads: () => [quad] } as unknown as Element
		expect(measureContentBoxQuad(element)).toEqual({ status: 'available', quad, source: 'box-quads' })
	})
})
