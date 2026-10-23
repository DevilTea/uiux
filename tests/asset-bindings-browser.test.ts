import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { decodeBoundAssetImages } from '../src/application/services/capture-harness'
import { bearer, provisionToken } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * `$asset` bindings in the Preview (issue #97; Discussion #241 owner rulings 2026-10-23), against the
 * built server and a private copy of the fixture Workspace, whose Product Kit gains a second Adapter
 * with a `Picture` Widget whose `src` field accepts the `image` category:
 *
 * - a View binding the fixture's SVG Asset renders it from the resolved URL, and the Widget receives
 *   `{ url, mediaType, contentDigest }` (Clauses 01a167f4-3e4e-7af1-b328-30fb52f7f4c5 and
 *   01a167f4-401d-7330-ac65-0a900adbccd6; Rules 01a115cd-bf1c-7ab1-933d-c03322035cc5 and 01a115cd-bf4e-71ae-9fdb-74cc91862738);
 * - writing a View that binds a missing Asset is not refused (Rule 01a167f4-456c-78c5-b7e1-843cb39bcab8),
 *   but its Preview is invalid with the diagnostic and renders nothing (Rules 01a115cd-c09f-7018-9f52-48b05284f600,
 *   01a115cd-c0d2-7427-8a95-927b2b3518c9 and 01a115cd-c106-71d6-b1f8-4d59cab22ad2), its server-side View
 *   diagnostics list it (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c), and capture is refused;
 * - replacing the bound Asset makes the open Preview resolve again (Rule 01a167f4-48f2-7460-8c12-dfc4cda35cd0),
 *   and the old URL is refused with 409 (Clause 01a167f4-41f2-70a1-a200-a005d47b12b5).
 */

const ASSET_ID = '49bd68d5-55ce-49c9-b342-a8cfbef4ce45'
const MISSING_ID = '99999999-9999-4999-8999-999999999999'
const SPEC = { intent: 'Show an Asset', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }

const PICTURE_ADAPTER = `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';
import { useWidget } from '@deviltea/widget-vue';

export const picturePlugin = createWidgetPlugin('Picture')
  .interfaces()
  .config({
    schema: {
      type: 'object',
      properties: { src: { type: 'object', properties: { url: { type: 'string' }, mediaType: { type: 'string' }, contentDigest: { type: 'string' } }, required: ['url', 'mediaType', 'contentDigest'] } },
      additionalProperties: false,
    },
    validate: (input) => input === null || (typeof input === 'object' && !Array.isArray(input)),
    resolve: (raw) => ({ src: raw?.src ?? null }),
  })
  .properties(p => p.source({ compute: ({ config }) => config.src }))
  .done();

export const PictureRenderer = defineComponent({
  name: 'PictureRenderer',
  setup() {
    const { widgetId, useProperties } = useWidget(picturePlugin);
    const properties = useProperties();
    return () => {
      const source = properties.source.value;
      return h('img', {
        'data-widget-id': widgetId,
        class: 'asset-picture',
        src: source?.url,
        'data-media-type': source?.mediaType,
        'data-content-digest': source?.contentDigest,
        width: 64,
        height: 64,
        alt: '',
      });
    };
  },
});

export const backdropPlugin = createWidgetPlugin('Backdrop')
  .interfaces()
  .config({
    schema: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false },
    validate: (input) => input === null || (typeof input === 'object' && !Array.isArray(input)),
    resolve: (raw) => ({ url: raw?.url ?? '' }),
  })
  .properties(p => p.url({ compute: ({ config }) => config.url }))
  .done();

export const BackdropRenderer = defineComponent({
  name: 'BackdropRenderer',
  setup() {
    const { widgetId, useProperties } = useWidget(backdropPlugin);
    const properties = useProperties();
    return () => h('div', {
      'data-widget-id': widgetId,
      class: 'asset-backdrop',
      style: { width: '64px', height: '64px', backgroundImage: 'url(' + properties.url.value + ')' },
    });
  },
});

export const manifest = {
  id: 'asset-picture',
  apiVersion: '1',
  widgetPlugins: [picturePlugin, backdropPlugin],
  catalog: { widgets: { Picture: { assetFields: { src: { acceptedCategories: ['image'] } } } } },
  renderers: [{ type: 'Picture', component: PictureRenderer }, { type: 'Backdrop', component: BackdropRenderer }],
  providers: [],
};
`

let server: WorkbenchServer
let browser: Browser
let boundViewId: string
let missingViewId: string
/** A PNG Asset whose bytes carry the PNG signature, so it is a valid Asset, but do not decode. */
let brokenAssetId: string
let brokenViewId: string
/** A PDF Asset, which the `image` category of `src` does not accept. */
let pdfViewId: string

async function editJson(path: string, edit: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
	await writeFile(path, JSON.stringify(edit(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>)))
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
	return await fetch(`${server.origin}${path}`, { ...init, headers: { ...server.headers, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } })
}

/** Creates a View through the authoring routes whose root holds one Picture with `src` bound to `assetId`. */
async function createPictureView(name: string, assetId: string, extraConfig: Record<string, unknown> = {}): Promise<string> {
	const created = await api('/api/views', { method: 'POST', body: JSON.stringify({ name, spec: SPEC }) })
	expect(created.status, await created.clone().text()).toBe(201)
	const { key, revision } = await created.json() as { key: string; revision: string }
	const ir = { type: 'RootShell', id: 'root', slots: { content: [{ id: 'picture', type: 'Picture', config: { src: { $asset: assetId }, ...extraConfig } }] } }
	const structured = await api(`/api/views/${key}/structure`, { method: 'PUT', body: JSON.stringify({ expectedRevision: revision, ir, variants: {} }) })
	// Writing a View is never refused for an invalid Asset binding (Rule 01a167f4-456c-78c5-b7e1-843cb39bcab8).
	expect(structured.status, await structured.clone().text()).toBe(200)
	return key
}

async function createAsset(contentFilename: string, mediaType: string, bytes: Buffer): Promise<string> {
	const created = await api('/api/assets', { method: 'POST', body: JSON.stringify({ name: contentFilename, contentFilename, mediaType, contentBase64: bytes.toString('base64') }) })
	expect(created.status, await created.clone().text()).toBe(201)
	return (await created.json() as { key: string }).key
}

function capture(viewId: string): Promise<Response> {
	return api('/api/evidence/capture', {
		method: 'POST',
		body: JSON.stringify({ contexts: [{ viewId, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1920, height: 1080 }, themeId: 'light' }] }),
	})
}

beforeAll(async () => {
	server = await startWorkbenchServer({
		async prepare(root) {
			await writeFile(join(root, 'kit', 'adapters', 'asset-picture.mjs'), PICTURE_ADAPTER)
			await editJson(join(root, 'product-kit.json'), productKit => ({ ...productKit, adapters: [...(productKit.adapters as unknown[]), { moduleSpecifier: './adapters/asset-picture.mjs' }] }))
		},
	})
	browser = await chromium.launch({ headless: true })
	boundViewId = await createPictureView('Bound logo', ASSET_ID)
	missingViewId = await createPictureView('Missing logo', MISSING_ID)
	brokenAssetId = await createAsset('broken.png', 'image/png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not an image')]))
	brokenViewId = await createPictureView('Broken logo', brokenAssetId)
	pdfViewId = await createPictureView('PDF logo', await createAsset('doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%not much of a document\n')))
}, 90_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

async function settledStatus(frame: Page | Frame): Promise<string | null> {
	const status = await frame.waitForSelector('[data-preview-status]:not([data-preview-status="loading"])', { timeout: 20_000 })
	return await status.getAttribute('data-preview-status')
}

async function currentDigest(): Promise<string> {
	const read = await api(`/api/preview/assets?ids=${ASSET_ID}`)
	expect(read.status).toBe(200)
	const body = await read.json() as { assets: Record<string, { state: string; value: { contentDigest: string } }> }
	expect(body.assets[ASSET_ID]!.state).toBe('ready')
	return body.assets[ASSET_ID]!.value.contentDigest
}

describe('a View that binds an Asset (issue #97)', () => {
	it('renders the Asset from its resolved URL, and the Widget receives the runtime value', async () => {
		const digest = await currentDigest()
		const { context, page } = await open(`/preview?viewId=${boundViewId}&locale=en-US`)
		try {
			expect(await settledStatus(page)).toBe('ready')
			const image = page.locator('img.asset-picture')
			await image.waitFor({ timeout: 15_000 })
			expect(await image.getAttribute('src')).toBe(`/api/assets/${ASSET_ID}/content?digest=${digest}`)
			expect(await image.getAttribute('data-media-type')).toBe('image/svg+xml')
			expect(await image.getAttribute('data-content-digest')).toBe(digest)
			await page.waitForFunction(() => {
				const element = document.querySelector<HTMLImageElement>('img.asset-picture')
				return Boolean(element?.complete && element.naturalWidth > 0)
			}, undefined, { timeout: 15_000 })
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('does not render a View that binds a missing Asset, and shows the diagnostic instead', async () => {
		const { context, page } = await open(`/preview?viewId=${missingViewId}&locale=en-US`)
		try {
			expect(await settledStatus(page)).toBe('invalid')
			const text = await page.locator('[data-preview-status="invalid"]').textContent()
			expect(text).toContain('asset.missing_reference')
			expect(text).toContain('/config/src/$asset')
			expect(await page.locator('img.asset-picture').count()).toBe(0)
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('lists the binding\'s diagnostic in the View\'s server-side diagnostics, which Checks read (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c)', async () => {
		const diagnosticsOf = async (viewId: string) => ((await (await api(`/api/resources/view/${viewId}`)).json()) as { diagnostics: readonly { code: string; path: string }[] }).diagnostics
		expect(await diagnosticsOf(missingViewId)).toEqual([expect.objectContaining({ code: 'asset.missing_reference', path: '/ir/slots/content/0/config/src/$asset' })])
		expect((await diagnosticsOf(boundViewId)).filter(item => item.code.startsWith('asset.'))).toEqual([])
		// The Catalog of the Adapters the Preview renders with decides which fields are asset-capable.
		const posterViewId = await createPictureView('Poster logo', ASSET_ID, { poster: { $asset: ASSET_ID } })
		expect(await diagnosticsOf(posterViewId)).toEqual([expect.objectContaining({ code: 'asset.field_not_capable', path: '/ir/slots/content/0/config/poster' })])
	}, 60_000)

	it('captures the bound View, and refuses to capture a View whose bound Asset is missing or does not decode', async () => {
		// The binding check fails the context with the binding's diagnostics before a browser runs.
		const refused = await capture(missingViewId)
		expect(refused.status).toBe(422)
		expect(await refused.json()).toMatchObject({ status: 'failed', results: [{ status: 'failed', diagnostics: [{ code: 'asset.missing_reference', path: '/ir/slots/content/0/config/src/$asset' }] }] })
		// A valid Asset whose image does not decode is not captured broken.
		const undecodable = await capture(brokenViewId)
		expect(undecodable.status).toBe(422)
		expect(await undecodable.json()).toMatchObject({ status: 'failed', results: [{ status: 'failed', diagnostics: [{ code: 'capture.asset_load_failed' }] }] })
		const captured = await capture(boundViewId)
		expect(captured.status, await captured.clone().text()).toBe(200)
	}, 120_000)

	it('refuses to capture a View whose CSS background request for a bound Asset fails, which no <img> decode check sees', async () => {
		const created = await api('/api/views', { method: 'POST', body: JSON.stringify({ name: 'Stale backdrop', spec: SPEC }) })
		expect(created.status, await created.clone().text()).toBe(201)
		const { key, revision } = await created.json() as { key: string; revision: string }
		const backdrop = (url: string) => ({ type: 'RootShell', id: 'root', slots: { content: [{ id: 'backdrop', type: 'Backdrop', config: { url } }] } })
		const write = async (url: string, expectedRevision: string) => {
			const structured = await api(`/api/views/${key}/structure`, { method: 'PUT', body: JSON.stringify({ expectedRevision, ir: backdrop(url), variants: {} }) })
			expect(structured.status, await structured.clone().text()).toBe(200)
			return ((await structured.json()) as { revision: string }).revision
		}
		// A request for a digest the Asset no longer has answers 409, and the background silently stays empty.
		const stale = `/api/assets/${ASSET_ID}/content?digest=sha256:${'0'.repeat(64)}`
		const revisionAfter = await write(stale, revision)
		const failed = await capture(key)
		expect(failed.status).toBe(422)
		expect(await failed.json()).toMatchObject({ status: 'failed', results: [{ status: 'failed', diagnostics: [{ code: 'capture.asset_load_failed' }] }] })
		// The same View with the current digest loads, and is captured.
		await write(`/api/assets/${ASSET_ID}/content?digest=${await currentDigest()}`, revisionAfter)
		const captured = await capture(key)
		expect(captured.status, await captured.clone().text()).toBe(200)
	}, 120_000)

	it('counts, before a capture, the bound Asset images that do not decode, and leaves other images alone', async () => {
		const digest = await currentDigest()
		const { context, page } = await open(`/preview?viewId=${boundViewId}&locale=en-US`)
		try {
			expect(await settledStatus(page)).toBe('ready')
			await page.evaluate(({ asset, broken, stale, current }) => {
				const add = (src: string, lazy = false) => {
					const image = document.createElement('img')
					if (lazy) {
						image.loading = 'lazy'
						image.style.marginTop = '5000px'
					}
					image.src = src
					document.body.append(image)
				}
				add(`/api/assets/${asset}/content?digest=${stale}`) // 409: the content no longer has this digest
				add(`/api/assets/${broken}/content`) // the bytes do not decode
				add(`/api/assets/${asset}/content?digest=${current}`, true) // lazy and below the fold, but bound: loaded and decoded
				add('/api/health', true) // not a bound Asset: never waited for
			}, { asset: ASSET_ID, broken: brokenAssetId, stale: `sha256:${'0'.repeat(64)}`, current: digest })
			expect(await page.evaluate(decodeBoundAssetImages, { timeoutMs: 10_000 })).toBe(2)
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('reports an Asset the field does not accept in the View\'s server-side diagnostics', async () => {
		const read = await api(`/api/resources/view/${pdfViewId}`)
		const { diagnostics } = await read.json() as { diagnostics: readonly { code: string; path: string }[] }
		expect(diagnostics).toEqual([expect.objectContaining({ code: 'asset.incompatible_media_type', path: '/ir/slots/content/0/config/src' })])
	}, 30_000)

	it('resolves Assets for a Preview only with a credential that holds workspace.read', async () => {
		expect((await fetch(`${server.origin}/api/preview/assets?ids=${ASSET_ID}`)).status).toBe(401)
		const keyless = await provisionToken(server.workspaceRoot, { nickname: 'keyless', kind: 'human', keys: [] })
		expect((await fetch(`${server.origin}/api/preview/assets?ids=${ASSET_ID}`, { headers: bearer(keyless) })).status).toBe(403)
	}, 30_000)

	it('renders an SVG Asset in a version frame from the version blob', async () => {
		const checkpoint = await api('/api/history/checkpoints', { method: 'POST', body: JSON.stringify({ name: 'Logo before replacement' }) })
		expect(checkpoint.status, await checkpoint.clone().text()).toBe(201)
		const { versionId } = await checkpoint.json() as { versionId: string }
		const { context, page } = await open(`/preview?viewId=${boundViewId}&locale=en-US&version=${versionId}`)
		try {
			expect(await settledStatus(page)).toBe('ready')
			const image = page.locator('img.asset-picture')
			await image.waitFor({ timeout: 15_000 })
			expect(await image.getAttribute('src')).toMatch(/^\/api\/history\/blobs\/sha256:[0-9a-f]{64}$/u)
			expect(await image.getAttribute('data-media-type')).toBe('image/svg+xml')
			expect(await page.evaluate(decodeBoundAssetImages, { timeoutMs: 10_000 })).toBe(0)
			expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('resolves the open Preview again when the bound Asset is replaced, and refuses the old URL', async () => {
		const before = await currentDigest()
		const { context, page } = await open(`/views/${boundViewId}`)
		try {
			const handle = await page.waitForSelector(`iframe[src*="/preview"][src*="viewId=${boundViewId}"]`, { timeout: 20_000 })
			const frame = (await handle.contentFrame())!
			await frame.locator('img.asset-picture').waitFor({ timeout: 20_000 })
			expect(await frame.locator('img.asset-picture').getAttribute('data-content-digest')).toBe(before)

			const read = await api(`/api/resources/asset/${ASSET_ID}`)
			const { revision } = await read.json() as { revision: string }
			const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#16a34a"/></svg>'
			const replaced = await api(`/api/assets/${ASSET_ID}`, {
				method: 'PUT',
				body: JSON.stringify({ expectedRevision: revision, name: 'test-icon', contentFilename: 'test-icon.svg', mediaType: 'image/svg+xml', contentBase64: Buffer.from(svg).toString('base64') }),
			})
			expect(replaced.status, await replaced.clone().text()).toBe(200)
			const after = await currentDigest()
			expect(after).not.toBe(before)

			// A new Preview generation renders the replaced content from its new URL.
			await page.waitForFunction((digest) => {
				const frames = Array.from(document.querySelectorAll('iframe'))
				return frames.some(element => element.contentDocument?.querySelector(`img.asset-picture[data-content-digest="${digest}"]`))
			}, after, { timeout: 30_000 })

			const stale = await api(`/api/assets/${ASSET_ID}/content?digest=${before}`)
			expect(stale.status).toBe(409)
			expect(await stale.json()).toMatchObject({ code: 'asset_content_digest_mismatch' })
			expect((await api(`/api/assets/${ASSET_ID}/content?digest=${after}`)).status).toBe(200)
		}
		finally {
			await context.close()
		}
	}, 90_000)
})
