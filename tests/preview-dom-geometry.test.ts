import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright'
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

	it('fails closed instead of guessing: rotation, filters, unknown paint order, replaced content above', async () => {
		const result = await measure(`
			<div data-widget-id="rotated" style="position:absolute;left:0;top:0;width:100px;height:50px;transform:rotate(10deg);background:#eee"></div>
			<div data-widget-id="filtered" style="position:absolute;left:0;top:100px;width:100px;height:50px;filter:blur(2px);background:#eee"></div>
			<div style="position:absolute;left:0;top:200px;width:300px">
				<div data-widget-id="flow" style="height:50px;background:#eee"></div>
				<div style="margin-top:-20px;height:50px;background:rgb(0,0,0)"></div>
			</div>
			<div data-widget-id="under-image" style="position:absolute;left:400px;top:0;width:100px;height:100px;background:#eee"></div>
			<img style="position:absolute;left:420px;top:20px;width:20px;height:20px" alt="">`, ['rotated', 'filtered', 'flow', 'under-image'])
		for (const id of ['rotated', 'filtered', 'flow', 'under-image']) {
			expect(result[id]!.rect.width, id).toBeGreaterThan(0)
			expect(result[id]!.regions, id).toEqual([])
		}
	})
})
