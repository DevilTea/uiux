import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright'
import { borderImageOutsets, boxShadowOutsets, filterOutsets, hasThreeDTransform, textShadowOutsets, trailingLength } from '../src/preview/dom-geometry'
import type { RuntimeGeometryProducer, WidgetGeometry } from '../src/preview/geometry-producer'
import { validateGeometryMessage } from '../src/preview/protocol/schema'
import type { GeometryPerfGlobal } from './support/geometry-perf-entry'

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

afterEach(async () => {
	await page?.setViewportSize({ width: 800, height: 600 })
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
 * Counts, per Widget, the screenshot pixels whose centre lies inside one of its reported region
 * polygons (so notches and holes count) and whose colour is not the Widget's `#eee`, that is,
 * paint that a reported visible region wrongly includes. A screenshot pixel is a device pixel, so
 * `ratio` is the page's device pixel ratio.
 */
async function foreignPixels(geometries: Readonly<Record<string, WidgetGeometry>>, ratio = 1): Promise<Record<string, number>> {
	return Object.fromEntries(Object.entries(await auditPixels(geometries, ratio)).map(([id, audit]) => [id, audit.foreign]))
}

/**
 * Per Widget: `foreign`, as `foreignPixels`; and `lost`, the pixels of the Widget's rect that still
 * show its `#eee` but lie outside every reported region, that is, visible area the report gave up.
 */
async function auditPixels(geometries: Readonly<Record<string, WidgetGeometry>>, ratio = 1, antialias = false): Promise<Record<string, { foreign: number; lost: number }>> {
	const png = (await page.screenshot({ type: 'png', fullPage: true })).toString('base64')
	const polygons = Object.fromEntries(Object.entries(geometries).map(([id, geometry]) => [id, { rect: geometry.rect, regions: geometry.regions.map(region => region.contour.commands.flatMap(command => 'x' in command ? [[command.x, command.y] as const] : [])) }]))
	return page.evaluate(async ({ png, polygons, ratio, antialias }) => {
		const image = new Image()
		image.src = `data:image/png;base64,${png}`
		await image.decode()
		const canvas = document.createElement('canvas')
		canvas.width = image.width
		canvas.height = image.height
		const context = canvas.getContext('2d')!
		context.drawImage(image, 0, 0)
		const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
		const inside = (polygon: ReadonlyArray<readonly [number, number]>, px: number, py: number) => {
			let odd = false
			for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
				const [xa, ya] = polygon[a]!
				const [xb, yb] = polygon[b]!
				if ((ya > py) !== (yb > py) && px < (xb - xa) * (py - ya) / (yb - ya) + xa) odd = !odd
			}
			return odd
		}
		const isWidgetColor = (x: number, y: number) => {
			const index = (y * canvas.width + x) * 4
			return pixels[index] === 238 && pixels[index + 1] === 238 && pixels[index + 2] === 238
		}
		// With `antialias`, only a pixel more than three quarters covered counts as paint: a curved edge is antialiased.
		const isPaint = (x: number, y: number) => {
			if (!antialias) return !isWidgetColor(x, y)
			const index = (y * canvas.width + x) * 4
			return pixels[index]! < 60 || pixels[index + 1]! < 60 || pixels[index + 2]! < 60
		}
		return Object.fromEntries(Object.entries(polygons).map(([id, { rect, regions }]) => {
			let foreign = 0
			let lost = 0
			for (const polygon of regions) {
				const xs = polygon.map(([x]) => x)
				const ys = polygon.map(([, y]) => y)
				for (let y = Math.max(0, Math.floor(Math.min(...ys) * ratio)); y < Math.min(canvas.height, Math.ceil(Math.max(...ys) * ratio)); y++) {
					for (let x = Math.max(0, Math.floor(Math.min(...xs) * ratio)); x < Math.min(canvas.width, Math.ceil(Math.max(...xs) * ratio)); x++) {
						if (inside(polygon, (x + 0.5) / ratio, (y + 0.5) / ratio) && isPaint(x, y)) foreign++
					}
				}
			}
			for (let y = Math.max(0, Math.floor(rect.y * ratio)); y < Math.min(canvas.height, Math.ceil((rect.y + rect.height) * ratio)); y++) {
				for (let x = Math.max(0, Math.floor(rect.x * ratio)); x < Math.min(canvas.width, Math.ceil((rect.x + rect.width) * ratio)); x++) {
					if (isWidgetColor(x, y) && !regions.some(polygon => inside(polygon, (x + 0.5) / ratio, (y + 0.5) / ratio))) lost++
				}
			}
			return [id, { foreign, lost }]
		}))
	}, { png, polygons, ratio, antialias })
}

/**
 * Asserts that a Widget's reported area lost at least the occluder's rendered rect and at most
 * that rect grown by `slack` px: a bounded cut adds pixel snapping and outward rounding to it.
 */
function expectCut(geometry: WidgetGeometry, occluder: Box, slack: number, label: string): void {
	const { x, y, width, height } = geometry.rect
	const widget = { left: x, top: y, right: x + width, bottom: y + height }
	const grown = { left: occluder.left - slack, top: occluder.top - slack, right: occluder.right + slack, bottom: occluder.bottom + slack }
	expect(geometry.regions.length, label).toBeGreaterThan(0)
	expect(area(geometry), label).toBeLessThanOrEqual(width * height - overlapArea(occluder, widget) + 1e-6)
	expect(area(geometry), label).toBeGreaterThanOrEqual(width * height - overlapArea(grown, widget) - 1e-6)
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

/**
 * Measures one Widget per case, laid out as `cellPair` does with every `LEFT`/`TOP` replaced, on a
 * viewport tall enough for all rows (restored after each test).
 */
async function measureGrid(cases: ReadonlyArray<readonly [string, string]>): Promise<Record<string, WidgetGeometry>> {
	await page.setViewportSize({ width: 800, height: Math.max(600, Math.ceil(cases.length / 2) * 170) })
	const body = cases.map(([id, occluder], index) => {
		const { left, top } = cell(index)
		return `
		<div data-widget-id="${id}" style="position:absolute;left:${left}px;top:${top}px;width:300px;height:100px;background:#eee"></div>
		${occluder.replaceAll('LEFT', String(left + 100)).replaceAll('TOP', String(top))}`
	}).join('')
	return measure(body, cases.map(([id]) => id))
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

	it('cuts occluders of unproven shape by their box: masks, blend modes, SVG and native controls', async () => {
		const occluders = [
			['mask', 'div', 'mask-image:linear-gradient(black, transparent);-webkit-mask-image:linear-gradient(black, transparent);background:rgb(0,0,0)'],
			['blend', 'div', 'mix-blend-mode:multiply;background:rgb(0,0,0)'],
			['svg', 'svg', ''],
			['button', 'button', ''],
			['path-clip', 'div', 'clip-path:path(\'M0 0 L50 0 L50 100 Z\');background:rgb(0,0,0)'],
			['missing-clip', 'div', 'clip-path:url(#nothing);background:rgb(0,0,0)'],
			['svg-path-clip', 'div', 'clip-path:url(#path-clip);background:rgb(0,0,0)'],
			['crossing-polygon', 'div', 'clip-path:polygon(0 0, 100% 100%, 100% 0, 0 100%);background:rgb(0,0,0)'],
		] as const
		const at = (index: number) => ({ left: (index % 2) * 400, top: Math.floor(index / 2) * 110 })
		const body = `<svg width="0" height="0" style="position:absolute"><clipPath id="path-clip"><path d="M0 0 L50 0 L50 100 Z"></path></clipPath></svg>` + occluders.map(([id, tag, style], index) => `
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

	it('cuts rounded, clip-path and SVG clip-path occluders by their actual shape (#112)', async () => {
		const shapes = [
			['rounded', 'border-radius:40px'],
			['rounded-elliptical', 'border-radius:50px / 25px'],
			['clip-circle', 'clip-path:circle(50%)'],
			['clip-ellipse', 'clip-path:ellipse(30% 60% at 50% 50%)'],
			['clip-inset-round', 'clip-path:inset(10px round 20px)'],
			['clip-polygon', 'clip-path:polygon(0 0, 100% 50%, 0 100%)'],
			['clip-padding-box', 'border:10px solid rgb(0,0,0);padding:10px;clip-path:inset(0 round 30px) padding-box'],
			['svg-clip', 'clip-path:url(#user)'],
			['svg-clip-bbox', 'clip-path:url(#bbox)'],
		] as const
		const at = (index: number) => ({ left: (index % 2) * 400, top: 20 + Math.floor(index / 2) * 170 })
		const body = `<svg width="0" height="0" style="position:absolute">
			<clipPath id="user"><circle cx="50" cy="50" r="40"></circle><rect x="0" y="0" width="30" height="20"></rect></clipPath>
			<clipPath id="bbox" clipPathUnits="objectBoundingBox"><ellipse cx="0.5" cy="0.5" rx="0.45" ry="0.4"></ellipse></clipPath>
		</svg>` + shapes.map(([id, style], index) => `
			<div data-widget-id="${id}" style="position:absolute;left:${at(index).left}px;top:${at(index).top}px;width:300px;height:100px;background:#eee"></div>
			<div style="position:absolute;left:${at(index).left + 100}px;top:${at(index).top - 20}px;width:100px;height:140px;margin:0;background:rgb(0,0,0);${style}"></div>`).join('')
		await page.setViewportSize({ width: 800, height: Math.max(600, 20 + Math.ceil(shapes.length / 2) * 170) })
		const result = await measure(body, shapes.map(([id]) => id))
		const audit = await auditPixels(result, 1, true)
		for (const [id] of shapes) {
			const geometry = result[id]!
			expect(geometry.regions.length, id).toBeGreaterThan(0)
			expect(valid(geometry), id).toBe(true)
			// Never a pixel the occluder paints, and no more given up than the curve approximation and antialiasing cost.
			expect(audit[id]!.foreign, id).toBe(0)
			expect(audit[id]!.lost, id).toBeLessThan(450)
			for (const region of geometry.regions) expect(region.maxError, id).toBeLessThanOrEqual(0.5)
		}
		// A curve is approximated and says so; a straight-edged clip is exact.
		expect(result.rounded!.regions[0]!.maxError).toBeGreaterThan(0)
		expect(result['clip-polygon']!.regions[0]!.maxError).toBe(0)
		// The triangle (0 0, 100% 50%, 0 100%) of the 100 × 140 box covers 7000 minus two 28.57 × 20 / 2 corners of the Widget's 100px band.
		expect(Math.abs(area(result['clip-polygon']!) - (300 * 100 - (7000 - 2 * 0.5 * 20 * (20 * 100 / 70))))).toBeLessThan(0.01)
		expect(area(result.rounded!)).toBeGreaterThan(300 * 100 - 100 * 100)
	})

	it('leaves the corners of a rounded occluder box visible (#112)', async () => {
		const result = await measure(`
			<div data-widget-id="w" style="position:absolute;left:0;top:0;width:300px;height:100px;background:#eee"></div>
			<div style="position:absolute;left:100px;top:0;width:100px;height:100px;border-radius:50px;background:rgb(0,0,0)"></div>`, ['w'])
		// The disc touches the Widget's top and bottom edges and leaves the four corners of its box visible.
		expect(result.w!.regions).toHaveLength(2)
		expect(area(result.w!)).toBeGreaterThan(300 * 100 - Math.PI * 50 * 50 - 100)
		expect(area(result.w!)).toBeLessThan(300 * 100 - Math.PI * 50 * 50 + 100)
	})

	it('combines a rounded Widget, rounded clips and cuts, and clips the Widget by its own clip path (#112)', async () => {
		const cases = [
			['rounded-with-cut', `<div style="position:absolute;left:LEFTpx;top:TOPpx;width:60px;height:100px;background:rgb(0,0,0)"></div>`, 'border-radius:30px'],
			['rounded-under-rounded', `<div style="position:absolute;left:LEFTpx;top:TOPpx;width:60px;height:100px;border-radius:20px;background:rgb(0,0,0)"></div>`, 'border-radius:30px'],
			['clip-path-widget', `<div style="position:absolute;left:LEFTpx;top:TOPpx;width:60px;height:100px;background:rgb(0,0,0)"></div>`, 'clip-path:circle(50% at 40% 50%)'],
			['clip-path-widget-svg', `<div style="position:absolute;left:LEFTpx;top:TOPpx;width:60px;height:100px;background:rgb(0,0,0)"></div>`, 'clip-path:url(#widget-clip)'],
		] as const
		const body = `<svg width="0" height="0" style="position:absolute"><clipPath id="widget-clip"><circle cx="100" cy="50" r="45"></circle></clipPath></svg>` + cases.map(([id, occluder, style], index) => {
			const { left, top } = cell(index)
			return `
			<div data-widget-id="${id}" style="position:absolute;left:${left}px;top:${top}px;width:300px;height:100px;background:#eee;${style}"></div>
			${occluder.replaceAll('LEFT', String(left + 90)).replaceAll('TOP', String(top))}`
		}).join('')
		await page.setViewportSize({ width: 800, height: 600 })
		const result = await measure(body, cases.map(([id]) => id))
		const audit = await auditPixels(result, 1, true)
		for (const [id] of cases) {
			expect(result[id]!.regions.length, id).toBeGreaterThan(0)
			expect(valid(result[id]!), id).toBe(true)
			expect(audit[id]!.foreign, id).toBe(0)
			expect(audit[id]!.lost, id).toBeLessThan(500)
		}
	})

	it('clips a rounded Widget by a rounded overflow clip and by a clip path on an ancestor (#112)', async () => {
		await page.setViewportSize({ width: 800, height: 600 })
		const result = await measure(`
			<svg width="0" height="0" style="position:absolute"><clipPath id="ancestor-clip"><circle cx="150" cy="50" r="48"></circle></clipPath></svg>
			<div style="position:absolute;left:0;top:0;width:300px;height:100px;border-radius:40px;overflow:hidden;background:#fff">
				<div data-widget-id="two-rounded" style="width:300px;height:100px;border-radius:20px;background:#eee"></div>
			</div>
			<div style="position:absolute;left:400px;top:0;width:300px;height:100px;clip-path:circle(48px at 50% 50%)">
				<div data-widget-id="ancestor-circle" style="width:300px;height:100px;background:#eee"></div>
			</div>
			<div style="position:absolute;left:0;top:200px;width:300px;height:100px;clip-path:url(#ancestor-clip)">
				<div data-widget-id="ancestor-svg" style="width:300px;height:100px;background:#eee"></div>
			</div>`, ['two-rounded', 'ancestor-circle', 'ancestor-svg'])
		const audit = await auditPixels(result, 1, true)
		for (const id of ['two-rounded', 'ancestor-circle', 'ancestor-svg']) {
			expect(result[id]!.regions.length, id).toBe(1)
			expect(valid(result[id]!), id).toBe(true)
			// No page background (white) from outside the clip, and little of the Widget given up.
			expect(audit[id]!.foreign, id).toBe(0)
			expect(result[id]!.regions[0]!.maxError, id).toBeGreaterThan(0)
		}
		expect(audit['two-rounded']!.lost).toBeLessThan(120)
		expect(audit['ancestor-circle']!.lost).toBeLessThan(300)
		expect(audit['ancestor-svg']!.lost).toBeLessThan(300)
		// The circle of radius 48 about the Widget's centre: the area is that of the disc, from inside.
		expect(area(result['ancestor-circle']!)).toBeLessThan(Math.PI * 48 * 48)
		expect(area(result['ancestor-circle']!)).toBeGreaterThan(Math.PI * 48 * 48 - 2 * Math.PI * 48 * 0.5)
	})

	it('accounts for the backdrop of a modal dialog over a Widget outside it (#112)', async () => {
		const page = (style: string) => `<style>${style}</style>
			<div data-widget-id="behind" style="position:absolute;left:0;top:0;width:300px;height:100px;background:#eee"></div>
			<dialog id="d" style="width:100px;height:60px;margin:0;left:450px;top:300px;padding:0;border:0"><div data-widget-id="inside" style="width:100px;height:60px;background:#eee"></div></dialog>
			<script>document.getElementById('d').showModal()</script>`
		// The default backdrop is translucent: what is behind it stays, as the Widget inside the dialog does.
		const translucent = await measure(page(''), ['behind', 'inside'])
		expect(bounds(translucent.behind!)).toEqual([{ left: 0, top: 0, right: 300, bottom: 100, maxError: 0 }])
		expect(bounds(translucent.inside!)).toEqual([{ left: 450, top: 300, right: 550, bottom: 360, maxError: 0 }])
		// An opaque backdrop covers a Widget outside the dialog, but never one inside it, which paints above it.
		const opaque = await measure(page('dialog::backdrop{background:#000}'), ['behind', 'inside'])
		expect(opaque.behind!.regions).toEqual([])
		expect(bounds(opaque.inside!)).toEqual([{ left: 450, top: 300, right: 550, bottom: 360, maxError: 0 }])
		expect((await measure(page('dialog::backdrop{background:rgba(0,0,0,0.5);backdrop-filter:blur(4px)}'), ['behind'])).behind!.regions).toEqual([])
	})

	it('keeps failing closed for a mask, an underivable clip path and two curved clips on the Widget\'s own chain (#112)', async () => {
		const result = await measure(`
			<svg width="0" height="0" style="position:absolute"><clipPath id="path-clip"><path d="M0 0 L50 0 L50 100 Z"></path></clipPath></svg>
			<div data-widget-id="mask" style="position:absolute;left:0;top:0;width:100px;height:100px;background:#eee;mask-image:linear-gradient(black, transparent);-webkit-mask-image:linear-gradient(black, transparent)"></div>
			<div data-widget-id="path" style="position:absolute;left:200px;top:0;width:100px;height:100px;background:#eee;clip-path:path('M0 0 L50 0 L50 100 Z')"></div>
			<div data-widget-id="svg-path" style="position:absolute;left:400px;top:0;width:100px;height:100px;background:#eee;clip-path:url(#path-clip)"></div>
			<div data-widget-id="missing" style="position:absolute;left:600px;top:0;width:100px;height:100px;background:#eee;clip-path:url(#nothing)"></div>
			<div data-widget-id="crossing" style="position:absolute;left:0;top:200px;width:100px;height:100px;background:#eee;clip-path:polygon(0 0, 100% 100%, 100% 0, 0 100%)"></div>
			<div data-widget-id="radial" style="position:absolute;left:200px;top:200px;width:100px;height:100px;background:#eee;clip-path:circle(calc(10px + 20%))"></div>`, ['mask', 'path', 'svg-path', 'missing', 'crossing', 'radial'])
		for (const id of ['mask', 'path', 'svg-path', 'missing', 'crossing', 'radial']) {
			expect(result[id]!.rect.width, id).toBeGreaterThan(0)
			expect(result[id]!.regions, id).toEqual([])
		}
	})

	it('cuts the paint of an exactly cut occluder that lies beyond its box: shadows, outlines, generated content, overflowing text, markers (#112)', async () => {
		const cases = [
			['shadow', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;background:#000;box-shadow:0 0 0 15px #000"></div>'],
			['outline', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;background:#000;outline:12px solid #000"></div>'],
			['before', '<style>.pb::before{content:"";position:absolute;left:-30px;top:0;width:30px;height:100%;background:#000}</style><div class="pb" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;background:#000"></div>'],
			['overflowing-text', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:20px;height:100px;background:#000;color:#fff;font:16px/20px sans-serif;white-space:nowrap">Overflowing text</div>'],
			['marker', '<ul style="position:absolute;left:0;top:0;margin:0;padding:0;list-style:none"><li style="position:absolute;left:calc(LEFTpx + 30px);top:TOPpx;display:list-item;list-style:disc outside;width:20px;height:100px;background:#000;color:#000;font:16px sans-serif">x</li></ul>'],
			['border-without-fill', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:60px;height:100px;border:6px solid #000"></div>'],
			['text-over-edge', '<div style="position:absolute;left:LEFTpx;top:TOPpx;margin-top:-6px;color:#000;font:16px/20px sans-serif">Overlay</div>'],
			['gradient', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;background:linear-gradient(#000, #000)"></div>'],
		] as const
		const result = await measureGrid(cases)
		const audit = await auditPixels(result)
		for (const [id] of cases) {
			expect(result[id]!.regions.length, id).toBeGreaterThan(0)
			expect(valid(result[id]!), id).toBe(true)
			expect(audit[id]!.foreign, id).toBe(0)
		}
		// The ring of an opaque border is cut, the interior it frames stays: a piece of its own.
		const pieces = bounds(result['border-without-fill']!).sort((a, b) => a.left - b.left)
		expect(pieces).toHaveLength(3)
		const { left, top } = cell(cases.findIndex(([id]) => id === 'border-without-fill'))
		expect(pieces[1]).toMatchObject({ left: left + 100 + 6, top: top + 6, right: left + 100 + 54, bottom: top + 94 })
	})

	it('keeps what a translucent fill and a translucent border let show, and cuts a solid border and text over it (#112)', async () => {
		const result = await measureGrid([
			['translucent-border', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:60px;height:100px;background:rgba(0,0,0,0.3);border:6px solid rgba(0,0,0,0.5)"></div>'],
			['solid-border-on-translucent', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:60px;height:100px;background:rgba(0,0,0,0.3);border:6px solid rgb(0,0,0)"></div>'],
			['dashed-border', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:60px;height:100px;border:6px dashed rgb(0,0,0)"></div>'],
			['faded', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:60px;height:100px;opacity:0.5;border:6px solid rgb(0,0,0);color:#000;font:16px sans-serif">Faded</div>'],
		])
		expect(area(result['translucent-border']!)).toBe(300 * 100)
		expect(area(result.faded!)).toBe(300 * 100)
		// A solid opaque border is four exact strips: the two 6px sides split off the 48 × 88 interior it frames.
		expect(result['solid-border-on-translucent']!.regions).toHaveLength(3)
		expect(area(result['solid-border-on-translucent']!)).toBeCloseTo(300 * 100 - (2 * 6 * 100 + 2 * 6 * 48), 6)
		// A dashed border is only bounded: its box is cut, not its dashes.
		expect(bounds(result['dashed-border']!).map(piece => [piece.left, piece.right]).sort((a, b) => a[0]! - b[0]!)).toEqual([[0, 100], [160, 300]])
		expect(Object.values(result).every(geometry => valid(geometry))).toBe(true)
	})

	it('fails closed for text whose combining marks have no bound (#112)', async () => {
		const result = await measure(`
			<div data-widget-id="marks" style="position:absolute;left:0;top:0;width:300px;height:100px;background:#eee"></div>
			<div style="position:absolute;left:100px;top:0;font:16px sans-serif;color:#000">á́́́ b</div>`, ['marks'])
		expect(result.marks!.rect.width).toBe(300)
		expect(result.marks!.regions).toEqual([])
	})

	it('selects paint without a finite bound wherever its clips allow, not only where its border box is (#112)', async () => {
		const unbounded = async (occluder: string) => (await measure(`
			<svg width="0" height="0" style="position:absolute"><filter id="f"><feGaussianBlur stdDeviation="4"></feGaussianBlur></filter></svg>
			<div data-widget-id="w" style="position:absolute;left:0;top:200px;width:300px;height:100px;background:#eee"></div>
			${occluder}`, ['w'])).w!
		// An SVG filter and a 3D transform paint anywhere: no region of a Widget they might reach.
		expect((await unbounded('<div style="position:absolute;left:0;top:500px;width:20px;height:20px;background:#000;filter:url(#f)"></div>')).regions).toEqual([])
		expect((await unbounded('<div style="position:absolute;left:400px;top:500px;width:20px;height:20px;background:#000;transform:perspective(40px) rotateY(80deg)"></div>')).regions).toEqual([])
		// A clip that does not reach the Widget bounds that paint; a finite filter bounds itself.
		expect(bounds(await unbounded('<div style="position:absolute;left:0;top:420px;width:300px;height:40px;overflow:hidden"><div style="width:20px;height:20px;background:#000;filter:url(#f)"></div></div>'))).toEqual([{ left: 0, top: 200, right: 300, bottom: 300, maxError: 0 }])
		expect(bounds(await unbounded('<div style="position:absolute;left:400px;top:500px;width:20px;height:20px;background:#000;filter:blur(3px)"></div>'))).toEqual([{ left: 0, top: 200, right: 300, bottom: 300, maxError: 0 }])
	})

	it('reaches the paint of an element whose text, generated content or marker leaves a box that does not overlap the Widget (#112)', async () => {
		const cases = [
			['text', '<div style="position:absolute;left:calc(LEFTpx - 150px);top:calc(TOPpx + 20px);width:20px;height:20px;color:#000;font:16px/20px sans-serif;white-space:nowrap">Text running far out of a tiny box</div>'],
			['decoration', '<span style="position:absolute;left:LEFTpx;top:calc(TOPpx - 70px);text-decoration:underline;text-decoration-thickness:6px;text-underline-offset:60px;color:#000;font:16px/20px sans-serif"><span>decorated</span></span>'],
			['pseudo', '<style>.pa::after{content:"";position:absolute;left:0;top:110px;width:60px;height:12px;background:#000}</style><div class="pa" style="position:absolute;left:LEFTpx;top:calc(TOPpx - 100px);width:20px;height:20px"></div>'],
		] as const
		const result = await measureGrid(cases)
		const audit = await auditPixels(result)
		for (const [id] of cases) {
			expect(valid(result[id]!), id).toBe(true)
			expect(audit[id]!.foreign, id).toBe(0)
			expect(result[id]!.regions.length, id).toBeGreaterThan(0)
		}
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
		for (const [id, count] of Object.entries(await foreignPixels(result))) expect(count, id).toBe(0)
	})

	it('still fails closed for occluder paint without a finite bound', async () => {
		const occluders = [
			['svg-filter', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;filter:url(#flood);background:rgb(0,0,0)"></div>'],
			['image-overflow', '<img alt="" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;overflow:visible;object-fit:none">'],
			['three-d', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;transform:rotateX(30deg);background:rgb(0,0,0)"></div>'],
			['reflection', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;-webkit-box-reflect:right 0px;background:rgb(0,0,0)"></div>'],
			['ancestor-reflection', '<div style="position:absolute;left:LEFTpx;top:TOPpx;-webkit-box-reflect:right 0px"><div style="width:50px;height:100px;background:rgb(0,0,0)"></div></div>'],
		] as const
		const body = `<svg width="0" height="0" style="position:absolute"><filter id="flood" x="-10" y="-10" width="20" height="20"><feFlood flood-color="black"></feFlood></filter></svg>` + occluders.map(([id, html], index) => cellPair(id, html, index)).join('')
		const result = await measure(body, occluders.map(([id]) => id))
		for (const [id] of occluders) {
			expect(result[id]!.rect.width, id).toBeGreaterThan(0)
			expect(result[id]!.regions, id).toEqual([])
		}
	})

	it('keeps every pixel an occluder paints out of the regions when its size is fractional (#259 review)', async () => {
		// The snapped offsetWidth (10.5px → 11px) once gave a scale below 1 and shrank each outset.
		const result = await measureGrid([
			['outline-10.5', '<img alt="" style="position:absolute;left:LEFTpx;top:TOPpx;width:10.5px;height:10.5px;outline:40px solid rgb(0,0,0)">'],
			['outline-1.5', '<img alt="" style="position:absolute;left:LEFTpx;top:TOPpx;width:1.5px;height:1.5px;outline:40px solid rgb(0,0,0)">'],
			['spread-2.5', '<img alt="" style="position:absolute;left:calc(LEFTpx + 0.4px);top:TOPpx;width:2.5px;height:2.5px;box-shadow:0 0 0 40px rgb(0,0,0)">'],
			['scaled-ancestor', '<div style="position:absolute;left:LEFTpx;top:TOPpx;transform-origin:0 0;transform:scale(1.5)"><img alt="" style="display:block;width:6.5px;height:6.5px;outline:20px solid rgb(0,0,0)"></div>'],
			['zoomed-ancestor', '<div style="position:absolute;left:LEFTpx;top:TOPpx;zoom:2"><img alt="" style="display:block;width:6.5px;height:6.5px;outline:15px solid rgb(0,0,0)"></div>'],
		])
		for (const [id, count] of Object.entries(await foreignPixels(result))) {
			expect(result[id]!.regions.length, id).toBeGreaterThan(0)
			expect(count, id).toBe(0)
		}
	})

	it('keeps every pixel of a fractional occluder out of the regions at device pixel ratio 2 (#259 review)', async () => {
		// The engine snaps box paint to whole CSS px before scaling it, so rounding the bound outward to
		// device pixels alone once missed up to half a CSS px.
		const standard = page
		page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 })
		try {
			const result = await measureGrid([
				['outline-10.5', '<img alt="" style="position:absolute;left:LEFTpx;top:TOPpx;width:10.5px;height:10.5px;outline:40px solid rgb(0,0,0)">'],
				['outline-1.5', '<img alt="" style="position:absolute;left:LEFTpx;top:TOPpx;width:1.5px;height:1.5px;outline:40px solid rgb(0,0,0)">'],
				['spread-2.5', '<img alt="" style="position:absolute;left:calc(LEFTpx + 0.4px);top:TOPpx;width:2.5px;height:2.5px;box-shadow:0 0 0 40px rgb(0,0,0)">'],
				['blend-10.25', '<div style="position:absolute;left:calc(LEFTpx + 0.3px);top:calc(TOPpx + 0.3px);width:10.25px;height:10.25px;mix-blend-mode:multiply;outline:40px solid rgb(0,0,0)"></div>'],
			])
			for (const [id, count] of Object.entries(await foreignPixels(result, 2))) {
				expect(result[id]!.regions.length, id).toBeGreaterThan(0)
				expect(count, id).toBe(0)
			}
		}
		finally {
			await page.close()
			page = standard
		}
	})

	it('ignores the computed transform of a box the engine does not transform (#259 review)', async () => {
		// A non-replaced inline box or a box-less element keeps its computed transform, but the engine
		// does not apply it: scaling the outsets by it once shrank the cut.
		const result = await measureGrid([
			['inline-span', '<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 10px);font-size:0"><span style="transform:scale(0.5)"><img alt="" style="width:1px;height:1px;outline:40px solid rgb(0,0,0)"></span></div>'],
			['inline-span-zoom', '<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 10px);font-size:0"><span style="transform:scale(0.2);zoom:1"><img alt="" style="width:0.6px;height:0.6px;box-shadow:0 0 0 40px rgb(0,0,0)"></span></div>'],
			['contents', '<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 10px)"><div style="display:contents;transform:scale(0.5)"><img alt="" style="display:block;width:1px;height:1px;outline:40px solid rgb(0,0,0)"></div></div>'],
		])
		for (const [id, count] of Object.entries(await foreignPixels(result))) {
			expect(result[id]!.regions.length, id).toBeGreaterThan(0)
			expect(count, id).toBe(0)
		}
	})

	it('keeps the scale-up of an inline fieldset and a transformed table row (#259 review)', async () => {
		// Chromium lays an inline fieldset out atomically and a table row is transformable: both apply
		// their transform, so a scale-up must reach the chain scale (a control for the ignored cases above).
		const box = (w: number) => `<div style="display:inline-block;vertical-align:top;width:${w}px;height:${w}px;mix-blend-mode:multiply;outline:40px solid rgb(0,0,0)"></div>`
		const result = await measureGrid([
			['fieldset-inline', `<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 10px);font-size:0"><fieldset style="display:inline;margin:0;padding:0;border:0;min-width:0;transform:scale(1.1);transform-origin:0 0">${box(10)}</fieldset></div>`],
			['table-row', '<table style="position:absolute;left:LEFTpx;top:calc(TOPpx + 10px);border-spacing:0"><tr style="transform:scale(0.25)"><td style="padding:0"><img alt="" style="display:block;width:1px;height:1px;outline:40px solid rgb(0,0,0)"></td></tr></table>'],
		])
		for (const [id, count] of Object.entries(await foreignPixels(result))) {
			expect(result[id]!.regions.length, id).toBeGreaterThan(0)
			expect(count, id).toBe(0)
		}
	})

	it('does not treat overflow on a non-replaced inline box as a clip (#259 review)', async () => {
		// CSS overflow does not apply to an inline box, so a child's outline paints outside it.
		const box = `<div style="display:inline-block;vertical-align:top;width:6px;height:6px;mix-blend-mode:multiply;outline:40px solid rgb(0,0,0)"></div>`
		const result = await measureGrid([
			['span-hidden', `<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 10px);font-size:0"><span style="overflow:hidden">${box}</span></div>`],
			['span-clip', `<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 10px);font-size:0"><span style="overflow:clip">${box}</span></div>`],
			['span-object', `<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 10px);font-size:0"><object style="display:inline;transform:scale(0.9);transform-origin:0 0">${box}</object></div>`],
			['div-hidden', `<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 10px);font-size:0"><div style="overflow:hidden;width:6px;height:6px">${box}</div></div>`],
		])
		for (const [id, count] of Object.entries(await foreignPixels(result))) {
			if (id.startsWith('span')) expect(result[id]!.regions.length, id).toBeGreaterThan(0)
			expect(count, id).toBe(0)
		}
		// A wrongly applied 6px clip would shrink the occluder's bound to the box; the cut must keep
		// the whole outline reach (the 6px box plus 40px on each side, 52px square).
		for (const id of ['span-hidden', 'span-clip', 'span-object']) expect(area(result[id]!), id).toBeLessThanOrEqual(300 * 100 - 52 * 52 + 4)
	})

	it('applies the clip of an inline fieldset to the Widget it contains, but not that of a span (#259 review)', async () => {
		// An inline fieldset is atomic and clips its overflow, so only 20 x 20 of the Widget is visible; a
		// span is a non-replaced inline box that does not clip (control).
		const widget = (id: string) => `<div data-widget-id="${id}" style="width:100px;height:100px;background:#eee"></div>`
		const result = await measure(`
			<div style="position:absolute;left:0;top:0;font-size:0"><fieldset style="display:inline;margin:0;padding:0;border:0;min-width:0;overflow:hidden;width:20px;height:20px">${widget('fieldset')}</fieldset></div>
			<div style="position:absolute;left:300px;top:0;font-size:0"><span style="overflow:hidden">${widget('span')}</span></div>`, ['fieldset', 'span'])
		expect(area(result.fieldset!)).toBeLessThanOrEqual(20 * 20)
		expect(area(result.fieldset!)).toBeGreaterThan(0)
		expect(area(result.span!)).toBe(100 * 100)
	})

	it('cuts a bounded occluder\'s own text with its overflow, text shadow and decoration (#259 review)', async () => {
		const text = 'mix-blend-mode:multiply;font:30px/40px sans-serif;color:rgb(0,0,0)'
		const result = await measureGrid([
			['text-shadow', `<div style="position:absolute;left:LEFTpx;top:TOPpx;width:40px;height:40px;${text};text-shadow:60px 20px 0 rgb(0,0,0)">M</div>`],
			['text-overflow', `<div style="position:absolute;left:LEFTpx;top:TOPpx;width:20px;height:40px;${text};white-space:nowrap">MMMMMM</div>`],
			['underline', `<div style="position:absolute;left:LEFTpx;top:TOPpx;width:40px;height:40px;${text};text-decoration:underline 6px;text-underline-offset:30px">M</div>`],
		])
		for (const [id, count] of Object.entries(await foreignPixels(result))) {
			expect(result[id]!.regions.length, id).toBeGreaterThan(0)
			expect(count, id).toBe(0)
		}
	})

	it('fails closed when a bounded cut would only leave an interior hole, and keeps exact cuts as they are', async () => {
		// Discussion #241 owner decision 1: interior holes are never reported (Rule 01a11687-3037).
		const inner = 'position:absolute;left:calc(LEFTpx + 20px);top:calc(TOPpx + 30px);width:40px;height:40px;background:rgb(0,0,0)'
		const result = await measureGrid([
			['bounded-hole', `<img alt="" style="${inner}">`],
			['exact-hole', `<div style="${inner}"></div>`],
			['bounded-notch', '<img alt="" style="position:absolute;left:LEFTpx;top:calc(TOPpx + 30px);width:40px;height:70px;background:rgb(0,0,0)">'],
		])
		expect(result['bounded-hole']!.rect.width).toBe(300)
		expect(result['bounded-hole']!.regions).toEqual([])
		expect(area(result['exact-hole']!)).toBe(300 * 100)
		expect(area(result['bounded-notch']!)).toBe(300 * 100 - 40 * 70)
	})

	it('selects occluders by their paint extent, not only their border box (Discussion #241 owner decision 2)', async () => {
		const result = await measureGrid([
			['nearby-blur', '<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 104px);width:50px;height:30px;filter:blur(4px);background:rgb(0,0,0)"></div>'],
			['child-outside', '<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 60px);width:30px;height:40px;filter:blur(3px);background:rgb(0,0,0)"><div style="position:absolute;left:60px;top:44px;width:40px;height:20px;background:rgb(0,0,0)"></div></div>'],
			['nearby-shadow', '<img alt="" style="position:absolute;left:LEFTpx;top:calc(TOPpx + 104px);width:50px;height:30px;box-shadow:0 -20px 0 rgb(0,0,0)">'],
			['nearby-outline', '<img alt="" style="position:absolute;left:LEFTpx;top:calc(TOPpx + 104px);width:50px;height:30px;outline:10px solid rgb(0,0,0)">'],
		])
		for (const [id, count] of Object.entries(await foreignPixels(result))) {
			expect(result[id]!.regions.length, id).toBeGreaterThan(0)
			expect(count, id).toBe(0)
		}
	})

	it('rounds a bounded cut outward to whole device pixels, antialiased edges included', async () => {
		const result = await measureGrid([0.3, 0.45, 0.6, 0.85].map(fraction => [`rotated-${fraction}`, `<div style="position:absolute;left:calc(LEFTpx + ${fraction}px);top:calc(TOPpx + ${70 + fraction}px);width:50px;height:20px;transform:rotate(30deg);background:rgb(0,0,0)"></div>`] as const))
		for (const [id, geometry] of Object.entries(result)) {
			for (const point of geometry.regions.flatMap(region => region.contour.commands.flatMap(command => 'x' in command ? [command] : []))) {
				expect(Number.isInteger(point.x) && Number.isInteger(point.y), id).toBe(true)
			}
		}
		for (const [id, count] of Object.entries(await foreignPixels(result))) expect(count, id).toBe(0)
	})

	it('grows a bound under rotation, skew and scale, and by border-image outsets, outline offsets and clip margins', async () => {
		const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200"/></svg>')}`
		const result = await measureGrid([
			['rotated-outline', '<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 20px);width:50px;height:20px;transform:rotate(30deg);outline:15px solid rgb(0,0,0);background:rgb(0,0,0)"></div>'],
			['skewed-shadow', '<div style="position:absolute;left:LEFTpx;top:calc(TOPpx + 20px);width:50px;height:20px;transform:skewX(40deg) scale(1.5, 0.5);box-shadow:20px 10px 6px 8px rgb(0,0,0);background:rgb(0,0,0)"></div>'],
			['border-image', '<div style="position:absolute;left:LEFTpx;top:calc(TOPpx - 20px);width:40px;height:40px;mix-blend-mode:multiply;border:10px solid;border-image:linear-gradient(black,black) 10 / 10px / 25px stretch"></div>'],
			['outline-negative', '<img alt="" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;outline:6px solid rgb(0,0,0);outline-offset:-3px">'],
			['outline-auto', '<img alt="" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;outline:auto 2px rgb(0,0,0);outline-offset:4px">'],
			['scaled-blur', '<div style="position:absolute;left:LEFTpx;top:TOPpx;transform-origin:0 0;transform:scale(2)"><div style="width:25px;height:50px;filter:blur(4px);background:rgb(0,0,0)"></div></div>'],
			['drop-shadow', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:30px;height:30px;filter:drop-shadow(rgb(0,0,0) 40px 50px 10px);background:rgb(0,0,0)"></div>'],
			['clip-margin', `<img alt="" src="${image}" style="position:absolute;left:LEFTpx;top:TOPpx;width:40px;height:40px;object-fit:none;object-position:0 0;overflow:clip;overflow-clip-margin:content-box 20px">`],
			['clipped', '<div style="position:absolute;left:LEFTpx;top:TOPpx;width:30px;height:100px;overflow:hidden"><img alt="" style="display:block;width:80px;height:100px;background:rgb(0,0,0)"></div>'],
		])
		for (const [id, count] of Object.entries(await foreignPixels(result))) {
			expect(result[id]!.regions.length, id).toBeGreaterThan(0)
			expect(count, id).toBe(0)
		}
		const piece = (id: string) => {
			const { x } = result[id]!.rect
			return bounds(result[id]!).sort((a, b) => a.left - b.left).map(box => [box.left - x, box.right - x])
		}
		// Outline 6px at offset -3px reaches 3px out; the clip margin reaches 20px; the clip keeps 30px.
		expect(piece('outline-negative')).toEqual([[0, 97], [153, 300]])
		expect(bounds(result['clip-margin']!)).toHaveLength(1)
		expect(area(result['clip-margin']!)).toBe(300 * 100 - 80 * 60)
		expect(piece('clipped')).toEqual([[0, 100], [130, 300]])
	})

	it('keeps an undecided in-flow overlap that paints translucently', async () => {
		const result = await measure(`
			<div style="position:absolute;left:0;top:0;width:300px">
				<div data-widget-id="flow" style="height:50px;background:#eee"></div>
				<div style="margin-top:-20px;height:50px;background:rgba(0,0,0,0.5)"></div>
			</div>`, ['flow'])
		expect(bounds(result.flow!)).toEqual([{ left: 0, top: 0, right: 300, bottom: 50, maxError: 0 }])
	})

	it('fails closed for every adversarial transform family on the Widget and cuts an occluder by its transformed box', async () => {
		const body = ADVERSARIAL.map(([id, transform], index) => `
			<div data-widget-id="own-${id}" style="position:absolute;left:0;top:${index * 90}px;width:200px;height:60px;transform:${transform};background:#eee"></div>
			<div data-widget-id="under-${id}" style="position:absolute;left:400px;top:${index * 90}px;width:200px;height:60px;background:#eee"></div>
			<div data-probe="${id}" style="position:absolute;left:575px;top:${index * 90 + 20}px;width:50px;height:20px;transform:${transform};background:rgb(0,0,0)"></div>`).join('')
		const ids = ADVERSARIAL.flatMap(([id]) => [`own-${id}`, `under-${id}`])
		const result = await measure(body, ids)
		const occluders = await probes()
		for (const [id] of ADVERSARIAL) {
			expect(result[`own-${id}`]!.rect.width, id).toBeGreaterThan(0)
			expect(result[`own-${id}`]!.regions, id).toEqual([])
			// The occluder straddles the Widget's right edge, so its cut is a notch, never a hole.
			expectCut(result[`under-${id}`]!, occluders[id]!, 6, id)
		}
		const counts = await foreignPixels(Object.fromEntries(ADVERSARIAL.map(([id]) => [id, result[`under-${id}`]!])))
		for (const [id, count] of Object.entries(counts)) expect(count, id).toBe(0)
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
		for (const [id] of ADVERSARIAL) expectCut(result[id]!, occluders[id]!, 6, id)
		const counts = await foreignPixels(Object.fromEntries(ADVERSARIAL.map(([id]) => [id, result[id]!])))
		for (const [id, count] of Object.entries(counts)) expect(count, id).toBe(0)
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

type SignalsWindow = Readonly<{ __signals: Readonly<{ latest: Record<string, WidgetGeometry>; producer: RuntimeGeometryProducer }> }>

async function frames(count: number): Promise<void> {
	await page.evaluate(async (count) => {
		for (let index = 0; index < count; index++) await new Promise(resolve => requestAnimationFrame(resolve))
	}, count)
}

/**
 * Tracks Widgets as the Preview document does: the production producer, DOM measurer and
 * invalidation signals, driven by real animation frames. Keeps each Widget's latest report.
 */
async function track(body: string, widgetIds: readonly string[]): Promise<void> {
	await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}*{box-sizing:border-box}</style></head><body>${body}</body></html>`)
	await page.addScriptTag({ content: bundle })
	await page.evaluate((ids) => {
		const P = (globalThis as never as GeometryPerfGlobal).UiuxGeometryPerf
		const viewId = '11111111-1111-4111-8111-111111111111'
		const latest: Record<string, unknown> = {}
		const producer = new P.RuntimeGeometryProducer({
			send: (response) => { latest[response.context.widgetId] = response.payload },
			measurer: P.createDomGeometryMeasurer({ document }),
			requestFrame: callback => requestAnimationFrame(callback),
			cancelFrame: handle => cancelAnimationFrame(handle),
		})
		producer.setContext({ viewId })
		P.attachGeometrySignals(window, producer, id => document.querySelector(`[data-widget-id="${CSS.escape(id)}"]`))
		for (const widgetId of ids)
			producer.receive({ type: 'geometry.acquire.request', context: { previewSessionId: 's', runtimeGenerationId: 'g', viewId, navigationRequestId: 'n', widgetId }, payload: {} })
		Object.assign(window, { __signals: { latest, producer } })
	}, widgetIds)
	await frames(3)
}

async function latestGeometry(): Promise<Record<string, WidgetGeometry>> {
	return page.evaluate(() => JSON.parse(JSON.stringify((window as never as SignalsWindow).__signals.latest)))
}

/** Producer frames run over the next `count` animation frames, and whether one is still pending. */
async function producerWork(count: number): Promise<Readonly<{ frames: number; pending: boolean }>> {
	const before = await page.evaluate(() => (window as never as SignalsWindow).__signals.producer.stats().frames)
	await frames(count)
	return page.evaluate(before => ({
		frames: (window as never as SignalsWindow).__signals.producer.stats().frames - before,
		pending: (window as never as SignalsWindow).__signals.producer.hasPendingFrame(),
	}), before)
}

describe('Runtime geometry signals (animated occluder paint, #261)', () => {
	it('keeps every pixel an animating occluder paints out of the regions mid-animation, then returns to idle', async () => {
		// Paint-only animations on occluders that are neither a tracked Widget nor its ancestor: a
		// transitioned box-shadow spread, an animated blur filter and a transitioned scale, each
		// starting with no paint beyond the occluder's box.
		const cases = [
			['shadow', '<img alt="" data-start="box-shadow:0 0 0 40px rgb(0,0,0)" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;box-shadow:0 0 0 0 rgb(0,0,0);transition:box-shadow 1000s linear">'],
			['blur', '<div data-start="animation:grow-blur 1000s linear forwards" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;background:rgb(0,0,0);filter:blur(0px)"></div>'],
			['scale', '<div data-start="scale:2" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;background:rgb(0,0,0);mix-blend-mode:multiply;scale:1;transition:scale 1000s linear"></div>'],
		] as const
		const body = '<style>@keyframes grow-blur{from{filter:blur(0px)}to{filter:blur(20px)}}</style>'
			+ cases.map(([id, html], index) => cellPair(id, html, index)).join('')
		await track(body, cases.map(([id]) => id))
		for (const [id, count] of Object.entries(await foreignPixels(await latestGeometry()))) expect(count, `${id} before`).toBe(0)

		await page.evaluate(() => {
			for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-start]'))) element.style.cssText += `;${element.dataset.start}`
		})
		await frames(3)
		// Running animations of occluder paint keep the producer measuring every frame.
		expect((await producerWork(3)).frames).toBeGreaterThanOrEqual(2)
		// Halfway through, frozen so that the screenshot shows the paint the last report saw.
		await page.evaluate(() => {
			for (const animation of document.getAnimations()) {
				animation.currentTime = 500_000
				animation.pause()
			}
		})
		await frames(3)
		const middle = await latestGeometry()
		for (const [id] of cases) expect(middle[id]!.regions.length, `${id} mid-animation`).toBeGreaterThan(0)
		expect(await foreignPixels(middle)).toEqual({ shadow: 0, blur: 0, scale: 0 })

		await page.evaluate(() => {
			for (const animation of document.getAnimations()) animation.finish()
		})
		await frames(3)
		expect(await page.evaluate(() => document.getAnimations().length)).toBe(1)
		const end = await latestGeometry()
		for (const [id, count] of Object.entries(await foreignPixels(end))) expect(count, `${id} after`).toBe(0)
		// Every transition ended; the blur animation fills forwards but no longer runs.
		expect(await producerWork(5)).toEqual({ frames: 0, pending: false })
	})

	it('returns to idle when an endless animation is removed with its element (mutation path)', async () => {
		// A loading spinner removed from the DOM ends its animation, but no animationcancel reaches
		// the document's listeners; the DOM mutation triggers the check that stops measuring.
		await track('<style>@keyframes spin{to{rotate:360deg}}</style>'
			+ cellPair('w', '<div data-probe="spinner" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:50px;background:rgb(0,0,0);animation:spin 1s linear infinite"></div>', 0), ['w'])
		expect((await producerWork(3)).frames).toBeGreaterThanOrEqual(2)
		await page.evaluate(() => document.querySelector('[data-probe="spinner"]')!.remove())
		await frames(3)
		expect(await producerWork(5)).toEqual({ frames: 0, pending: false })
	})

	it('catches a script animation of an occluder that fires no event and no mutation, then returns to idle', async () => {
		await track(cellPair('s', '<img alt="" data-probe="script" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;box-shadow:0 0 0 0 rgb(0,0,0)">', 0), ['s'])
		for (const [id, count] of Object.entries(await foreignPixels(await latestGeometry()))) expect(count, `${id} before`).toBe(0)
		await page.evaluate(() => {
			const element = document.querySelector('[data-probe="script"]') as HTMLElement
			;(window as never as { __anim: Animation }).__anim = element.animate(
				[{ boxShadow: '0 0 0 0 rgb(0,0,0)' }, { boxShadow: '0 0 0 40px rgb(0,0,0)' }],
				{ duration: 1_000_000, fill: 'forwards' },
			)
		})
		// The idle check runs every 250 ms: wait for it to enter continuous mode.
		await page.waitForTimeout(700)
		expect((await producerWork(3)).frames).toBeGreaterThanOrEqual(2)
		await page.evaluate(() => {
			const animation = (window as never as { __anim: Animation }).__anim
			animation.currentTime = 500_000
			animation.pause()
		})
		await frames(3)
		const middle = await latestGeometry()
		expect(middle.s!.regions.length, 'mid-animation').toBeGreaterThan(0)
		expect(await foreignPixels(middle)).toEqual({ s: 0 })
		// Finishing fires no event the listeners use; the 250 ms idle check or the per-frame decision notices it end.
		await page.evaluate(() => (window as never as { __anim: Animation }).__anim.finish())
		await page.waitForTimeout(700)
		expect(await producerWork(5)).toEqual({ frames: 0, pending: false })
	})

	it('notices a script animation whose keyframes change from an inert property to a geometry-relevant one', async () => {
		await track(cellPair('k', '<img alt="" data-probe="keyed" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;box-shadow:0 0 0 0 rgb(0,0,0)">', 0), ['k'])
		await page.evaluate(() => {
			const element = document.querySelector('[data-probe="keyed"]') as HTMLElement
			;(window as never as { __anim: Animation }).__anim = element.animate(
				[{ outlineColor: 'rgb(0,0,0)' }, { outlineColor: 'rgb(255,0,0)' }],
				{ duration: 1_000_000, fill: 'forwards' },
			)
		})
		// Inert property: several idle checks pass and the producer stays idle.
		await page.waitForTimeout(700)
		expect(await producerWork(5)).toEqual({ frames: 0, pending: false })
		await page.evaluate(() => {
			const animation = (window as never as { __anim: Animation }).__anim
			;(animation.effect as KeyframeEffect).setKeyframes([{ boxShadow: '0 0 0 0 rgb(0,0,0)' }, { boxShadow: '0 0 0 40px rgb(0,0,0)' }])
		})
		await page.waitForTimeout(700)
		expect((await producerWork(3)).frames).toBeGreaterThanOrEqual(2)
	})

	it('keeps measuring only on events while an animation changes nothing the measurer reads', async () => {
		await track(cellPair('w', '<div data-probe="o" style="position:absolute;left:LEFTpx;top:TOPpx;width:50px;height:100px;background:rgb(0,0,0);outline:2px solid rgb(0,0,0);transition:outline-color 1000s linear"></div>', 0), ['w'])
		await page.evaluate(() => { (document.querySelector('[data-probe="o"]') as HTMLElement).style.outlineColor = 'rgb(255,0,0)' })
		await frames(3)
		expect(await page.evaluate(() => document.getAnimations().map(animation => animation.playState))).toEqual(['running'])
		expect(await producerWork(5)).toEqual({ frames: 0, pending: false })
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

	it('bounds text shadows like box shadows, without spread or inset', () => {
		expect(textShadowOutsets('none')).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
		expect(textShadowOutsets('rgb(0, 0, 0) 60px 20px 0px')).toEqual({ left: 0, top: 0, right: 60, bottom: 20 })
		expect(textShadowOutsets('rgb(0, 0, 0) 0px 0px 3px, rgb(255, 0, 0) -4px 0px 0px')).toEqual({ left: 8, top: 8, right: 8, bottom: 8 })
		expect(textShadowOutsets('rgb(0, 0, 0) 1px 1px 1px 1px')).toBeUndefined()
		expect(textShadowOutsets('rgb(0, 0, 0) 1px 1px inset')).toBeUndefined()
	})

	it('reads border-image outsets as lengths or multiples of the matching border width', () => {
		const borders = { borderTopWidth: '10px', borderRightWidth: '4px', borderBottomWidth: '6px', borderLeftWidth: '8px' }
		expect(borderImageOutsets({ ...borders, borderImageOutset: '0' })).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
		expect(borderImageOutsets({ ...borders, borderImageOutset: '25px' })).toEqual({ left: 25, top: 25, right: 25, bottom: 25 })
		expect(borderImageOutsets({ ...borders, borderImageOutset: '1 2' })).toEqual({ left: 16, top: 10, right: 8, bottom: 6 })
		expect(borderImageOutsets({ ...borders, borderImageOutset: '5px 1.5 0px 2px' })).toEqual({ left: 2, top: 5, right: 6, bottom: 0 })
		expect(borderImageOutsets({ ...borders, borderImageOutset: '1em' })).toBeUndefined()
		expect(borderImageOutsets({ ...borders, borderImageOutset: '1 2 3 4 5' })).toBeUndefined()
	})

	it('tells 3D transforms from planar ones in computed transform, translate, scale and rotate', () => {
		const none = { transform: 'none', translate: 'none', scale: 'none', rotate: 'none' }
		expect(hasThreeDTransform(none)).toBe(false)
		expect(hasThreeDTransform({ ...none, transform: 'matrix(1, 0, 0, 1, 10, 0)' })).toBe(false)
		expect(hasThreeDTransform({ ...none, transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)' })).toBe(true)
		expect(hasThreeDTransform({ ...none, translate: '10px 20px' })).toBe(false)
		expect(hasThreeDTransform({ ...none, translate: '10px 20px 5px' })).toBe(true)
		expect(hasThreeDTransform({ ...none, scale: '2 2' })).toBe(false)
		expect(hasThreeDTransform({ ...none, scale: '1 1 2' })).toBe(true)
		expect(hasThreeDTransform({ ...none, rotate: '30deg' })).toBe(false)
		expect(hasThreeDTransform({ ...none, rotate: 'z 30deg' })).toBe(false)
		expect(hasThreeDTransform({ ...none, rotate: '0 0 1 30deg' })).toBe(false)
		expect(hasThreeDTransform({ ...none, rotate: 'x 30deg' })).toBe(true)
		expect(hasThreeDTransform({ ...none, rotate: '1 0 0 30deg' })).toBe(true)
	})

	it('reads the length at the end of overflow-clip-margin', () => {
		expect(trailingLength('')).toBe(0)
		expect(trailingLength('0px')).toBe(0)
		expect(trailingLength('content-box')).toBe(0)
		expect(trailingLength('10px')).toBe(10)
		expect(trailingLength('padding-box 2.5px')).toBe(2.5)
		expect(trailingLength('1em')).toBeUndefined()
	})
})
