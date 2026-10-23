import type { Browser, Page } from 'playwright'

import type { ResolvedRenderContext } from '../../domain/render-context/schema'

/**
 * The formal capture harness: one render context loaded into the Preview page (`?harness=formal`)
 * in a fresh, isolated browser context, normalized and waited for until it is ready. Formal
 * capture and the Product Kit Checks share it, so a check captures exactly as formal capture does.
 */

/** How long a page load, and then the wait for the Preview's status, may each take. */
export const HARNESS_LOAD_TIMEOUT_MS = 15_000

/**
 * `task`, or a rejection with a `TimeoutError` once `timeoutMs` has passed. It bounds a step that
 * Playwright puts no timeout on (`page.evaluate`); the caller closes the page, which ends the step.
 */
export async function withStepTimeout<T>(task: Promise<T>, timeoutMs: number, step: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`${step} did not finish within ${timeoutMs} ms.`)
			error.name = 'TimeoutError'
			reject(error)
		}, timeoutMs)
	})
	try {
		return await Promise.race([task, timeout])
	}
	finally {
		clearTimeout(timer)
	}
}

/** Stops animations, transitions and the caret, so a capture does not depend on timing. */
export const HARNESS_NORMALIZATION_CSS = `
	*, *::before, *::after {
		animation-duration: 0s !important;
		animation-delay: 0s !important;
		transition-duration: 0s !important;
		transition-delay: 0s !important;
		caret-color: transparent !important;
	}
`

export type HarnessCookie = Readonly<{ name: string; value: string }>

export type HarnessPreview =
	| Readonly<{ status: 'ready'; page: Page; close: () => Promise<void> }>
	/** The Preview settled on another status (`invalid`, `adapter_unavailable`, …). */
	| Readonly<{ status: 'not_ready'; previewStatus: string | null; close: () => Promise<void> }>

/**
 * The `previewStatus` of a Preview that reported ready but showed a bound Asset image that did not
 * decode, so it is not captured.
 */
export const ASSET_LOAD_FAILED_STATUS = 'asset_load_failed'

/**
 * Runs in the Preview page: decodes every `<img>` that shows a bound Asset, by the two URL forms of
 * Clause 01a167f4-401d-7330-ac65-0a900adbccd6, within `timeoutMs`, and returns how many did not decode.
 * A lazy one is loaded now, since the screenshot shows it. Other images are left alone.
 */
export async function decodeBoundAssetImages(input: Readonly<{ timeoutMs: number }>): Promise<number> {
	const prefixes = ['/api/assets/', '/api/history/blobs/']
	const bound = Array.from(document.images).filter((image) => {
		const source = image.currentSrc || image.src
		if (!source) return false
		const url = new URL(source, document.baseURI)
		return url.origin === location.origin && prefixes.some(prefix => url.pathname.startsWith(prefix))
	})
	const results = await Promise.all(bound.map(async (image) => {
		if (image.loading === 'lazy') image.loading = 'eager'
		const decoded = image.decode().then(() => true, () => false)
		const timedOut = new Promise<boolean>(resolve => setTimeout(() => resolve(false), input.timeoutMs))
		return await Promise.race([decoded, timedOut])
	}))
	return results.filter(decoded => !decoded).length
}

/** The Preview page URL of one render context in harness mode. */
export function harnessPreviewUrl(baseUrl: string, context: ResolvedRenderContext): string {
	const url = new URL(`${baseUrl}/preview`)
	url.searchParams.set('viewId', context.viewId)
	url.searchParams.set('locale', context.locale)
	url.searchParams.set('viewportId', context.viewportId)
	url.searchParams.set('viewportWidth', String(context.viewport.width))
	url.searchParams.set('viewportHeight', String(context.viewport.height))
	url.searchParams.set('themeId', context.themeId)
	if (context.variantName) url.searchParams.set('variant', context.variantName)
	url.searchParams.set('harness', 'formal')
	return url.href
}

/**
 * Loads `context` in a new browser context of `browser` and waits until the Preview reports a
 * status other than loading, and its web fonts are ready. The caller closes what it returns; a
 * load that throws closes its browser context before the error propagates.
 */
export async function openHarnessPreview(browser: Browser, input: Readonly<{
	baseUrl: string
	context: ResolvedRenderContext
	cookie?: HarnessCookie
	timeoutMs?: number
	/** A bound on the wait for web fonts. Formal capture passes none, so its wait stays unbounded as before. */
	fontsTimeoutMs?: number
}>): Promise<HarnessPreview> {
	const timeout = input.timeoutMs ?? HARNESS_LOAD_TIMEOUT_MS
	const browserContext = await browser.newContext({
		viewport: { width: input.context.viewport.width, height: input.context.viewport.height },
		reducedMotion: 'reduce',
	})
	const close = async () => {
		await browserContext.close().catch(() => undefined)
	}
	try {
		if (input.cookie)
			await browserContext.addCookies([{ name: input.cookie.name, value: input.cookie.value, url: input.baseUrl, httpOnly: true, sameSite: 'Strict' }])
		const page = await browserContext.newPage()
		await page.goto(harnessPreviewUrl(input.baseUrl, input.context), { waitUntil: 'load', timeout })
		await page.addStyleTag({ content: HARNESS_NORMALIZATION_CSS })
		const statusElement = await page.waitForSelector('[data-preview-status]:not([data-preview-status="loading"])', { timeout })
		const previewStatus = await statusElement?.getAttribute('data-preview-status') ?? null
		if (previewStatus !== 'ready') return { status: 'not_ready', previewStatus, close }
		// Bound Assets render from their resolved URLs (Clause 01a167f4-401d-7330-ac65-0a900adbccd6): every
		// image showing one must decode before the screenshot, and one that does not (its content was
		// replaced since, or its bytes do not decode) fails the context rather than being captured broken.
		const undecoded = await withStepTimeout(page.evaluate(decodeBoundAssetImages, { timeoutMs: timeout }), timeout * 2, 'The Asset image wait')
		if (undecoded > 0) return { status: 'not_ready', previewStatus: ASSET_LOAD_FAILED_STATUS, close }
		const fonts = page.evaluate(() => document.fonts?.ready).then(() => undefined)
		await (input.fontsTimeoutMs === undefined ? fonts : withStepTimeout(fonts, input.fontsTimeoutMs, 'The web font wait'))
		return { status: 'ready', page, close }
	}
	catch (cause) {
		await close()
		throw cause
	}
}

/** The viewport's PNG bytes, as formal capture stores them. */
export async function captureHarnessScreenshot(page: Page): Promise<Uint8Array> {
	return await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' })
}
