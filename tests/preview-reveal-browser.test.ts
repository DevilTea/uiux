import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright'

/**
 * What a runtime that declares `geometry.reveal` does with a reveal (Clauses
 * 01a11a59-da48-7437-bee8-67787175cbda and 01a11a70-3d8d-7e52-9412-8a92797814e6; issue #105),
 * in a real browser: the production `src/preview/reveal.ts` is bundled and run in plain documents
 * whose layout (nested scrollers, hidden chains, fixed boxes, a containing iframe) is the input.
 */

let browser: Browser
let script = ''

beforeAll(async () => {
	const result = await build({
		entryPoints: [join(import.meta.dirname, '..', 'src', 'preview', 'reveal.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'reveal',
		platform: 'browser',
	})
	script = result.outputFiles[0]!.text
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => { await browser?.close() })

type Api = { revealWidget(doc: Document, widgetId: string): 'scrolled' | 'none' }
type Win = Window & { reveal: Api }

async function open(html: string): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
	await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}</style></head><body>${html}</body></html>`)
	await page.addScriptTag({ content: script })
	return page
}

const reveal = (page: Page, widgetId: string) => page.evaluate(id => (window as unknown as Win).reveal.revealWidget(document, id), widgetId)
const scrollOf = (page: Page, selector: string) => page.evaluate(sel => {
	const element = sel === 'root' ? document.scrollingElement! : document.querySelector(sel)!
	return { top: Math.round(element.scrollTop), left: Math.round(element.scrollLeft) }
}, selector)
const boxOf = (page: Page, widgetId: string) => page.evaluate(id => {
	const rect = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
	return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) }
}, widgetId)

describe('a reveal scrolls only what brings an offscreen Widget into view', () => {
	it('scrolls the root scroller, instantly and by the least movement', async () => {
		const page = await open('<div style="height:2000px"></div><div data-widget-id="far" style="height:40px">far</div><div style="height:2000px"></div>')
		try {
			expect(await reveal(page, 'far')).toBe('scrolled')
			// The Widget's end meets the bottom edge of the viewport: nothing more than needed moved.
			expect(await boxOf(page, 'far')).toMatchObject({ top: 260, bottom: 300 })
			expect(await scrollOf(page, 'root')).toEqual({ top: 1740, left: 0 })
			// Back above the viewport: its start meets the top edge.
			await page.evaluate(() => { document.scrollingElement!.scrollTop = 4000 })
			expect(await reveal(page, 'far')).toBe('scrolled')
			expect(await boxOf(page, 'far')).toMatchObject({ top: 0, bottom: 40 })
		}
		finally { await page.close() }
	})

	it('scrolls instantly even under a smooth scroll-behavior', async () => {
		const page = await open('<style>html,.inner{scroll-behavior:smooth}</style><div style="height:3000px"></div><div data-widget-id="far" style="height:40px">far</div><div style="height:100px"></div>')
		try {
			// Read in the same task: a smooth scroll would not have moved yet.
			const result = await page.evaluate(() => ({
				outcome: (window as unknown as Win).reveal.revealWidget(document, 'far'),
				top: Math.round(document.scrollingElement!.scrollTop),
			}))
			expect(result).toEqual({ outcome: 'scrolled', top: 2740 })
		}
		finally { await page.close() }
	})

	it('does not scroll a Widget that has a part in view, and highlights it in place', async () => {
		const page = await open('<div style="height:270px"></div><div data-widget-id="partly" style="height:100px">partly</div><div style="height:3000px"></div>')
		try {
			expect(await reveal(page, 'partly')).toBe('none')
			expect(await scrollOf(page, 'root')).toEqual({ top: 0, left: 0 })
		}
		finally { await page.close() }
	})

	it('scrolls only the nearest scroll container when that is enough', async () => {
		const page = await open('<div class="inner" style="height:100px;overflow:auto"><div style="height:1000px"></div><div data-widget-id="deep" style="height:20px">deep</div><div style="height:300px"></div></div><div style="height:3000px"></div>')
		try {
			expect(await reveal(page, 'deep')).toBe('scrolled')
			expect(await scrollOf(page, 'root')).toEqual({ top: 0, left: 0 })
			expect(await scrollOf(page, '.inner')).toEqual({ top: 920, left: 0 })
			expect(await boxOf(page, 'deep')).toMatchObject({ top: 80, bottom: 100 })
		}
		finally { await page.close() }
	})

	it('scrolls the container and then the root scroller when the container itself is offscreen', async () => {
		const page = await open('<div style="height:1500px"></div><div class="inner" style="height:100px;overflow:auto"><div style="height:1000px"></div><div data-widget-id="deep" style="height:20px">deep</div><div style="height:300px"></div></div><div style="height:3000px"></div>')
		try {
			expect(await reveal(page, 'deep')).toBe('scrolled')
			expect(await scrollOf(page, '.inner')).toEqual({ top: 920, left: 0 })
			const box = await boxOf(page, 'deep')
			expect(box.top).toBeGreaterThanOrEqual(0)
			expect(box.bottom).toBeLessThanOrEqual(300)
			expect((await scrollOf(page, 'root')).top).toBeGreaterThan(0)
		}
		finally { await page.close() }
	})

	it('reveals a Widget that a scroll container clips although the viewport shows its place', async () => {
		const page = await open('<div class="inner" style="height:100px;overflow:hidden"><div style="height:500px"></div><div data-widget-id="clipped" style="height:20px">clipped</div></div>')
		try {
			expect(await reveal(page, 'clipped')).toBe('scrolled')
			expect(await boxOf(page, 'clipped')).toMatchObject({ top: 80, bottom: 100 })
		}
		finally { await page.close() }
	})

	it('scrolls horizontally too', async () => {
		const page = await open('<div class="inner" style="width:200px;height:60px;overflow:auto"><div style="width:2000px;height:20px;position:relative"><div data-widget-id="right" style="position:absolute;left:1500px;width:50px;height:20px">r</div></div></div>')
		try {
			expect(await reveal(page, 'right')).toBe('scrolled')
			expect(await boxOf(page, 'right')).toMatchObject({ left: 150, right: 200 })
		}
		finally { await page.close() }
	})
})

describe('a reveal does nothing for a Widget it cannot or must not scroll to', () => {
	const cases: ReadonlyArray<readonly [string, string]> = [
		['display none on its chain', '<div style="display:none"><div data-widget-id="w">x</div></div>'],
		['visibility hidden', '<div data-widget-id="w" style="visibility:hidden;height:40px">x</div>'],
		['zero opacity on an ancestor', '<div style="opacity:0"><div data-widget-id="w" style="height:40px">x</div></div>'],
		['zero opacity on itself', '<div data-widget-id="w" style="opacity:0;height:40px">x</div>'],
		['no rendered box (zero height)', '<div data-widget-id="w" style="height:0"></div>'],
		['no rendered box (display contents)', '<div data-widget-id="w" style="display:contents"><span>x</span></div>'],
		['a fixed box outside the viewport', '<div data-widget-id="w" style="position:fixed;top:2000px;left:0;height:40px;width:40px">x</div>'],
	]
	for (const [name, markup] of cases) {
		it(`${name}`, async () => {
			const page = await open(`<div style="height:300px"></div>${markup.replace('<div data-widget-id="w"', '<div data-widget-id="w"')}<div style="height:3000px"></div>`)
			try {
				expect(await reveal(page, 'w')).toBe('none')
				expect(await scrollOf(page, 'root')).toEqual({ top: 0, left: 0 })
			}
			finally { await page.close() }
		})
	}

	it('an unknown Widget', async () => {
		const page = await open('<div style="height:3000px"></div>')
		try {
			expect(await reveal(page, 'missing')).toBe('none')
			expect(await scrollOf(page, 'root')).toEqual({ top: 0, left: 0 })
		}
		finally { await page.close() }
	})

	it('a hidden Widget whose container is also offscreen scrolls neither', async () => {
		const page = await open('<div style="height:1500px"></div><div class="inner" style="height:100px;overflow:auto"><div style="height:1000px"></div><div data-widget-id="w" style="visibility:hidden;height:20px">x</div></div><div style="height:3000px"></div>')
		try {
			expect(await reveal(page, 'w')).toBe('none')
			expect(await scrollOf(page, 'root')).toEqual({ top: 0, left: 0 })
			expect(await scrollOf(page, '.inner')).toEqual({ top: 0, left: 0 })
		}
		finally { await page.close() }
	})

	it('an absolutely positioned Widget escapes the scroll container it is not contained by', async () => {
		const page = await open('<div class="inner" style="height:100px;overflow:auto"><div style="height:1000px"></div></div><div data-widget-id="w" style="position:absolute;top:2000px;left:0;height:20px;width:20px">x</div><div style="height:3000px"></div>')
		try {
			expect(await reveal(page, 'w')).toBe('scrolled')
			expect(await scrollOf(page, '.inner')).toEqual({ top: 0, left: 0 })
			expect((await scrollOf(page, 'root')).top).toBeGreaterThan(0)
		}
		finally { await page.close() }
	})
})

describe('a reveal changes nothing but scroll positions of its own document', () => {
	it('moves no focus, mutates no DOM and dispatches no click, focus or input event', async () => {
		const page = await open('<input id="field" /><div style="height:2000px"></div><button data-widget-id="far" style="height:40px">far</button><div style="height:2000px"></div>')
		try {
			await page.focus('#field')
			const outcome = await page.evaluate(async () => {
				const mutations: unknown[] = []
				const observer = new MutationObserver(records => mutations.push(...records))
				observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
				const events: string[] = []
				for (const type of ['click', 'focus', 'focusin', 'blur', 'input', 'change', 'mouseover', 'pointerdown']) document.addEventListener(type, () => events.push(type), true)
				const result = (window as unknown as Win).reveal.revealWidget(document, 'far')
				await new Promise(resolve => setTimeout(resolve, 100))
				observer.disconnect()
				return { result, mutations: mutations.length, events, active: document.activeElement?.id }
			})
			expect(outcome).toEqual({ result: 'scrolled', mutations: 0, events: [], active: 'field' })
		}
		finally { await page.close() }
	})

	it('never scrolls the document that contains its iframe', async () => {
		const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
		try {
			await page.setContent('<!doctype html><html><body style="margin:0"><div style="height:200px"></div><iframe id="preview" style="width:300px;height:100px;border:0;display:block" srcdoc="&lt;body style=&quot;margin:0&quot;&gt;&lt;div style=&quot;height:2000px&quot;&gt;&lt;/div&gt;&lt;div data-widget-id=&quot;far&quot; style=&quot;height:20px&quot;&gt;far&lt;/div&gt;&lt;div style=&quot;height:500px&quot;&gt;&lt;/div&gt;"></iframe><div style="height:3000px"></div></body></html>')
			const handle = await page.waitForSelector('#preview')
			const frame = (await handle.contentFrame())!
			await frame.waitForSelector('[data-widget-id="far"]')
			await frame.addScriptTag({ content: script })
			// The iframe itself is partly outside the outer viewport once the outer page scrolls: a scrollIntoView would move the outer page.
			await page.evaluate(() => window.scrollTo(0, 0))
			const result = await frame.evaluate(() => (window as unknown as Win).reveal.revealWidget(document, 'far'))
			expect(result).toBe('scrolled')
			expect(await frame.evaluate(() => Math.round(document.scrollingElement!.scrollTop))).toBe(1920)
			expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0)
		}
		finally { await page.close() }
	})
})
