import { chromium, type Browser } from 'playwright'

import { pngSize, thumbnailHeight, thumbnailScaleFactor, THUMBNAIL_WIDTH } from '../../domain/thumbnails/digest'
import type { FileNativePersistence } from '../../persistence'
import type { ThumbnailCapturer } from '../ports/thumbnails'
import { createViewAssetBindingCheck } from './asset-bindings'
import type { AdapterProvenanceSource } from './adapter-provenance'
import { captureHarnessScreenshot, HARNESS_LAUNCH_ARGS, openHarnessPreview, type HarnessPreview } from './capture-harness'
import type { AdapterThemeSupportSource } from './formal-capture'

/** A bound on the wait for web fonts, which formal capture leaves unbounded: a stuck thumbnail must not hold the one capture slot. */
const FONTS_TIMEOUT_MS = 15_000

/**
 * The thumbnail capture engine (Rule 01a19b99-d186-7fa7-abe3-1570a67772a8): the clean Preview Host
 * loaded in the formal capture harness (`openHarnessPreview`, `captureHarnessScreenshot`) as the
 * `system:capture` principal, on one Chromium that is launched by the first capture after a `close`
 * and shared by the captures until the next one. It stores nothing and records no Evidence; the
 * worker stores the PNG it returns. The image is exactly 480 px wide (Clause 01a19b99-cc6d-7bf7-9f15-5250944e198f):
 * the browser context renders the viewport at a pixel ratio of 480 divided by its width.
 */
export function createThumbnailCapturer(persistence: FileNativePersistence, options: Readonly<{
	serverOrigin: string
	captureCookie?: () => Readonly<{ name: string; value: string }> | undefined
	themeSupport?: AdapterThemeSupportSource
	adapterProvenance?: AdapterProvenanceSource
}>): ThumbnailCapturer {
	const bindings = createViewAssetBindingCheck(persistence, options.adapterProvenance)
	let launched: Promise<Browser> | undefined
	let disposed = false

	function browser(): Promise<Browser> {
		if (disposed) return Promise.reject(new Error('the thumbnail capturer was closed'))
		launched ??= chromium.launch({ headless: true, args: [...HARNESS_LAUNCH_ARGS] })
		launched.catch(() => { launched = undefined })
		return launched
	}

	return {
		async capture({ key, context }) {
			// A theme the Adapters do not support, or a View whose `$asset` bindings do not resolve, cannot render: a failed capture.
			const themeSupport = await options.themeSupport?.()
			if (themeSupport?.unsupportedThemeIds.includes(context.themeId)) return { ok: false, reason: `the Adapters do not support the theme ${context.themeId}` }
			const view = await persistence.views.readInspected(key)
			if (!view?.resource) return { ok: false, reason: 'the View was not found' }
			const bindingDiagnostics = await bindings.check(view.resource.ir)
			if (bindingDiagnostics.length > 0) return { ok: false, reason: `an Asset binding does not resolve: ${bindingDiagnostics[0]!.code}` }

			let chromiumBrowser: Browser
			try { chromiumBrowser = await browser() }
			catch (cause) { return { ok: false, reason: `the capture browser could not be launched: ${cause instanceof Error ? cause.message : String(cause)}` } }

			let preview: HarnessPreview | undefined
			try {
				preview = await openHarnessPreview(chromiumBrowser, {
					baseUrl: options.serverOrigin,
					context,
					...(options.captureCookie?.() ? { cookie: options.captureCookie()! } : {}),
					fontsTimeoutMs: FONTS_TIMEOUT_MS,
					deviceScaleFactor: thumbnailScaleFactor(context.viewport),
				})
				if (preview.status !== 'ready') return { ok: false, reason: `the Preview reported '${preview.previewStatus}'` }
				const png = await captureHarnessScreenshot(preview.page)
				if (preview.assetLoadFailures() > 0) return { ok: false, reason: 'a bound Asset did not load in the Preview' }
				const size = pngSize(png)
				const expected = { width: THUMBNAIL_WIDTH, height: thumbnailHeight(context.viewport) }
				if (size?.width !== expected.width || size.height !== expected.height)
					return { ok: false, reason: `the screenshot is ${size ? `${size.width}x${size.height}` : 'not a PNG'}, not ${expected.width}x${expected.height}` }
				return { ok: true, png }
			}
			catch (cause) {
				return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
			}
			finally {
				await preview?.close()
			}
		},
		async close(final = false) {
			if (final) disposed = true
			const pending = launched
			launched = undefined
			if (pending) await (await pending.catch(() => undefined))?.close().catch(() => undefined)
		},
	}
}
