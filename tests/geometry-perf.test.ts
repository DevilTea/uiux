import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { chromium, type Browser, type Frame, type Page } from 'playwright'
import type { GeometryPerfGlobal } from './support/geometry-perf-entry'

/**
 * Performance harness for multi-target geometry (Part 2/3, 2026-10-05 decision 9).
 *
 * A synthetic View three viewports tall (1280 × 800 content viewport, scaled 0.75 in the outer
 * page) carries 66 Widgets with an opaque sticky header, rounded cards and translucent fixed
 * chrome. The production runtime producer, DOM measurer and signals run inside a same-origin
 * iframe behind the real protocol bridges; the parent runs the real stream coordinator, pin
 * placement and one outer-mapping measurement per frame, and writes pins via `transform` only.
 * The View scrolls continuously for 360 frames, then rests.
 *
 * The decided budgets are for the reference devices (a mainstream Windows laptop, a mid-range
 * Android tablet, a recent iPad). This harness asserts the desktop column on the machine that
 * runs it, which is evidence, not a reference-device measurement.
 */

const ROOT = join(import.meta.dirname, '..')
const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const SCROLL_FRAMES = 360
const BUDGET = { runtimeP95: 4, workbenchP95: 2, combinedP99: 8, reportBytes: 2048 } as const

let browser: Browser
let bundle: string

beforeAll(async () => {
	const result = await build({
		entryPoints: [join(ROOT, 'tests/support/geometry-perf-entry.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		minify: !process.env.GEOMETRY_PERF_PROFILE,
	})
	bundle = result.outputFiles[0]!.text.replaceAll('</script', '<\\/script')
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
})

/** The synthetic View: 66 Widgets in three columns, about 2400px tall. */
function viewDocument(): string {
	const cards: string[] = []
	for (let index = 0; index < 63; index++) {
		const rounded = index % 5 === 0 ? 'border-radius:10px;' : ''
		cards.push(`<div data-widget-id="w${index}" style="height:84px;margin:12px;padding:8px;background:#eef1f8;${rounded}font:14px sans-serif">Widget ${index}<span data-widget-id="label-${index}" style="display:block;margin-top:8px">Label ${index}</span></div>`)
	}
	return `<!doctype html><html><head><style>html,body{margin:0}</style></head><body>
<header data-widget-id="header" style="position:sticky;top:0;z-index:10;height:56px;background:#ffffff;display:flex;gap:12px;align-items:center;padding:0 16px">
	<span data-widget-id="title" style="font:600 16px sans-serif">Synthetic View</span>
	<button data-widget-id="action" style="appearance:none;border:0;background:#4b3fd1;color:#fff;padding:6px 12px">Run</button>
</header>
<main data-widget-id="grid" style="display:grid;grid-template-columns:repeat(3,1fr);padding:8px">${cards.join('')}</main>
<aside data-widget-id="toast" style="position:fixed;right:24px;bottom:24px;width:280px;height:72px;background:rgba(20,20,30,0.6);color:#fff;font:13px sans-serif;padding:8px">Translucent toast</aside>
<script>${bundle}</script>
</body></html>`
}

type Scenario = Readonly<{ name: string; pinWidgets: number; threads: number; extraStreams: number }>

type Measured = Readonly<{
	runtime: number[]
	workbench: number[]
	combined: number[]
	reportsPerFrame: number[]
	streamsPerFrame: number[]
	maxReportBytes: number
	openStreams: number
	visiblePins: number
	idle: Readonly<{ runtimeFrames: number; workbenchFrames: number; messages: number }>
}>

async function runScenario(scenario: Scenario): Promise<Measured> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
	const page: Page = await context.newPage()
	await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}</style></head><body>
<div id="stage" style="position:relative;width:1440px;height:900px;overflow:hidden">
	<div id="layer" style="position:absolute;inset:0">
		<iframe id="preview" style="position:absolute;left:40px;top:30px;width:1280px;height:800px;border:0;transform:scale(0.75);transform-origin:0 0"></iframe>
	</div>
</div>
<script>${bundle}</script></body></html>`)

	// Workbench side: bridge, coordinator, pins and one mapping measurement per frame.
	await page.evaluate(({ viewId, scenario }) => {
		const P = (globalThis as never as GeometryPerfGlobal).UiuxGeometryPerf
		const clock = () => performance.timeOrigin + performance.now()
		const raf = window.requestAnimationFrame.bind(window)
		const state = { frames: 0, accepts: [] as Array<[number, number]>, renders: [] as Array<[number, number]>, messages: 0, maxReportBytes: 0, visiblePins: 0 }
		window.requestAnimationFrame = callback => raf((time) => { state.frames++; callback(time) })
		const iframe = document.getElementById('preview') as HTMLIFrameElement
		const layer = document.getElementById('layer')!
		const bridge = new P.WorkbenchPreviewProtocolBridge('perf-session', {
			send: (message: unknown) => iframe.contentWindow!.postMessage({ channel: 'wire', message }, '*'),
		}, () => ({ ok: true }))
		bridge.admitGeneration('perf-gen', 'initial')
		const streams = new P.GeometryStreamCoordinator({
			send: (message: unknown) => bridge.sendGeometry(message),
			requestFrame: (callback: () => void) => requestAnimationFrame(callback),
			cancelFrame: (handle: number) => cancelAnimationFrame(handle),
		})
		streams.setContext({ previewSessionId: 'perf-session', runtimeGenerationId: 'perf-gen', viewId })
		const statuses = ['ready-for-review', 'open', 'resolved'] as const
		const threads = Array.from({ length: scenario.threads }, (_, index) => ({
			threadId: `t${index}`,
			anchor: { viewId, widgetId: `w${index % scenario.pinWidgets}` },
			status: statuses[index % 3],
			latestActivity: 1_700_000_000_000 + index,
			...(index % 4 === 0 ? { displayHint: { pin: { x: 0.2, y: 0.5 } } } : {}),
		}))
		const extra = Array.from({ length: scenario.extraStreams }, (_, index) => ({ consumerId: `x${index}`, widgetId: `label-${index}`, tier: 'targeting' }))
		streams.setDemand([...extra, ...P.pinGeometryDemand(threads, { viewId })])
		const engine = new P.PinPlacementEngine()
		const pins = threads.map(() => {
			const pin = document.createElement('div')
			pin.style.cssText = 'position:absolute;left:0;top:0;width:24px;height:24px;margin:-24px 0 0 0;border-radius:12px 12px 12px 2px;background:#cb317f;will-change:transform;visibility:hidden'
			layer.appendChild(pin)
			return pin
		})
		let scheduled = false
		function render(): void {
			scheduled = false
			const start = clock()
			// The one forced layout of the frame: the rendered content-box quad, then pure writes.
			const measured = P.measureContentBoxQuad(iframe)
			const box = layer.getBoundingClientRect()
			const mapping = measured.status === 'available'
				? P.deriveOuterMapping({ width: 1280, height: 800 }, {
						p1: { x: measured.quad.p1.x - box.left, y: measured.quad.p1.y - box.top },
						p2: { x: measured.quad.p2.x - box.left, y: measured.quad.p2.y - box.top },
						p3: { x: measured.quad.p3.x - box.left, y: measured.quad.p3.y - box.top },
						p4: { x: measured.quad.p4.x - box.left, y: measured.quad.p4.y - box.top },
					})
				: undefined
			const placements = engine.place(threads, {
				viewId,
				viewport: { width: 1280, height: 800 },
				...(mapping?.status === 'affine' ? { mapping: mapping.mapping } : {}),
				live: true,
				multiTarget: streams.isMultiTarget(),
				report: (widgetId: string) => streams.report(widgetId),
				isTracked: (widgetId: string) => streams.isTracked(widgetId),
			})
			P.clusterPins(placements)
			let visible = 0
			placements.forEach((placement: { state: string; point?: { x: number; y: number } }, index: number) => {
				const pin = pins[index]!
				if (placement.state === 'visible' && placement.point) {
					visible++
					pin.style.transform = `translate(${placement.point.x}px, ${placement.point.y}px)`
					pin.style.visibility = 'visible'
				}
				else pin.style.visibility = 'hidden'
			})
			state.visiblePins = visible
			state.renders.push([start, clock()])
		}
		window.addEventListener('message', (event) => {
			if (!event.data || event.data.channel !== 'wire') return
			state.messages++
			const start = clock()
			const result = bridge.receive(event.data.message)
			if (result.status === 'ack-dispatched') {
				streams.setMultiTarget(event.data.message.payload.features.includes(P.MULTI_TARGET_GEOMETRY_FEATURE))
				streams.setReady(true)
				return
			}
			if (result.status !== 'accepted' || result.message.type !== 'geometry.acquire.response') return
			state.maxReportBytes = Math.max(state.maxReportBytes, JSON.stringify(result.message).length)
			if (streams.accept(result.message) === 'accepted' && !scheduled) {
				scheduled = true
				requestAnimationFrame(render)
			}
			state.accepts.push([start, clock()])
		})
		;(window as never as { __wb: unknown }).__wb = { state, streams }
	}, { viewId: VIEW_ID, scenario })

	await page.evaluate(html => { (document.getElementById('preview') as HTMLIFrameElement).srcdoc = html }, viewDocument())
	const frame: Frame = await (await page.waitForSelector('#preview')).contentFrame() as Frame
	await frame.waitForFunction(() => !!(globalThis as never as { UiuxGeometryPerf?: unknown }).UiuxGeometryPerf)

	// Runtime side: the production producer behind the runtime bridge.
	await frame.evaluate((viewId) => {
		const P = (globalThis as never as GeometryPerfGlobal).UiuxGeometryPerf
		const clock = () => performance.timeOrigin + performance.now()
		const raf = window.requestAnimationFrame.bind(window)
		const state = { frames: 0, passes: [] as Array<[number, number, number]>, sent: 0 }
		window.requestAnimationFrame = callback => raf((time) => { state.frames++; callback(time) })
		const bridge = new P.RuntimePreviewProtocolBridge('perf-session', 'perf-gen', { protocolVersion: 1, features: ['geometry', P.MULTI_TARGET_GEOMETRY_FEATURE] }, {
			send: (message: unknown) => window.parent.postMessage({ channel: 'wire', message }, '*'),
		})
		const measurer = P.createDomGeometryMeasurer({ document })
		let passStart = 0
		let passReports = 0
		const producer = new P.RuntimeGeometryProducer({
			send: (response: unknown) => {
				passReports++
				state.sent++
				bridge.sendGeometry(response)
			},
			measurer: {
				beginPass() { passStart = clock(); passReports = 0; measurer.beginPass() },
				measure: (widgetId: string) => measurer.measure(widgetId),
				endPass() { measurer.endPass(); state.passes.push([passStart, clock(), passReports]) },
			},
			requestFrame: (callback: () => void) => requestAnimationFrame(callback),
			cancelFrame: (handle: number) => cancelAnimationFrame(handle),
		})
		producer.setContext({ viewId })
		P.attachGeometrySignals(window, producer, (id: string) => document.querySelector(`[data-widget-id="${CSS.escape(id)}"]`))
		window.addEventListener('message', (event) => {
			if (!event.data || event.data.channel !== 'wire') return
			const result = bridge.receive(event.data.message)
			if (result.status === 'accepted' && result.message.type.startsWith('geometry.')) producer.receive(result.message)
		})
		;(window as never as { __rt: unknown }).__rt = { state, producer }
		bridge.declareCapabilities()
	}, VIEW_ID)

	const expectedStreams = Math.min(64, scenario.pinWidgets + scenario.extraStreams)
	await page.waitForFunction(count => (window as never as { __wb: { streams: { snapshot(): { streams: unknown[] } } } }).__wb.streams.snapshot().streams.length === count, expectedStreams)
	await frame.waitForFunction(count => (window as never as { __rt: { producer: { trackedWidgetIds(): string[] } } }).__rt.producer.trackedWidgetIds().length === count, expectedStreams)
	await page.waitForTimeout(500)
	const reset = () => Promise.all([
		page.evaluate(() => { const s = (window as never as { __wb: { state: Record<string, unknown[]> } }).__wb.state; s.accepts = []; s.renders = [] }),
		frame.evaluate(() => { (window as never as { __rt: { state: { passes: unknown[] } } }).__rt.state.passes = [] }),
	])
	await reset()

	// GEOMETRY_PERF_PROFILE=<dir> saves a CPU profile of the scroll phase (both documents share the process).
	const profileDir = process.env.GEOMETRY_PERF_PROFILE
	const cdp = profileDir ? await context.newCDPSession(page) : undefined
	if (cdp) {
		await cdp.send('Profiler.enable')
		await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
		await cdp.send('Profiler.start')
	}
	// Continuous scroll: one scroll step per frame for SCROLL_FRAMES frames.
	await frame.evaluate(frames => new Promise<void>((resolve) => {
		let step = 0
		const tick = () => {
			window.scrollBy(0, 4)
			if (++step < frames) requestAnimationFrame(tick)
			else resolve()
		}
		requestAnimationFrame(tick)
	}), SCROLL_FRAMES)
	if (cdp && profileDir) {
		const { profile } = await cdp.send('Profiler.stop')
		await writeFile(join(profileDir, `${scenario.name.replace(/\W+/g, '-')}.cpuprofile`), JSON.stringify(profile))
	}
	await page.waitForTimeout(300)

	const runtime = await frame.evaluate(() => (window as never as { __rt: { state: { passes: Array<[number, number, number]> } } }).__rt.state.passes)
	const workbench = await page.evaluate(() => {
		const s = (window as never as { __wb: { state: { accepts: Array<[number, number]>; renders: Array<[number, number]>; maxReportBytes: number; visiblePins: number } } }).__wb.state
		return { accepts: s.accepts, renders: s.renders, maxReportBytes: s.maxReportBytes, visiblePins: s.visiblePins }
	})

	// Idle: no scroll, no change. Nothing may run or travel.
	const idleBefore = await Promise.all([
		frame.evaluate(() => (window as never as { __rt: { state: { frames: number; sent: number } } }).__rt.state),
		page.evaluate(() => (window as never as { __wb: { state: { frames: number; messages: number } } }).__wb.state),
	])
	await page.waitForTimeout(1500)
	const idleAfter = await Promise.all([
		frame.evaluate(() => (window as never as { __rt: { state: { frames: number; sent: number } } }).__rt.state),
		page.evaluate(() => (window as never as { __wb: { state: { frames: number; messages: number } } }).__wb.state),
	])
	const openStreams = await page.evaluate(() => (window as never as { __wb: { streams: { snapshot(): { streams: unknown[] } } } }).__wb.streams.snapshot().streams.length)
	await context.close()

	// Per runtime frame: runtime pass + Workbench accepts until the next pass + the render they triggered.
	const workbenchFrames: number[] = []
	const combined: number[] = []
	for (let index = 0; index < runtime.length; index++) {
		const [start, end] = runtime[index]!
		const nextStart = runtime[index + 1]?.[0] ?? Number.POSITIVE_INFINITY
		const accepted = workbench.accepts.filter(([at]) => at >= end && at < nextStart).reduce((sum, [a, b]) => sum + (b - a), 0)
		const rendered = workbench.renders.filter(([at]) => at >= end && at < nextStart).reduce((sum, [a, b]) => sum + (b - a), 0)
		workbenchFrames.push(accepted + rendered)
		combined.push(end - start + accepted + rendered)
	}
	return {
		runtime: runtime.map(([start, end]) => end - start),
		workbench: workbenchFrames,
		combined,
		reportsPerFrame: runtime.map(([, , reports]) => reports),
		streamsPerFrame: runtime.map(() => openStreams),
		maxReportBytes: workbench.maxReportBytes,
		openStreams,
		visiblePins: workbench.visiblePins,
		idle: {
			runtimeFrames: idleAfter[0].frames - idleBefore[0].frames,
			workbenchFrames: idleAfter[1].frames - idleBefore[1].frames,
			messages: (idleAfter[0].sent - idleBefore[0].sent) + (idleAfter[1].messages - idleBefore[1].messages),
		},
	}
}

function percentile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b)
	if (!sorted.length) return 0
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

function summarize(name: string, measured: Measured) {
	const round = (value: number) => Math.round(value * 1000) / 1000
	const summary = {
		scenario: name,
		frames: measured.runtime.length,
		openStreams: measured.openStreams,
		visiblePinsAtEnd: measured.visiblePins,
		runtimeMs: { p50: round(percentile(measured.runtime, 50)), p95: round(percentile(measured.runtime, 95)), p99: round(percentile(measured.runtime, 99)), max: round(Math.max(...measured.runtime)) },
		workbenchMs: { p50: round(percentile(measured.workbench, 50)), p95: round(percentile(measured.workbench, 95)), p99: round(percentile(measured.workbench, 99)), max: round(Math.max(...measured.workbench)) },
		combinedMs: { p95: round(percentile(measured.combined, 95)), p99: round(percentile(measured.combined, 99)) },
		maxReportsPerFrame: Math.max(...measured.reportsPerFrame),
		maxReportBytes: measured.maxReportBytes,
		idle: measured.idle,
	}
	console.info(`[geometry-perf] ${JSON.stringify(summary)}`)
	return summary
}

describe('Multi-target geometry performance (decision 9, desktop column on this machine)', () => {
	for (const scenario of [
		{ name: '64 streams, 50 threads on 42 Widgets', pinWidgets: 42, threads: 50, extraStreams: 22 },
		{ name: '64 streams, 64 pins on 64 Widgets', pinWidgets: 63, threads: 64, extraStreams: 1 },
	] satisfies Scenario[]) {
		it(`meets the per-frame budgets while scrolling: ${scenario.name}`, async () => {
			const measured = await runScenario(scenario)
			const summary = summarize(scenario.name, measured)
			expect(summary.openStreams).toBe(64)
			expect(summary.frames).toBeGreaterThan(SCROLL_FRAMES * 0.8)
			expect(summary.runtimeMs.p95).toBeLessThanOrEqual(BUDGET.runtimeP95)
			expect(summary.workbenchMs.p95).toBeLessThanOrEqual(BUDGET.workbenchP95)
			expect(summary.combinedMs.p99).toBeLessThanOrEqual(BUDGET.combinedP99)
			// At most one report per dirty stream per frame, each a small complete baseline.
			expect(summary.maxReportsPerFrame).toBeLessThanOrEqual(summary.openStreams)
			expect(summary.maxReportBytes).toBeLessThanOrEqual(BUDGET.reportBytes)
			// Idle with pins shown and nothing changing: no frames and no messages on either side.
			expect(summary.idle).toEqual({ runtimeFrames: 0, workbenchFrames: 0, messages: 0 })
			expect(summary.visiblePinsAtEnd).toBeGreaterThan(0)
		}, 120_000)
	}
})
