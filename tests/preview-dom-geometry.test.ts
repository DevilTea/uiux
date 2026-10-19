import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright'
import { boxShadowOutsets, filterOutsets } from '../src/preview/dom-geometry'
import type { WidgetGeometry } from '../src/preview/geometry-producer'
import { validateGeometryMessage } from '../src/preview/protocol/schema'

/**
 * The runtime DOM measurer in a real browser (Part 4 visible regions, first-version subset):
 * viewport and overflow clipping, proven opaque occluders, translucent coverage, rounded shapes,
 * and the fail-closed cases. Each fixture is a plain document at an 800 × 600 viewport.
 */

const ROOT = join(import.meta.dirname, '..')
let browser: Browser
let page: Page
let bundle: string

beforeAll(async () => {
	const result = await build({ entryPoints: [join(ROOT, 'tests/support/geometry-perf-entry.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' })
	bundle = result.outputFiles[0]!.text
	browser = await chromium.launch({ headless: true })
	page = await browser.newPage({ viewport: { width: 800, height: 600 } })
}, 60_000)

afterAll(async () => {
	await browser?.close()
})

async function measure(body: string, widgetIds: readonly string[], scroll = 0): Promise<Record<string, WidgetGeometry>> {
	await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}*{box-sizing:border-box}</style></head><body>${body}</body></html>`)
	await page.addScriptTag({ content: bundle })
	if (scroll) await page.evaluate(y => window.scrollTo(0, y), scroll)
	return page.evaluate((ids) => {
		const P = (globalThis as never as { UiuxGeometryPerf: { createDomGeometryMeasurer(options: { document: Document }): { beginPass(): void; measure(id: string): unknown; endPass(): void } } }).UiuxGeometryPerf
		const measurer = P.createDomGeometryMeasurer({ document })
		measurer.beginPass()
		const out = Object.fromEntries(ids.map(id => [id, measurer.measure(id)]))
		measurer.endPass()
		return JSON.parse(JSON.stringify(out))
	}, widgetIds)
}

type Box = Readonly<{ left: number; top: number; right: number; bottom: number }>

/** The rendered rects of the current document's `data-probe` elements, keyed by probe name. */
async function probes(): Promise<Record<string, Box>> {
	return page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('[data-probe]')).map((element) => {
		const { left, top, right, bottom } = element.getBoundingClientRect()
		return [element.getAttribute('data-probe'), { left, top, right, bottom }]
	})))
}

/** Total area of the reported regions (polygon contours, as the measurer emits them). */
function area(geometry: WidgetGeometry): number {
	let total = 0
	for (const region of geometry.regions) {
		const points = region.contour.commands.flatMap(command => 'x' in command ? [command] : [])
		let twice = 0
		for (let index = 0; index < points.length; index++) {
			const a = points[index]!
			const b = points[(index + 1) % points.length]!
			twice += a.x * b.y - b.x * a.y
		}
		total += Math.abs(twice) / 2
	}
	return total
}

/**
 * Counts the screenshot pixels inside the given boxes whose colour is not the Widget's `#eee`,
 * that is, paint that a reported visible region wrongly includes.
 */
async function foreignPixels(boxes: readonly Box[]): Promise<number> {
	const png = (await page.screenshot({ type: 'png' })).toString('base64')
	return page.evaluate(async ({ png, boxes }) => {
		const image = new Image()
		image.src = `data:image/png;base64,${png}`
		await image.decode()
		const canvas = document.createElement('canvas')
		canvas.width = image.width
		canvas.height = image.height
		const context = canvas.getContext('2d')!
		context.drawImage(image, 0, 0)
		const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
		let count = 0
		for (const box of boxes) {
			for (let y = Math.ceil(box.top); y < Math.floor(box.bottom); y++) {
				for (let x = Math.ceil(box.left); x < Math.floor(box.right); x++) {
					const index = (y * canvas.width + x) * 4
					if (pixels[index] !== 238 || pixels[index + 1] !== 238 || pixels[index + 2] !== 238) count++
				}
			}
		}
		return count
	}, { png, boxes })
}

/** Test cells 400px apart in two columns and 170px apart in rows, so no cell's paint reaches another. */
function cell(index: number): Readonly<{ left: number; top: number }> {
	return { left: (index % 2) * 400, top: Math.floor(index / 2) * 170 }
}

/** A 300 × 100 Widget in a cell, followed by an occluder placed by `LEFT`/`TOP` 100px into it. */
function cellPair(id: string, occluder: string, index: number): string {
	const { left, top } = cell(index)
	return `
		<div data-widget-id="${id}" style="position:absolute;left:${left}px;top:${top}px;width:300px;height:100px;background:#eee"></div>
		${occluder.replace('LEFT', String(left + 100)).replace('TOP', String(top))}`
}

function overlapArea(a: Box, b: Box): number {
	return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
}

/** Part 4 adversarial transform families: each must leave the Widget with `regions: []`. */
const ADVERSARIAL = [
	['rotation', 'rotate(10deg)'],
	['quarter-rotation', 'rotate(90deg)'],
	['reflection', 'scaleX(-1)'],
	['point-reflection', 'scale(-0.5)'],
	['nonuniform', 'scale(1, 2)'],
	['near-singular', 'scale(1, 0.001)'],
] as const

function bounds(geometry: WidgetGeometry) {
	return geometry.regions.map((region) => {
		const xs = region.contour.commands.flatMap(command => 'x' in command ? [command.x] : [])
		const ys = region.contour.commands.flatMap(command => 'y' in command ? [command.y] : [])
		return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys), maxError: region.maxError }
	})
}

function valid(geometry: WidgetGeometry): boolean {
	return validateGeometryMessage({
		type: 'geometry.acquire.response',
		context: { previewSessionId: 's', runtimeGenerationId: 'g', viewId: '11111111-1111-4111-8111-111111111111', navigationRequestId: 'n', widgetId: 'w', geometryRevision: 1 },
		payload: geometry,
	}).ok
}

describe('Runtime DOM measurer', () => {
	it('reports the full rect and the part surviving the content viewport', async () => {
		const result = await measure('<div style="height:2000px"><div data-widget-id="a" style="position:absolute;left:700px;top:500px;width:200px;height:200px;background:#eee"></div></div>', ['a'])
		expect(result.a!.rect).toEqual({ x: 700, y: 500, width: 200, height: 200 })
		expect(bounds(result.a!)).toEqual([{ left: 700, top: 500, right: 800, bottom: 600, maxError: 0 }])
		expect(valid(result.a!)).toBe(true)
	})

	it('reports a zero-area rect and no regions for a Widget without a rendered box', async () => {
		const result = await measure('<div data-widget-id="gone" style="display:none">x</div><div data-widget-id="collapsed" style="height:0"></div>', ['gone', 'collapsed', 'missing'])
		expect(result.gone).toEqual({ rect: { x: 0, y: 0, width: 0, height: 0 }, regions: [] })
		expect(result.missing).toEqual({ rect: { x: 0, y: 0, width: 0, height: 0 }, regions: [] })
		expect(result.collapsed!.rect.height).toBe(0)
		expect(result.collapsed!.regions).toEqual([])
	})

	it('clips by ancestor overflow on the containing-block chain only', async () => {
		const result = await measure(`
			<div style="position:relative;width:300px;height:200px;overflow:hidden;margin:20px">
				<div data-widget-id="clipped" style="width:500px;height:100px;background:#eee"></div>
				<div style="position:static;overflow:hidden;width:100px;height:50px"><div data-widget-id="escapes" style="position:absolute;left:0;top:150px;width:250px;height:100px;background:#ddd"></div></div>
			</div>`, ['clipped', 'escapes'])
		expect(bounds(result.clipped!)).toEqual([{ left: 20, top: 20, right: 320, bottom: 120, maxError: 0 }])
		// The absolute box escapes the static overflow clip but not its relative containing block.
		expect(bounds(result.escapes!)).toEqual([{ left: 20, top: 170, right: 270, bottom: 220, maxError: 0 }])
	})

	it('subtracts a proven opaque sticky header and keeps every surviving piece', async () => {
		const result = await measure(`
			<header style="position:sticky;top:0;height:60px;background:rgb(255,255,255);z-index:1"></header>
			<div style="height:2000px;padding-top:100px"><div data-widget-id="card" style="margin-left:50px;width:200px;height:200px;background:#eee"></div></div>`, ['card'], 100)
		// The card spans y 60..260 after scrolling 100px; the header covers y 0..60.
		expect(result.card!.rect).toMatchObject({ x: 50, y: 60, width: 200, height: 200 })
		expect(bounds(result.card!)).toEqual([{ left: 50, top: 60, right: 250, bottom: 260, maxError: 0 }])
		const covered = await measure(`
			<header style="position:sticky;top:0;height:60px;background:rgb(255,255,255);z-index:1"></header>
			<div style="height:2000px;padding-top:100px"><div data-widget-id="card" style="margin-left:50px;width:200px;height:200px;background:#eee"></div></div>`, ['card'], 130)
		expect(bounds(covered.card!)).toEqual([{ left: 50, top: 60, right: 250, bottom: 230, maxError: 0 }])
		expect(valid(covered.card!)).toBe(true)
	})

	it('splits a Widget into disconnected regions under an opaque positioned band', async () => {
		const result = await measure(`
			<div data-widget-id="w" style="position:absolute;left:0;top:0;width:300px;height:100px;background:#eee"></div>
			<div style="position:absolute;left:100px;top:0;width:50px;height:100px;background:rgb(0,0,0)"></div>`, ['w'])
		expect(bounds(result.w!).sort((a, b) => a.left - b.left)).toEqual([
			{ left: 0, top: 0, right: 100, bottom: 100, maxError: 0 },
			{ left: 150, top: 0, right: 300, bottom: 100, maxError: 0 },
		])
		expect(new Set(result.w!.regions.map(region => region.regionId)).size).toBe(2)
	})

	it('keeps translucent coverage and ignores elements painted below', async () => {
		const result = await measure(`
			<div data-widget-id="w" style="position:relative;z-index:2;width:300px;height:100px;background:#eee"></div>
			<div style="position:absolute;left:0;top:0;width:300px;height:100px;background:rgb(0,0,0);z-index:1"></div>
			<div data-widget-id="v" style="position:absolute;left:0;top:200px;width:300px;height:100px;background:#eee"></div>
			<div style="position:absolute;left:0;top:200px;width:300px;height:100px;background:rgba(0,0,0,0.5)"></div>`, ['w', 'v'])
		expect(bounds(result.w!)).toEqual([{ left: 0, top: 0, right: 300, bottom: 100, maxError: 0 }])
		expect(bounds(result.v!)).toEqual([{ left: 0, top: 200, right: 300, bottom: 300, maxError: 0 }])
	})

	it('emits a rounded contour with its maxError for a Widget with border radius', async () => {
		const result = await measure('<div data-widget-id="r" style="position:absolute;left:10px;top:10px;width:200px;height:100px;border-radius:16px;background:#eee"></div>', ['r'])
		const [region] = result.r!.regions
		expect(region!.maxError).toBeGreaterThan(0)
		expect(region!.maxError).toBeLessThanOrEqual(0.5)
		expect(region!.contour.commands.length).toBeGreaterThan(8)
		expect(valid(result.r!)).toBe(true)
	})

	it('fails closed for the Widget\'s own unprovable chain: rotation, filters', async () => {
		const result = await measure(`
			<div data-widget-id="rotated" style="position:absolute;left:0;top:0;width:100px;height:50px;transform:rotate(10deg);background:#eee"></div>
			<div data-widget-id="filtered" style="position:absolute;left:0;top:100px;width:100px;height:50px;filter:blur(2px);background:#eee"></div>`, ['rotated', 'filtered'])
		for (const id of ['rotated', 'filtered']) {
			expect(result[id]!.rect.width, id).toBeGreaterThan(0)
			expect(result[id]!.regions, id).toEqual([])
		}
	})

	it('cuts an undecided in-flow overlap and an image above by their bound and keeps the rest (#59)', async () => {
		// Both cases emptied the whole Widget before Discussion #241 R6.
		const result = await measure(`
			<div style="position:absolute;left:0;top:200px;width:300px">
				<div data-widget-id="flow" style="height:50px;background:#eee"></div>
				<div style="margin-top:-20px;height:50px;background:rgb(0,0,0)"></div>
			</div>
			<div data-widget-id="under-image" style="position:absolute;left:400px;top:0;width:100px;height:100px;background:#eee"></div>
			<img style="position:absolute;left:480px;top:0;width:40px;height:40px" alt="">`, ['flow', 'under-image'])
		expect(bounds(result.flow!)).toEqual([{ left: 0, top: 200, right: 300, bottom: 230, maxError: 0 }])
		expect(bounds(result['under-image']!)).toEqual([{ left: 400, top: 0, right: 500, bottom: 100, maxError: 0 }])
		expect(area(result['under-image']!)).toBe(100 * 100 - 20 * 40)
		expect(valid(result.flow!) && valid(result['under-image']!)).toBe(true)
	})

	it('cuts occluders of unproven shape by their box: rounded corners, clip paths, SVG clip paths, masks, blend modes, SVG and native controls', async () => {
		const occluders = [
			['rounded', 'div', 'border-radius:20px;background:rgb(0,0,0)'],
			['clip-circle', 'div', 'clip-path:circle(50%);background:rgb(0,0,0)'],
			['clip-inset-round', 'div', 'clip-path:inset(0 round 10px);background:rgb(0,0,0)'],
			['svg-clip-path', 'div', 'clip-path:url(#clip);background:rgb(0,0,0)'],
			['mask', 'div', 'mask-image:linear-gradient(black, transparent);-webkit-mask-image:linear-gradient(black, transparent);background:rgb(0,0,0)'],
			['blend', 'div', 'mix-blend-mode:multiply;background:rgb(0,0,0)'],
			['svg', 'svg', ''],
			['button', 'button', ''],
		] as const
		const at = (index: number) => ({ left: (index % 2) * 400, top: Math.floor(index / 2) * 110 })
		const body = `<svg width="0" height="0" style="position:absolute"><clipPath id="clip"><circle cx="25" cy="50" r="20"></circle></clipPath></svg>` + occluders.map(([id, tag, style], index) => `
			<div data-widget-id="${id}" style="position:absolute;left:${at(index).left}px;top:${at(index).top}px;width:300px;height:100px;background:#eee"></div>
			<${tag} style="position:absolute;left:${at(index).left + 100}px;top:${at(index).top}px;width:50px;height:100px;margin:0;padding:0;border:0;${style}"></${tag}>`).join('')
		const result = await measure(body, occluders.map(([id]) => id))
		occluders.forEach(([id], index) => {
			const { left, top } = at(index)
			expect(bounds(result[id]!).sort((a, b) => a.left - b.left), id).toEqual([
				{ left, top, right: left + 100, bottom: top + 100, maxError: 0 },
				{ left: left + 150, top, right: left + 300, bottom: top + 100, maxError: 0 },
			])
			expect(valid(result[id]!), id).toBe(true)
		})
	})

	it('grows the cut by filter extents, outer shadows and outlines, its own and its ancestors\'', async () => {
		const occluders = [
			['blur', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;filter:blur(5px);background:rgb(0,0,0)"></div>'],
			['drop-shadow', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;filter:drop-shadow(rgb(0,0,0) 20px 0px 0px);background:rgb(0,0,0)"></div>'],
			['ancestor-blur', '<div style="position:absolute;left:LEFTpx;top:TOPpx;filter:blur(2px)"><div style="width:50px;height:100px;background:rgb(0,0,0)"></div></div>'],
			['image-shadow', '<img alt="" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;box-shadow:10px 0 12px 5px rgb(0,0,0)">'],
			['image-outline', '<img alt="" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;outline:4px solid rgb(0,0,0);outline-offset:2px">'],
		] as const
		const body = occluders.map(([id, html], index) => cellPair(id, html, index)).join('')
		const result = await measure(body, occluders.map(([id]) => id))
		const pieces = (id: string) => {
			const { left } = cell(occluders.findIndex(([name]) => name === id))
			return bounds(result[id]!).sort((a, b) => a.left - b.left).map(piece => [piece.left - left, piece.right - left])
		}
		// blur(5px) paints about 15px around the box; the cut reaches at least that far.
		const [left, right] = pieces('blur')
		expect(left![0]).toBe(0)
		expect(left![1]).toBeGreaterThan(0)
		expect(left![1]).toBeLessThanOrEqual(85)
		expect(right![0]).toBeGreaterThanOrEqual(165)
		expect(right![1]).toBe(300)
		expect(pieces('drop-shadow')).toEqual([[0, 100], [170, 300]])
		const [ancestorLeft, ancestorRight] = pieces('ancestor-blur')
		expect(ancestorLeft![1]).toBeLessThanOrEqual(94)
		expect(ancestorRight![0]).toBeGreaterThanOrEqual(156)
		// The shadow reaches 5 + 2·12 + 2 = 31px around the box, shifted 10px to the right.
		expect(pieces('image-shadow')).toEqual([[0, 79], [191, 300]])
		expect(pieces('image-outline')).toEqual([[0, 94], [156, 300]])
		// Over-approximation, checked against the rendering: no reported pixel shows occluder paint.
		for (const [id] of occluders) expect(await foreignPixels(bounds(result[id]!)), id).toBe(0)
	})

	it('still fails closed for occluder paint without a finite bound', async () => {
		const occluders = [
			['svg-filter', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;filter:url(#flood);background:rgb(0,0,0)"></div>'],
			['image-overflow', '<img alt="" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;overflow:visible;object-fit:none">'],
			['three-d', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;transform:rotateX(30deg);background:rgb(0,0,0)"></div>'],
			['reflection', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;-webkit-box-reflect:right 0px;background:rgb(0,0,0)"></div>'],
		] as const
		const body = `<svg width="0" height="0" style="position:absolute"><filter id="flood" x="-10" y="-10" width="20" height="20"><feFlood flood-color="black"></feFlood></filter></svg>` + occluders.map(([id, html], index) => cellPair(id, html, index)).join('')
		const result = await measure(body, occluders.map(([id]) => id))
		for (const [id] of occluders) {
			expect(result[id]!.rect.width, id).toBeGreaterThan(0)
			expect(result[id]!.regions, id).toEqual([])
		}
	})

	it('fails closed for every adversarial transform family on the Widget and cuts an occluder by its transformed box', async () => {
		const body = ADVERSARIAL.map(([id, transform], index) => `
			<div data-widget-id="own-${id}" style="position:absolute;left:0;top:${index * 90}px;width:200px;height:60px;transform:${transform};background:#eee"></div>
			<div data-widget-id="under-${id}" style="position:absolute;left:400px;top:${index * 90}px;width:200px;height:60px;background:#eee"></div>
			<div data-probe="${id}" style="position:absolute;left:575px;top:${index * 90 + 20}px;width:50px;height:20px;transform:${transform};background:rgb(0,0,0)"></div>`).join('')
		const ids = ADVERSARIAL.flatMap(([id]) => [`own-${id}`, `under-${id}`])
		const result = await measure(body, ids)
		const occluders = await probes()
		ADVERSARIAL.forEach(([id], index) => {
			expect(result[`own-${id}`]!.rect.width, id).toBeGreaterThan(0)
			expect(result[`own-${id}`]!.regions, id).toEqual([])
			// The occluder straddles the Widget's right edge, so its cut is a notch, never a hole.
			const widget = { left: 400, top: index * 90, right: 600, bottom: index * 90 + 60 }
			expect(result[`under-${id}`]!.regions.length, id).toBeGreaterThan(0)
			expect(area(result[`under-${id}`]!), id).toBeCloseTo(200 * 60 - overlapArea(occluders[id]!, widget), 3)
		})
	})

	it('follows the flat tree into the shadow tree a Widget is slotted into', async () => {
		const host = (top: number, transform: string, widget: string) => `
			<div style="position:absolute;left:0;top:${top}px;width:400px">
				<template shadowrootmode="open"><div style="transform-origin:0 0;transform:${transform}"><slot></slot></div></template>
				<div data-widget-id="${widget}" style="width:200px;height:50px;background:#eee"></div>
			</div>`
		const body = ADVERSARIAL.map(([id, transform], index) => host(index * 80, transform, id)).join('') + host(500, 'translate(10px, 0) scale(0.5)', 'uniform')
		const result = await measure(body, [...ADVERSARIAL.map(([id]) => id), 'uniform'])
		// A parentElement-only walk sees only the untransformed host and would report the bounding box.
		for (const [id] of ADVERSARIAL) {
			expect(result[id]!.rect.width, id).toBeGreaterThan(0)
			expect(result[id]!.regions, id).toEqual([])
		}
		// Translation plus uniform scale inside the shadow tree is still inside the exact subset.
		expect(bounds(result.uniform!)).toEqual([{ left: 10, top: 500, right: 110, bottom: 525, maxError: 0 }])
	})

	it('cuts an occluder slotted into a transformed shadow tree by its transformed box', async () => {
		const pair = (index: number, transform: string, widget: string) => {
			const left = (index % 3) * 260
			const top = Math.floor(index / 3) * 150
			return `
			<div data-widget-id="${widget}" style="position:absolute;left:${left}px;top:${top}px;width:200px;height:100px;background:#eee"></div>
			<div style="position:absolute;left:${left + 100}px;top:${top}px;width:150px;z-index:1">
				<template shadowrootmode="open"><div style="transform:${transform}"><slot></slot></div></template>
				<div data-probe="${widget}" style="height:100px;background:rgb(0,0,0)"></div>
			</div>`
		}
		const body = ADVERSARIAL.map(([id, transform], index) => pair(index, transform, id)).join('') + pair(ADVERSARIAL.length, 'none', 'control')
		const result = await measure(body, [...ADVERSARIAL.map(([id]) => id), 'control'])
		const occluders = await probes()
		for (const [id] of ADVERSARIAL) {
			const { x, y, width, height } = result[id]!.rect
			expect(result[id]!.regions.length, id).toBeGreaterThan(0)
			expect(area(result[id]!), id).toBeCloseTo(width * height - overlapArea(occluders[id]!, { left: x, top: y, right: x + width, bottom: y + height }), 3)
		}
		// The same occluder without a shadow-tree transform is proven opaque and subtracted.
		const { x, y } = result.control!.rect
		expect(bounds(result.control!)).toEqual([{ left: x, top: y, right: x + 100, bottom: y + 100, maxError: 0 }])
	})

	it('fails closed for a Widget under an SVG ancestor', async () => {
		const result = await measure(`
			<svg style="position:absolute;left:0;top:0" width="400" height="200" viewBox="0 0 200 100">
				<foreignObject x="0" y="0" width="200" height="100"><div data-widget-id="in-svg" style="width:100px;height:50px;background:#eee"></div></foreignObject>
			</svg>`, ['in-svg'])
		expect(result['in-svg']!.rect.width).toBeGreaterThan(0)
		expect(result['in-svg']!.regions).toEqual([])
	})
})

describe('Occluder paint reach (computed values)', () => {
	it('bounds outer box shadows per side and ignores inset ones', () => {
		expect(boxShadowOutsets('none')).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
		expect(boxShadowOutsets('rgba(0, 0, 0, 0.5) 10px -4px 0px 2px')).toEqual({ left: 0, top: 6, right: 12, bottom: 0 })
		// Blur radius 3 reaches at most 2·3 + 2 = 8px; the inset layer adds nothing.
		expect(boxShadowOutsets('rgb(0, 0, 0) 0px 0px 3px 0px, rgb(255, 0, 0) 0px 0px 40px 9px inset')).toEqual({ left: 8, top: 8, right: 8, bottom: 8 })
	})

	it('bounds blur and drop shadows, moves nothing for colour filters, and has no bound for anything else', () => {
		expect(filterOutsets('brightness(1.2) grayscale(1) opacity(0.5)')).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
		expect(filterOutsets('blur(2px)')).toEqual({ left: 10, top: 10, right: 10, bottom: 10 })
		expect(filterOutsets('drop-shadow(rgb(0, 0, 0) 5px 0px 0px) blur(1px)')).toEqual({ left: 6, top: 6, right: 11, bottom: 6 })
		expect(filterOutsets('url("#flood")')).toBeUndefined()
		expect(filterOutsets('blur(2px) url("#flood")')).toBeUndefined()
		expect(filterOutsets('blur(1em)')).toBeUndefined()
		expect(boxShadowOutsets('rgb(0, 0, 0) 1em 0px')).toBeUndefined()
	})
})
