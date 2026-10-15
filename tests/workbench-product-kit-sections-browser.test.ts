import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { PermissionKey } from '../src/application/access/keys'
import { canonicalJsonBytes } from '../src/persistence'
import { provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Product Kit page's Components, Styles & themes and Files sections (issue #141, unit K13) against
 * a private copy of the fixture Workspace whose kit project has two registry components, a stylesheet,
 * an HTML file and a file above the 8 MiB read limit:
 *
 * - `?section=` takes `overview`, `components`, `styles` and `files`, and the section navigation
 *   moves between them (Clause 01a11be8-5cab-7e50-89fe-b89c243d773d);
 * - Components lists the registry, browses a component's props and emits, and gives its copy commands;
 *   Styles & themes saves through `update_product_kit`, keeps the draft on a conflict, refuses an
 *   invalid theme attribute inline and shows the server's refusal; Files lists and reads kit files as
 *   text only (Rules 01a11bb1-b918-7cb5-b581-a3fd3f647f09 and 01a11bb1-a184-7e00-a8de-c81056ad5a35);
 * - browsing needs `product-kit.source.read` and editing `product-kit.write` on a desktop-width
 *   window; the server enforces both.
 */

let server: WorkbenchServer
let browser: Browser

const HTML_FILE = '<script>window.__kitFileRan = true</script><b data-injected>bold</b><img src=x onerror="window.__kitFileRan = true">\n'
const BUTTON = [
	'<script setup lang="ts">',
	'const props = defineProps<{ label: string; tone?: \'neutral\' | \'primary\' }>()',
	'const emit = defineEmits<{ press: [event: MouseEvent] }>()',
	'</script>',
	'',
	'<template>',
	'  <button @click="emit(\'press\', $event)">{{ props.label }}</button>',
	'</template>',
	'',
].join('\n')

async function write(path: string, content: string | Uint8Array): Promise<void> {
	await mkdir(join(path, '..'), { recursive: true })
	await writeFile(path, content)
}

async function prepareKit(root: string): Promise<void> {
	const kit = join(root, 'kit')
	await write(join(kit, 'package.json'), JSON.stringify({ name: 'kit', private: true, type: 'module' }))
	await write(join(kit, 'src', 'button', 'Button.vue'), BUTTON)
	await write(join(kit, 'src', 'icon', 'Icon.vue'), '<template><svg /></template>\n')
	await write(join(kit, 'styles', 'base.css'), ':root { --kit: 1; }\n')
	await write(join(kit, 'notes', 'extra.css'), 'body { margin: 0; }\n')
	await write(join(kit, 'notes', 'page.html'), HTML_FILE)
	await write(join(kit, 'notes', 'gone.txt'), 'soon removed\n')
	await write(join(kit, 'notes', 'big.txt'), new Uint8Array(8 * 1024 * 1024 + 1).fill(0x61))
	const productKitPath = join(root, 'product-kit.json')
	const productKit = JSON.parse(await readFile(productKitPath, 'utf8')) as Record<string, unknown>
	await writeFile(productKitPath, canonicalJsonBytes({
		...productKit,
		styles: ['./styles/base.css'],
		themes: { dark: { 'data-theme': 'dark' } },
		components: {
			button: { files: ['src/button/Button.vue'], requires: ['icon'], layer: 'design-system' },
			icon: { files: ['src/icon/Icon.vue'], layer: 'product' },
		},
	}))
}

beforeAll(async () => {
	server = await startWorkbenchServer({ prepare: prepareKit })
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type Cookie = Readonly<{ name: string; value: string }>

async function memberCookie(keys: readonly PermissionKey[]): Promise<Cookie> {
	return await sessionCookieFor(server.origin, await provisionToken(server.workspaceRoot, { nickname: `k13-${randomUUID().slice(0, 8)}`, kind: 'human', keys }))
}

async function open(path: string, options: Readonly<{ cookie?: Cookie; width?: number }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: options.width ?? 1920, height: 1080 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...(options.cookie ?? server.cookie), url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

type ProductKitRead = Readonly<{ revision: string; resource: Readonly<{ adapters: readonly unknown[]; styles: readonly string[]; themes: Readonly<Record<string, Readonly<Record<string, string>>>> }> }>

async function readProductKit(): Promise<ProductKitRead> {
	return await (await fetch(`${server.origin}/api/product-kit`, { headers: server.headers })).json() as ProductKitRead
}

/** Changes the Product Kit file through `update_product_kit`, as another author would. */
async function updateProductKit(change: Readonly<{ styles?: readonly string[]; themes?: Readonly<Record<string, Readonly<Record<string, string>>>> }>): Promise<Response> {
	const read = await readProductKit()
	return await fetch(`${server.origin}/api/product-kit/settings`, {
		method: 'PUT',
		headers: { ...server.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ expectedRevision: read.revision, adapters: read.resource.adapters, styles: change.styles ?? read.resource.styles, themes: change.themes ?? read.resource.themes }),
	})
}

describe('Product Kit page › section navigation', () => {
	it('moves between the four sections and marks the one shown', async () => {
		const { context, page } = await open('/workspace/product-kit')
		try {
			const nav = page.getByRole('navigation', { name: 'Product Kit sections' })
			await nav.waitFor({ timeout: 15_000 })
			expect(await nav.getByRole('link').allInnerTexts()).toEqual(['Overview', 'Components', 'Styles & themes', 'Files'])
			expect(await nav.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page')
			await page.locator('#product-kit-overview').waitFor()

			await nav.getByRole('link', { name: 'Files' }).click()
			await page.waitForURL(url => url.searchParams.get('section') === 'files')
			await page.locator('#product-kit-files').waitFor()
			expect(await page.locator('#product-kit-overview').count()).toBe(0)
			expect(await nav.getByRole('link', { name: 'Files' }).getAttribute('aria-current')).toBe('page')
			expect(await nav.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull()

			await page.goBack()
			await page.locator('#product-kit-overview').waitFor()
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Product Kit page › Components', () => {
	it('lists the registry, browses a component\'s props and emits, and gives its copy commands', async () => {
		const { context, page } = await open('/workspace/product-kit?section=components')
		try {
			const table = page.locator('[data-components-table]')
			await table.waitFor({ timeout: 15_000 })
			expect(await table.locator('[data-component-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-component-row')))).toEqual(['button', 'icon'])
			const button = table.locator('[data-component-row="button"]')
			expect(await button.innerText()).toContain('src/button/Button.vue')
			expect(await button.innerText()).toContain('icon')
			expect(await button.innerText()).toContain('Design system')

			await page.locator('[data-components-target]').fill('src/ui')
			await button.locator('[data-component-browse]').click()
			const detail = page.locator('[data-component-detail][data-component="button"]')
			await detail.locator('[data-component-interface]').waitFor({ timeout: 15_000 })
			expect(await detail.locator('[data-component-declarations="props"] pre').innerText()).toBe('defineProps<{ label: string; tone?: \'neutral\' | \'primary\' }>()')
			expect(await detail.locator('[data-component-declarations="emits"] pre').innerText()).toBe('defineEmits<{ press: [event: MouseEvent] }>()')
			expect(await detail.locator('[data-component-command="cli"]').innerText()).toBe('uiux components add button --to src/ui')
			expect(await detail.locator('[data-component-command="mcp"]').innerText()).toBe('get_component_source {"name":"button","withRequires":true}')
			await detail.locator('[data-component-file="src/button/Button.vue"] summary').click()
			expect(await detail.locator('[data-component-file-content]').textContent()).toBe(BUTTON)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Product Kit page › Styles & themes', () => {
	it('saves the styles and themes through update_product_kit', async () => {
		const { context, page } = await open('/workspace/product-kit?section=styles')
		try {
			const section = page.locator('#product-kit-styles')
			await section.locator('[data-style-row]').first().waitFor({ timeout: 15_000 })
			await section.locator('[data-style-add]').click()
			await section.locator('[data-style-input]').last().fill('./notes/extra.css')
			await section.locator('[data-theme-map]').click()
			await page.getByRole('menuitem', { name: 'Light (light)' }).click()
			await section.locator('[data-theme-mapping="light"] [data-theme-attribute-value]').fill('light')

			const saved = page.waitForResponse(response => response.url().endsWith('/api/product-kit/settings') && response.request().method() === 'PUT')
			await section.getByRole('button', { name: 'Save changes' }).click()
			expect((await saved).status()).toBe(200)
			await expect.poll(async () => (await readProductKit()).resource.themes).toEqual({ dark: { 'data-theme': 'dark' }, light: { 'data-theme': 'light' } })
			expect((await readProductKit()).resource.styles).toEqual(['./styles/base.css', './notes/extra.css'])
			await expect.poll(() => section.locator('[data-save-bar]').count()).toBe(0)
		}
		finally {
			await context.close()
			expect((await updateProductKit({ styles: ['./styles/base.css'], themes: { dark: { 'data-theme': 'dark' } } })).status).toBe(200)
		}
	}, 60_000)

	it('keeps the draft when the Product Kit changed since it was opened (409)', async () => {
		const { context, page } = await open('/workspace/product-kit?section=styles')
		try {
			const section = page.locator('#product-kit-styles')
			const input = section.locator('[data-style-input]').first()
			await input.waitFor({ timeout: 15_000 })
			await input.fill('./styles/mine.css')
			// Another author changes the themes meanwhile.
			expect((await updateProductKit({ themes: { dark: { 'class': 'dark' } } })).status).toBe(200)

			const refused = page.waitForResponse(response => response.url().endsWith('/api/product-kit/settings') && response.request().method() === 'PUT')
			await section.getByRole('button', { name: 'Save changes' }).click()
			expect((await refused).status()).toBe(409)
			const conflict = section.locator('[data-conflict-alert]')
			await conflict.waitFor()
			expect(await conflict.innerText()).toContain('The Product Kit changed since you opened it.')
			expect(await conflict.innerText()).toContain('Your edits are kept.')
			expect(await input.inputValue()).toBe('./styles/mine.css')
			expect((await readProductKit()).resource.styles).toEqual(['./styles/base.css'])
		}
		finally {
			await context.close()
			expect((await updateProductKit({ themes: { dark: { 'data-theme': 'dark' } } })).status).toBe(200)
		}
	}, 60_000)

	it('refuses a theme attribute other than class or data-* inline, and shows the server\'s refusal', async () => {
		// The server's own refusal of the same name, to replay when the page saves.
		const read = await readProductKit()
		const direct = await fetch(`${server.origin}/api/product-kit/settings`, {
			method: 'PUT',
			headers: { ...server.headers, 'content-type': 'application/json' },
			body: JSON.stringify({ expectedRevision: read.revision, adapters: read.resource.adapters, styles: read.resource.styles, themes: { dark: { style: 'color: red' } } }),
		})
		const refusal = await direct.text()
		expect(direct.status).toBeGreaterThanOrEqual(400)
		expect(refusal).toContain('product_kit.theme_attribute_not_allowed')

		const { context, page } = await open('/workspace/product-kit?section=styles')
		try {
			const section = page.locator('#product-kit-styles')
			const mapping = section.locator('[data-theme-mapping="dark"]')
			const name = mapping.locator('[data-theme-attribute-name]').first()
			await name.waitFor({ timeout: 15_000 })
			let puts = 0
			page.on('request', (request) => { if (request.url().endsWith('/api/product-kit/settings') && request.method() === 'PUT') puts += 1 })

			await name.fill('style')
			const issue = mapping.locator('[data-theme-attribute-issue]')
			await issue.waitFor()
			expect(await issue.getAttribute('data-theme-attribute-issue')).toBe('product_kit.theme_attribute_not_allowed')
			expect(await issue.innerText()).toBe('A theme may set only class and data-* attributes.')
			expect(await name.getAttribute('aria-invalid')).toBe('true')
			await name.fill('data-Mode')
			expect(await issue.getAttribute('data-theme-attribute-issue')).toBe('product_kit.theme_attribute_not_allowed')
			await name.fill('data mode')
			expect(await issue.getAttribute('data-theme-attribute-issue')).toBe('product_kit.invalid_theme_attribute')
			await section.getByRole('button', { name: 'Save changes' }).click()
			expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-invalid'))).toBe('true')
			expect(puts).toBe(0)

			// A valid name saves; the server's refusal, should it come, is shown with its code.
			await name.fill('data-mode')
			expect(await issue.count()).toBe(0)
			await page.route('**/api/product-kit/settings', route => route.fulfill({ status: direct.status, contentType: 'application/json', body: refusal }))
			await section.getByRole('button', { name: 'Save changes' }).click()
			const alert = section.locator('[role="alert"]')
			await alert.waitFor()
			expect(await alert.innerText()).toContain('Couldn\'t save')
			expect(await alert.innerText()).toContain('A theme root attribute is class or a data-* attribute.')
			// The code stays one click away, in Details.
			await alert.locator('[data-error-details] button').first().click()
			await expect.poll(() => alert.textContent()).toContain('product_kit.theme_attribute_not_allowed')
			expect(puts).toBe(1)
			expect(await name.inputValue()).toBe('data-mode')
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Product Kit page › Files', () => {
	it('lists the kit files and shows an HTML file as text, never as markup', async () => {
		const { context, page } = await open('/workspace/product-kit?section=files')
		try {
			const tree = page.locator('[data-kit-files-tree]')
			await tree.locator('[data-kit-directory="notes"]').waitFor({ timeout: 15_000 })
			expect(await tree.locator('[data-kit-directory="node_modules"]').count()).toBe(0)
			await tree.locator('[data-kit-directory="notes"]').click()
			await tree.locator('[data-kit-file="notes/page.html"]').click()
			const content = page.locator('[data-kit-file-content]')
			await content.waitFor()
			expect(await content.textContent()).toBe(HTML_FILE)
			expect(await content.locator('*').count()).toBe(0)
			expect(await page.locator('[data-injected]').count()).toBe(0)
			expect(await page.evaluate(() => (window as unknown as { __kitFileRan?: boolean }).__kitFileRan)).toBeUndefined()
			expect(await page.locator('[data-kit-file-path]').innerText()).toBe('kit/notes/page.html')
			// The build log stays in Overview, linked from here.
			expect(await page.locator('[data-kit-files-build-log]').getAttribute('href')).toBe('/workspace/product-kit?section=overview#product-kit-build')
		}
		finally { await context.close() }
	}, 60_000)

	it('says a file is too large to read, or gone', async () => {
		const { context, page } = await open('/workspace/product-kit?section=files')
		try {
			const tree = page.locator('[data-kit-files-tree]')
			await tree.locator('[data-kit-directory="notes"]').click({ timeout: 15_000 })
			const answered = page.waitForResponse(response => response.url().includes('/api/product-kit/file?path=notes%2Fbig.txt'))
			await tree.locator('[data-kit-file="notes/big.txt"]').click()
			expect((await answered).status()).toBe(422)
			const tooLarge = page.locator('[data-kit-file-too-large]')
			await tooLarge.waitFor()
			expect(await tooLarge.innerText()).toContain('8 MB')
			expect(await page.locator('[data-kit-file-content]').count()).toBe(0)

			await rm(join(server.workspaceRoot, 'kit', 'notes', 'gone.txt'))
			await tree.locator('[data-kit-file="notes/gone.txt"]').click()
			await page.locator('[data-kit-file-not-found]').waitFor()
			expect(await page.locator('[data-kit-file-content]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('says when the listing stopped at its entry limit', async () => {
		const { context, page } = await open('/workspace/product-kit')
		try {
			// The listing as the server sends it once it reaches 10,000 entries.
			await page.route('**/api/product-kit/files', route => route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ status: 'listed', key: 'product-kit', files: [{ path: 'package.json', size: 40 }], truncated: true }),
			}))
			await page.getByRole('navigation', { name: 'Product Kit sections' }).getByRole('link', { name: 'Files' }).click({ timeout: 15_000 })
			const truncated = page.locator('[data-kit-files-truncated]')
			await truncated.waitFor()
			expect(await truncated.innerText()).toContain('Showing the first 1 file.')
			expect(await page.locator('[data-kit-files-tree] [data-kit-file="package.json"]').count()).toBe(1)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Product Kit page › key gating', () => {
	it('shows a member with `workspace.read` alone the registry and the styles, read-only, and no kit sources', async () => {
		const cookie = await memberCookie(['workspace.read'])
		const { context, page } = await open('/workspace/product-kit?section=components', { cookie })
		try {
			await page.locator('[data-component-row="button"]').waitFor({ timeout: 15_000 })
			expect(await page.locator('[data-component-browse]').count()).toBe(0)
			expect(await page.locator('[data-access-notice="component-source"]').getAttribute('data-missing-key')).toBe('product-kit.source.read')
			expect(await page.locator('[data-component-copy-cli]').count()).toBe(2)

			await page.getByRole('navigation', { name: 'Product Kit sections' }).getByRole('link', { name: 'Files' }).click()
			const notice = page.locator('[data-access-notice="kit-files"]')
			await notice.waitFor()
			expect(await notice.getAttribute('data-missing-key')).toBe('product-kit.source.read')
			expect(await page.locator('[data-kit-files-tree]').count()).toBe(0)

			await page.getByRole('navigation', { name: 'Product Kit sections' }).getByRole('link', { name: 'Styles & themes' }).click()
			await page.locator('#product-kit-styles [data-style-value]').first().waitFor()
			expect(await page.locator('[data-access-notice][data-missing-key="product-kit.write"]').count()).toBe(1)
			expect(await page.locator('#product-kit-styles input').count()).toBe(0)
			expect(await page.locator('[data-style-add], [data-theme-map], [data-theme-attribute-add]').count()).toBe(0)

			const headers = { cookie: `${cookie.name}=${cookie.value}` }
			expect((await fetch(`${server.origin}/api/product-kit/files`, { headers })).status).toBe(403)
			expect((await fetch(`${server.origin}/api/product-kit/file?path=package.json`, { headers })).status).toBe(403)
		}
		finally { await context.close() }
	}, 60_000)

	it('lets a member with `product-kit.source.read` browse, still without edit controls', async () => {
		const { context, page } = await open('/workspace/product-kit?section=files', { cookie: await memberCookie(['workspace.read', 'product-kit.source.read']) })
		try {
			await page.locator('[data-kit-files-tree] [data-kit-file="package.json"]').waitFor({ timeout: 15_000 })
			expect(await page.locator('[data-access-notice="kit-files"]').count()).toBe(0)
			await page.getByRole('navigation', { name: 'Product Kit sections' }).getByRole('link', { name: 'Styles & themes' }).click()
			await page.locator('#product-kit-styles [data-style-value]').first().waitFor()
			expect(await page.locator('#product-kit-styles input').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('offers no edit controls at a tablet width, even to the owner', async () => {
		const { context, page } = await open('/workspace/product-kit?section=styles', { width: 1024 })
		try {
			await page.locator('#product-kit-styles [data-style-value]').first().waitFor({ timeout: 15_000 })
			expect(await page.locator('[data-access-notice]').first().innerText()).toContain('Editing needs a window at least 1280px wide.')
			expect(await page.locator('#product-kit-styles input').count()).toBe(0)
			expect(await page.locator('[data-style-add], [data-theme-map], [data-theme-attribute-add], [data-save-bar]').count()).toBe(0)
			// Reading kit sources needs no desktop width.
			await page.getByRole('navigation', { name: 'Product Kit sections' }).getByRole('link', { name: 'Components' }).click()
			await page.locator('[data-component-row="icon"]').waitFor()
			expect(await page.locator('[data-component-browse]').count()).toBe(2)
		}
		finally { await context.close() }
	}, 60_000)
})
