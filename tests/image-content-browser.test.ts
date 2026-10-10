import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Stored image content shown or linked by the Workbench renders without giving its own markup the
 * Workbench origin. Each SVG below carries an inline script that, if it ever runs on the Workbench
 * origin, writes a marker into that origin's localStorage and logs the origin it ran on. The tests
 * open every address the Workbench shows such an image at as a top-level document (the way "Open
 * image in new tab" or a pasted address does) and check that no marker appears:
 *
 * - the Asset content route, which Asset pages link to and use as `<img src>`;
 * - the address of an Asset image in a version comparison (`HistoryImage`), for both the image the
 *   Asset no longer holds (version blob route) and its current content (Asset content route).
 *
 * They also check that the byte routes answer with a sandboxing Content-Security-Policy while every
 * response still carries the baseline framing policy (Clause 01a11485-f9df-73d4-9f47-85c9d559360c).
 */

let server: WorkbenchServer
let browser: Browser

const SENTINEL = 'uiux.test.storedContentScript'
const unique = () => randomUUID().slice(0, 8)

function scriptedSvg(label: string): string {
	return [
		'<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">',
		`<title>${label}</title>`,
		'<rect width="48" height="48" fill="#2563eb"/>',
		`<script>try { localStorage.setItem(${JSON.stringify(SENTINEL)}, String(self.origin)) } catch (error) {} console.log('stored-content-script ' + self.origin)</script>`,
		'</svg>',
	].join('')
}

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

async function createSvgAsset(label: string): Promise<{ id: string; revision: string }> {
	const id = randomUUID()
	const created = await api<{ revision: string }>('/api/assets', {
		id,
		name: label,
		contentFilename: `${label}.svg`,
		mediaType: 'image/svg+xml',
		contentBase64: Buffer.from(scriptedSvg(label)).toString('base64'),
	})
	return { id, revision: created.revision }
}

async function checkpoint(name: string): Promise<string> {
	return (await api<{ versionId: string }>('/api/history/checkpoints', { name })).versionId
}

/** A browser context signed in as the Owner, with one page kept on the Workbench origin. */
async function signedIn(path: string): Promise<{ context: BrowserContext; page: Page; markers: string[] }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const markers: string[] = []
	const record = (message: ConsoleMessage) => {
		if (message.text().startsWith('stored-content-script ')) markers.push(message.text())
	}
	context.on('page', created => created.on('console', record))
	const page = await context.newPage()
	page.on('console', record)
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page, markers }
}

/**
 * Opens `address` as a top-level document in a new tab of the same signed-in context. `goto` is a
 * browser-initiated navigation, the most permissive kind (like a pasted address), so a `data:`
 * address does load here; it must still never run with the Workbench origin.
 */
async function openTopLevel(context: BrowserContext, address: string): Promise<void> {
	const tab = await context.newPage()
	try {
		await tab.goto(address, { waitUntil: 'load' })
	}
	finally {
		await tab.close()
	}
}

/** What the inline script left on the Workbench origin, read from the page that stayed there. */
async function workbenchMarker(page: Page): Promise<string | null> {
	return await page.evaluate(key => localStorage.getItem(key), SENTINEL)
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

describe('stored content byte routes', () => {
	it('answer with a sandboxing policy beside the baseline framing policy', async () => {
		const asset = await createSvgAsset(`headers-${unique()}`)
		// A Checkpoint copies the content blob to the artifact store, so all three routes serve it.
		await checkpoint(`svg-headers-${unique()}`)
		const content = await fetch(`${server.origin}/api/assets/${asset.id}/content`, { headers: server.headers })
		expect(content.status).toBe(200)
		expect(content.headers.get('content-type')).toBe('image/svg+xml')
		expect(content.headers.get('x-content-type-options')).toBe('nosniff')
		const policy = content.headers.get('content-security-policy') ?? ''
		// Two policies, both enforced: the baseline one every response carries, and the content sandbox.
		expect(policy).toContain('frame-ancestors \'self\'')
		expect(policy).toMatch(/(?:^|[,;]\s*)sandbox(?:\s*[;,]|$)/u)
		expect(policy).toContain('default-src \'none\'')

		const read = await api<{ resource: { content: { digest: string } } }>(`/api/resources/asset/${asset.id}`)
		for (const path of [`/api/history/blobs/${encodeURIComponent(read.resource.content.digest)}`, `/api/artifacts/${encodeURIComponent(read.resource.content.digest)}`]) {
			const response = await fetch(`${server.origin}${path}`, { headers: server.headers })
			expect(response.status, path).toBe(200)
			const value = response.headers.get('content-security-policy') ?? ''
			expect(value, path).toContain('frame-ancestors \'self\'')
			expect(value, path).toMatch(/(?:^|[,;]\s*)sandbox(?:\s*[;,]|$)/u)
			expect(response.headers.get('x-content-type-options'), path).toBe('nosniff')
		}
	}, 60_000)
})

describe('SVG content opened as a top-level document', () => {
	it('does not run the SVG\'s script on the Workbench origin from the Asset content address', async () => {
		const asset = await createSvgAsset(`asset-${unique()}`)
		const { context, page, markers } = await signedIn('/')
		try {
			await openTopLevel(context, `${server.origin}/api/assets/${asset.id}/content`)
			expect(await workbenchMarker(page)).toBeNull()
			expect(markers.filter(marker => marker.endsWith(server.origin))).toEqual([])
		}
		finally { await context.close() }
	}, 90_000)

	it('does not run the SVG\'s script on the Workbench origin from the address a version comparison shows', async () => {
		const label = `history-${unique()}`
		await checkpoint(`svg-before-${unique()}`)
		const asset = await createSvgAsset(label)
		await checkpoint(`svg-created-${unique()}`)
		await api(`/api/assets/${asset.id}`, {
			expectedRevision: asset.revision,
			name: label,
			contentFilename: `${label}.svg`,
			mediaType: 'image/svg+xml',
			contentBase64: Buffer.from(scriptedSvg(`${label}-replaced`)).toString('base64'),
		}, 'PUT')
		await checkpoint(`svg-replaced-${unique()}`)
		const listed = await api<{ versions: { id: string; type: string; summary: { kind: string; key: string; status: string }[] }[] }>(`/api/history/versions?resource=${encodeURIComponent(`asset:${asset.id}`)}&type=autosave&limit=5`)
		const replaced = listed.versions.find(version => version.summary.some(item => item.kind === 'asset' && item.key === asset.id && item.status === 'modified'))
		expect(replaced, JSON.stringify(listed)).toBeDefined()

		const { context, page, markers } = await signedIn(`/?tab=activity&version=${replaced!.id}`)
		try {
			const block = page.locator(`[data-version-comparison] [data-resource-diff="asset:${asset.id}"]`)
			await block.waitFor({ timeout: 15_000 })
			if (await block.getAttribute('data-open') === null) await block.locator('[data-resource-diff-toggle]').click()
			const images = block.locator('[data-diff-image] [data-history-image] img')
			await expect.poll(() => images.count(), { timeout: 15_000 }).toBe(2)
			// Both sides render: the replaced image (version blob route) and the current one (content route).
			await expect.poll(() => images.evaluateAll(items => items.map(item => (item as HTMLImageElement).complete && (item as HTMLImageElement).naturalWidth > 0)), { timeout: 15_000 }).toEqual([true, true])
			const sources = await images.evaluateAll(items => items.map(item => (item as HTMLImageElement).src))
			expect(sources).toHaveLength(2)
			for (const source of sources) {
				await openTopLevel(context, source)
				expect(await workbenchMarker(page), source.slice(0, 32)).toBeNull()
			}
			expect(markers.filter(marker => marker.endsWith(server.origin))).toEqual([])
		}
		finally { await context.close() }
	}, 90_000)
})
