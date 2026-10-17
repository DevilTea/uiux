import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { PermissionKey } from '../src/application/access/keys'
import { canonicalJsonBytes } from '../src/persistence'
import { provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Product Kit page's Overview section (issue #141, unit K12) against a private copy of the fixture
 * Workspace whose kit project lists one Design System package and declares a build:
 *
 * - `/workspace/product-kit` takes the section in `section`, and an unknown value opens the page at its
 *   top (Clause 01a11be8-5cab-7e50-89fe-b89c243d773d);
 * - Overview shows the packages, the build state and log, and the Adapters (Rules
 *   01a11bb1-b918-7cb5-b581-a3fd3f647f09, 01a116f0-8a46-76bc-a29f-affaa302c44c and
 *   01a115cd-af57-781e-9493-89d037e41b06);
 * - the build log follows `product-kit.source.read` and the restart `product-kit.write`; the server
 *   enforces both, so a member without the log key reads no log at all;
 * - a failed build says why, a refused restart says why, the build stays usable when the Product Kit
 *   file cannot be read, each against a server of its own.
 */

let server: WorkbenchServer
let browser: Browser

const LOG_LINE = 'kit build: copied the reference Adapter'

async function write(path: string, content: string): Promise<void> {
	await mkdir(join(path, '..'), { recursive: true })
	await writeFile(path, content)
}

/**
 * A kit project with `fake-ds` installed and listed in `designSystems`, and a build that copies the
 * Adapter into `dist/` (or runs `command` instead).
 */
async function prepareKit(root: string, command: readonly string[] = [process.execPath, 'build.mjs']): Promise<void> {
	const kit = join(root, 'kit')
	await write(join(kit, 'package.json'), JSON.stringify({
		name: 'kit',
		private: true,
		type: 'module',
		dependencies: { 'fake-ds': '2.1.0' },
		uiux: { output: 'dist', build: { command } },
	}))
	await write(join(kit, 'node_modules', 'fake-ds', 'package.json'), JSON.stringify({ name: 'fake-ds', version: '2.1.0', type: 'module', exports: { '.': './index.js' } }))
	await write(join(kit, 'node_modules', 'fake-ds', 'index.js'), 'export const ds = true\n')
	await write(join(kit, 'build.mjs'), [
		`import { cpSync, mkdirSync } from 'node:fs'`,
		`mkdirSync('dist/adapters', { recursive: true })`,
		`cpSync('adapters/reference.ts', 'dist/adapters/reference.ts')`,
		`console.log(${JSON.stringify(LOG_LINE)})`,
		'',
	].join('\n'))
	const productKitPath = join(root, 'product-kit.json')
	const productKit = JSON.parse(await readFile(productKitPath, 'utf8')) as Record<string, unknown>
	await writeFile(productKitPath, canonicalJsonBytes({ ...productKit, designSystems: ['fake-ds'] }))
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
	return await sessionCookieFor(server.origin, await provisionToken(server.workspaceRoot, { nickname: `k12-${randomUUID().slice(0, 8)}`, kind: 'human', keys }))
}

async function open(path: string, cookie: Cookie = server.cookie, target: WorkbenchServer = server): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...cookie, url: target.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${target.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

/** Starts another server for the tests of one `describe`, closed after them. */
function withServer(prepare: (root: string) => Promise<void>): () => WorkbenchServer {
	let started: WorkbenchServer | undefined
	beforeAll(async () => { started = await startWorkbenchServer({ prepare }) }, 60_000)
	afterAll(async () => { await started?.close() })
	return () => started!
}

describe('Product Kit page › Overview', () => {
	it('shows the packages, the build with its log, and the Adapters', async () => {
		const { context, page } = await open('/workspace/product-kit?section=overview')
		try {
			await page.locator('#product-kit-overview').waitFor({ timeout: 15_000 })
			expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Product Kit')
			// The Workspace sub-navigation marks the page, and the breadcrumb names it.
			const subnav = page.getByRole('navigation', { name: 'Workspace pages' })
			expect(await subnav.getByRole('link', { name: 'Product Kit' }).getAttribute('aria-current')).toBe('page')

			const item = page.locator('[data-product-kit-package]')
			await item.waitFor()
			expect(await item.count()).toBe(1)
			expect(await item.innerText()).toContain('fake-ds')
			expect(await item.innerText()).toContain('2.1.0')
			expect(await item.getAttribute('data-package-status')).toBe('resolved')

			const state = page.locator('[data-kit-build-state]')
			await expect.poll(() => state.getAttribute('data-state'), { timeout: 20_000 }).toBe('ready')
			await page.locator('[data-kit-build-log-toggle]').click()
			const log = page.locator('[data-kit-build-log]')
			await log.waitFor()
			expect(await log.innerText()).toContain(LOG_LINE)
			expect(await page.locator('[data-kit-build-restart]').count()).toBe(1)

			const adapters = page.locator('#product-kit-adapters')
			await adapters.locator('[data-adapter-row]').first().waitFor()
			expect(await adapters.locator('[data-adapter-row]').count()).toBe(1)
			expect(await page.getByRole('button', { name: 'Add adapter', exact: true }).count()).toBe(1)
		}
		finally { await context.close() }
	}, 60_000)

	it('opens at its top for a section it does not have', async () => {
		const { context, page } = await open('/workspace/product-kit?section=bogus')
		try {
			await page.locator('#product-kit-overview').waitFor({ timeout: 15_000 })
			expect(new URL(page.url()).searchParams.get('section')).toBe('bogus')
			expect(await page.locator('#product-kit-overview').evaluate(element => element.closest('[role="region"]')?.scrollTop ?? -1)).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('restarts the build for a holder of `product-kit.write`', async () => {
		const { context, page } = await open('/workspace/product-kit')
		try {
			const restart = page.locator('[data-kit-build-restart]')
			await restart.waitFor({ timeout: 15_000 })
			const answered = page.waitForResponse(response => response.url().endsWith('/api/product-kit/build/restart'))
			await restart.click()
			expect((await answered).status()).toBe(200)
			await expect.poll(() => page.locator('[data-kit-build-state]').getAttribute('data-state'), { timeout: 20_000 }).toBe('ready')
		}
		finally { await context.close() }
	}, 60_000)

	it('says why a throttled restart (429) did not run', async () => {
		const { context, page } = await open('/workspace/product-kit')
		try {
			const restart = page.locator('[data-kit-build-restart]')
			await restart.waitFor({ timeout: 15_000 })
			// The server's refusal within 2 s of the previous restart, as `restartKitBuildForHttp` sends it.
			const message = 'The kit build was restarted moments ago; restarts are at least 2 s apart. Try again in 2 s.'
			await page.route('**/api/product-kit/build/restart', route => route.fulfill({
				status: 429,
				contentType: 'application/json',
				body: JSON.stringify({ status: 'blocked', key: 'product-kit', code: 'kit.build_restart_throttled', message, diagnostics: [{ code: 'kit.build_restart_throttled', path: '/', message }] }),
			}))
			await restart.click()
			const alert = page.locator('#product-kit-build [role="alert"]')
			await alert.waitFor()
			expect(await alert.innerText()).toContain('Couldn\'t restart the build')
			expect(await alert.innerText()).toContain('The kit build was restarted moments ago')
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Product Kit page › a failed build', () => {
	const failing = withServer(root => prepareKit(root, [process.execPath, '-e', 'process.exit(3)']))

	it('says why the build failed, and the failed-build banner opens the page, where it offers no link', async () => {
		const { context, page } = await open('/workspace/locales', failing().cookie, failing())
		try {
			const banner = page.locator('[data-kit-build-failed]')
			await banner.waitFor({ timeout: 20_000 })
			await banner.getByRole('link', { name: 'Open Product Kit' }).click()
			await page.waitForURL(url => url.pathname === '/workspace/product-kit')
			const state = page.locator('[data-kit-build-state]')
			await expect.poll(() => state.getAttribute('data-state'), { timeout: 20_000 }).toBe('failed')
			expect(await page.locator('[data-kit-build-message]').innerText()).toContain('exited with code 3')
			expect(await banner.isVisible()).toBe(true)
			expect(await banner.getByRole('link', { name: 'Open Product Kit' }).count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Product Kit page › an unreadable Product Kit file', () => {
	const broken = withServer(async (root) => {
		await prepareKit(root)
		await writeFile(join(root, 'product-kit.json'), '{ "adapters": [')
	})

	it('names the file, and still shows the build and restarts it', async () => {
		const { context, page } = await open('/workspace/product-kit', broken().cookie, broken())
		try {
			const unavailable = page.locator('[data-product-kit-unavailable]')
			await unavailable.waitFor({ timeout: 15_000 })
			expect(await unavailable.innerText()).toContain('product-kit.json')
			expect(await page.locator('[data-product-kit-package]').count()).toBe(0)
			expect(await page.locator('[data-kit-build-state]').count()).toBe(1)
			const restart = page.locator('[data-kit-build-restart]')
			const answered = page.waitForResponse(response => response.url().endsWith('/api/product-kit/build/restart'))
			await restart.click()
			expect((await answered).status()).toBe(200)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Product Kit page › key gating', () => {
	it('names `product-kit.source.read` instead of the build log for a member without it, and the server refuses the log', async () => {
		const cookie = await memberCookie(['workspace.read'])
		const { context, page } = await open('/workspace/product-kit', cookie)
		try {
			const notice = page.locator('[data-access-notice="build-log"]')
			await notice.waitFor({ timeout: 15_000 })
			expect(await notice.getAttribute('data-missing-key')).toBe('product-kit.source.read')
			expect(await notice.innerText()).toContain('product-kit.source.read')
			expect(await page.locator('[data-kit-build-log-toggle]').count()).toBe(0)
			expect(await page.locator('[data-kit-build-restart]').count()).toBe(0)
			// The page's own write key is named, and nothing is editable.
			expect(await page.locator('[data-access-notice][data-missing-key="product-kit.write"]').count()).toBe(1)
			await page.locator('[data-adapter-row]').first().waitFor()
			expect(await page.getByRole('button', { name: 'Add adapter', exact: true }).count()).toBe(0)
			expect(await page.locator('#product-kit-adapters textarea').count()).toBe(0)
			// The packages and the build state still read with `workspace.read` alone.
			expect(await page.locator('[data-product-kit-package]').count()).toBe(1)
			expect(await page.locator('[data-kit-build-state]').count()).toBe(1)

			const response = await fetch(`${server.origin}/api/product-kit/build/log`, { headers: { cookie: `${cookie.name}=${cookie.value}` } })
			expect(response.status).toBe(403)
		}
		finally { await context.close() }
	}, 60_000)

	it('shows the log but no restart to a member with `product-kit.source.read` and not `product-kit.write`', async () => {
		const { context, page } = await open('/workspace/product-kit', await memberCookie(['workspace.read', 'product-kit.source.read']))
		try {
			const toggle = page.locator('[data-kit-build-log-toggle]')
			await toggle.waitFor({ timeout: 15_000 })
			expect(await page.locator('[data-access-notice="build-log"]').count()).toBe(0)
			expect(await page.locator('[data-kit-build-restart]').count()).toBe(0)
			await toggle.click()
			await expect.poll(async () => (await page.locator('[data-kit-build-log]').count()) > 0 ? await page.locator('[data-kit-build-log]').innerText() : '', { timeout: 15_000 }).toContain(LOG_LINE)
		}
		finally { await context.close() }
	}, 60_000)
})
