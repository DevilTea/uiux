import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { PERMISSION_KEYS } from '../src/application/access/keys'
import type { MemberKind } from '../src/application/access/principal'
import { accessStorePaths, resolveUiuxHome, workspaceRealRoot } from '../src/server/access/store'
import { orderedKeys } from '../app/utils/member-keys'
import { runAccessCommand } from '../src/cli/access'
import { presetKeys, provisionToken } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Members page key editor (issue #142, P5) against the built Workbench and a private copy of
 * the frozen fixture Workspace, signed in as its Owner (`tester`, every key):
 *
 * - the member list shows kind, label and key count, and flags a stored key set that lacks a
 *   requirement (Rules 01a11c09-ba13 and 01a11c33-24ab);
 * - "Edit access" starts from a preset, checks a key's requirements with it, shows the label as
 *   keys change and warns where it grants `members.manage` (Rules 01a11c09-ba80, 01a11c09-baec and
 *   01a11c09-bb58);
 * - an Agent's `humanOnly` keys are disabled, and a preset applied to it drops them (Rules
 *   01a11485-eac6 and 01a11c74-26ef);
 * - a preset keeps the unknown keys the member holds (owner ruling of 2026-10-11 on PR #189);
 * - an edit sends only the keys it grants and revokes, so a rename alone keeps a hand-written key set
 *   and a change made meanwhile through the CLI is kept (owner ruling 1 of 2026-10-11 on PR #191);
 * - the server's refusals (`access.last_manager`, `access.key_requires`,
 *   `access.admin_origin_rejected`) show in place, in the UI language;
 * - the notice lists the catalog keys no person holds (Rule 01a11c09-bbc9).
 */

let server: WorkbenchServer
let browser: Browser

const unique = () => randomUUID().slice(0, 8)
const VIEWER = presetKeys('viewer')
const REVIEWER = presetKeys('reviewer')

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function member(kind: MemberKind, keys: readonly string[], prefix = 'p5'): Promise<string> {
	const nickname = `${prefix}-${unique()}`
	await provisionToken(server.workspaceRoot, { nickname, kind, keys })
	return nickname
}

/** Rewrites a member's stored keys in the roster file, as a person or a newer UIUX might. */
async function writeStoredKeys(nickname: string, keys: readonly string[]): Promise<void> {
	const { file } = accessStorePaths(resolveUiuxHome(), workspaceRealRoot(server.workspaceRoot))
	const roster = JSON.parse(await readFile(file, 'utf8')) as { members: { nickname: string; keys: string[] }[] }
	for (const item of roster.members) if (item.nickname === nickname) item.keys = [...keys]
	await writeFile(file, `${JSON.stringify(roster, null, 2)}\n`)
}

async function storedKeys(nickname: string): Promise<string[]> {
	const response = await fetch(`${server.origin}/api/access/members`, { headers: server.headers })
	const roster = await response.json() as { members: { nickname: string; keys: string[] }[] }
	return roster.members.find(item => item.nickname === nickname)!.keys
}

async function openMembers(locale: 'en-US' | 'zh-TW' = 'en-US'): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript((value) => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', value)
	}, locale)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}/members`, { waitUntil: 'networkidle' })
	return { context, page }
}

function row(page: Page, nickname: string): Locator {
	return page.locator('[data-members-table] tbody tr').filter({ has: page.getByText(nickname, { exact: true }) })
}

/** Opens "Edit access" from the member's key count. */
async function editAccess(page: Page, nickname: string): Promise<Locator> {
	await row(page, nickname).locator('[data-member-key-count]').click()
	const editor = page.locator('[data-member-editor]')
	await editor.waitFor()
	return editor
}

const keyRow = (editor: Locator, key: string) => editor.locator(`[data-key="${key}"]`)
const checkbox = (editor: Locator, key: string) => keyRow(editor, key).getByRole('checkbox')
const label = (editor: Locator) => editor.locator('[data-key-editor-label]')

async function checkedKeys(editor: Locator): Promise<string[]> {
	const keys: string[] = []
	for (const item of await editor.locator('[data-key]').all()) {
		if (await item.getByRole('checkbox').getAttribute('aria-checked') === 'true') keys.push((await item.getAttribute('data-key'))!)
	}
	return orderedKeys(keys)
}

async function startFrom(page: Page, editor: Locator, preset: string): Promise<void> {
	await editor.locator('[data-key-editor-preset]').click()
	await page.getByRole('menuitem', { name: preset, exact: true }).click()
}

async function save(editor: Locator): Promise<void> {
	await editor.locator('[data-member-editor-save]').click()
}

describe('the member list', () => {
	it('shows each member\'s kind, label and key count, and flags a stored key set lacking a requirement', async () => {
		const editor = await member('human', presetKeys('editor'))
		const agent = await member('agent', presetKeys('editor', 'agent'))
		const gap = await member('human', VIEWER)
		await writeStoredKeys(gap, ['views.write'])
		const { context, page } = await openMembers()
		try {
			const editorRow = row(page, editor)
			await editorRow.waitFor({ timeout: 15_000 })
			expect(await editorRow.innerText()).toContain('Human')
			expect((await editorRow.locator('[data-member-label]').innerText()).trim()).toBe('Editor')
			expect((await editorRow.locator('[data-member-key-count]').innerText()).trim()).toBe(`${presetKeys('editor').length} keys`)
			expect(await editorRow.locator('[data-member-key-gap]').count()).toBe(0)

			const agentRow = row(page, agent)
			expect(await agentRow.innerText()).toContain('Agent')
			expect((await agentRow.locator('[data-member-label]').innerText()).trim()).toBe('Editor')

			const gapRow = row(page, gap)
			expect((await gapRow.locator('[data-member-label]').innerText()).trim()).toBe('Custom')
			expect((await gapRow.locator('[data-member-key-count]').innerText()).trim()).toBe('1 key')
			expect(await gapRow.locator('[data-member-key-gap]').getAttribute('aria-description')).toBe('views.write needs workspace.read.')
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Edit access', () => {
	it('starts from a preset, checks requirements with a key, shows the label as keys change and warns on members.manage', async () => {
		const nickname = await member('human', VIEWER)
		const { context, page } = await openMembers()
		try {
			const editor = await editAccess(page, nickname)
			expect((await label(editor).innerText()).trim()).toBe('Viewer')
			expect(await checkedKeys(editor)).toEqual(VIEWER)
			// The checklist is grouped by domain, each key with its identifier and description.
			expect(await editor.locator('[data-key-domain]').evaluateAll(groups => groups.map(group => group.getAttribute('data-key-domain'))))
				.toEqual(['workspace', 'history', 'product-kit', 'reviews', 'decisions', 'views', 'flows', 'locales', 'assets', 'settings', 'evidence', 'handoff', 'checkpoints', 'locks', 'presets', 'members'])
			expect(await keyRow(editor, 'handoff.export').innerText()).toContain('Export a Handoff.')

			await startFrom(page, editor, 'Editor')
			expect((await label(editor).innerText()).trim()).toBe('Editor')
			expect(await checkedKeys(editor)).toEqual(presetKeys('editor'))

			await startFrom(page, editor, 'Viewer')
			// Checking `reviews.promote` also checks `reviews.write`, which it requires.
			await checkbox(editor, 'reviews.promote').click()
			expect(await checkedKeys(editor)).toEqual([...VIEWER, 'reviews.write', 'reviews.promote'])
			expect((await label(editor).innerText()).trim()).toBe('Custom')

			expect(await editor.locator('[data-key-editor-manage-warning]').count()).toBe(0)
			await checkbox(editor, 'members.manage').click()
			await editor.locator('[data-key-editor-manage-warning]').waitFor()
			expect(await editor.locator('[data-key-editor-manage-warning]').innerText()).toContain('This member can grant every key')
			await checkbox(editor, 'members.manage').click()
			await editor.locator('[data-key-editor-manage-warning]').waitFor({ state: 'detached' })

			await save(editor)
			await editor.waitFor({ state: 'detached' })
			expect(await storedKeys(nickname)).toEqual([...VIEWER, 'reviews.write', 'reviews.promote'])
			await page.waitForFunction(name => [...document.querySelectorAll('[data-members-table] tbody tr')].some(tr => tr.textContent?.includes(name) && tr.textContent.includes('5 keys')), nickname)
			expect((await row(page, nickname).locator('[data-member-label]').innerText()).trim()).toBe('Custom')
		}
		finally { await context.close() }
	}, 60_000)

	it('disables humanOnly keys for an Agent and drops them from a preset applied to it', async () => {
		const nickname = await member('agent', VIEWER)
		const { context, page } = await openMembers()
		try {
			const editor = await editAccess(page, nickname)
			for (const key of ['reviews.resolve', 'decisions.decide', 'checkpoints.delete', 'locks.force-release', 'presets.manage', 'members.manage']) {
				expect(await keyRow(editor, key).locator('[data-key-human-only]').count(), key).toBe(1)
				expect(await checkbox(editor, key).isDisabled(), key).toBe(true)
			}
			expect(await checkbox(editor, 'views.write').isDisabled()).toBe(false)
			expect(await keyRow(editor, 'views.write').locator('[data-key-human-only]').count()).toBe(0)

			await startFrom(page, editor, 'Owner')
			expect(await checkedKeys(editor)).toEqual(presetKeys('owner', 'agent'))
			expect(await editor.locator('[data-key-editor-applied]').innerText()).toContain('Started from Owner without reviews.resolve, decisions.decide, checkpoints.delete, locks.force-release, presets.manage, members.manage')
			// An Agent holding the Owner keys it can hold is labeled by the preset with the fewest humanOnly keys.
			expect((await label(editor).innerText()).trim()).toBe('Editor')
			await save(editor)
			await editor.waitFor({ state: 'detached' })
			expect(await storedKeys(nickname)).toEqual(presetKeys('owner', 'agent'))
		}
		finally { await context.close() }
	}, 60_000)

	it('keeps the unknown keys a member holds when a preset is applied', async () => {
		const nickname = await member('human', VIEWER)
		await writeStoredKeys(nickname, [...VIEWER, 'future.capability'])
		const { context, page } = await openMembers()
		try {
			const editor = await editAccess(page, nickname)
			expect(await editor.locator('[data-key-domain="unknown"]').innerText()).toContain('future.capability')
			await startFrom(page, editor, 'Reviewer')
			expect(await checkedKeys(editor)).toEqual([...REVIEWER, 'future.capability'])
			expect((await label(editor).innerText()).trim()).toBe('Custom')
			await save(editor)
			await editor.waitFor({ state: 'detached' })
			expect(await storedKeys(nickname)).toEqual([...REVIEWER, 'future.capability'])
		}
		finally { await context.close() }
	}, 60_000)

	it('renames a member alone without rewriting a hand-written key set that lacks a requirement', async () => {
		const nickname = await member('human', VIEWER)
		await writeStoredKeys(nickname, ['views.write'])
		const renamed = `${nickname}-renamed`
		const { context, page } = await openMembers()
		try {
			const editor = await editAccess(page, nickname)
			const patches: unknown[] = []
			page.on('request', (request) => {
				if (request.method() === 'PATCH') patches.push(request.postDataJSON())
			})
			const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/api/access/members/'))
			await editor.locator('input[data-member-editor-nickname], [data-member-editor-nickname] input').fill(renamed)
			await save(editor)
			expect((await saved).status()).toBe(200)
			await editor.waitFor({ state: 'detached' })
			expect(patches).toEqual([{ nickname: renamed }])
			expect(await storedKeys(renamed)).toEqual(['views.write'])
		}
		finally { await context.close() }
	}, 60_000)

	it('keeps a change made through the CLI while the page was open (owner ruling 1 of 2026-10-11 on PR #191)', async () => {
		const EDITOR = presetKeys('editor')
		const nickname = await member('human', [...EDITOR, 'members.manage'])
		const { context, page } = await openMembers()
		try {
			const editor = await editAccess(page, nickname)
			expect(await checkedKeys(editor)).toEqual([...EDITOR, 'members.manage'])
			// Meanwhile `uiux member set` takes members.manage away.
			const err: string[] = []
			const code = await runAccessCommand({ argv: ['member', 'set', nickname, '--revoke', 'members.manage', '--workspace', server.workspaceRoot], env: { UIUX_HOME: resolveUiuxHome() }, stdout: () => {}, stderr: line => err.push(line) })
			expect(code, err.join('\n')).toBe(0)
			// The page, still showing members.manage checked, unchecks an unrelated key and saves.
			await checkbox(editor, 'handoff.export').click()
			await save(editor)
			await editor.waitFor({ state: 'detached' })
			expect(await storedKeys(nickname)).toEqual(EDITOR.filter(key => key !== 'handoff.export'))
		}
		finally { await context.close() }
	}, 60_000)

	it('adds a member with the keys chosen in the checklist', async () => {
		const nickname = `p5-new-${unique()}`
		const { context, page } = await openMembers()
		try {
			await page.getByRole('button', { name: 'Add member' }).first().click()
			const editor = page.locator('[data-member-editor]')
			await editor.waitFor()
			await editor.locator('input[data-member-editor-nickname], [data-member-editor-nickname] input').fill(nickname)
			await startFrom(page, editor, 'Viewer')
			await checkbox(editor, 'handoff.export').click()
			await save(editor)
			await editor.waitFor({ state: 'detached' })
			expect(await storedKeys(nickname)).toEqual([...VIEWER, 'handoff.export'])
		}
		finally { await context.close() }
	}, 60_000)
})

describe('refusals shown in place', () => {
	it('keeps the last person holding members.manage, with the server\'s reason', async () => {
		const { context, page } = await openMembers()
		try {
			const editor = await editAccess(page, 'tester')
			await checkbox(editor, 'members.manage').click()
			await save(editor)
			const error = editor.locator('[data-member-editor-error]')
			await error.waitFor()
			expect(await error.getAttribute('data-code')).toBe('access.last_manager')
			expect(await error.innerText()).toContain('is the last human holder of `members.manage`')
			expect(await storedKeys('tester')).toEqual([...PERMISSION_KEYS])
		}
		finally { await context.close() }
	}, 60_000)

	it('flags a key whose requirement is unchecked and shows access.key_requires in zh-TW', async () => {
		const nickname = await member('human', presetKeys('editor'))
		const { context, page } = await openMembers('zh-TW')
		try {
			const editor = await editAccess(page, nickname)
			await checkbox(editor, 'history.read').click()
			for (const key of ['checkpoints.create', 'history.restore'])
				expect(await keyRow(editor, key).locator('[data-key-missing]').innerText(), key).toContain('history.read')
			await save(editor)
			const error = editor.locator('[data-member-editor-error]')
			await error.waitFor()
			expect(await error.getAttribute('data-code')).toBe('access.key_requires')
			expect(await error.innerText()).toContain('這些權限鍵需要成員尚未持有的其他權限鍵。')
			expect(await storedKeys(nickname)).toEqual(presetKeys('editor'))
		}
		finally { await context.close() }
	}, 60_000)


	it('explains access.admin_origin_rejected in zh-TW', async () => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
		try {
			await context.addInitScript(() => localStorage.setItem('uiux.workbench.locale', 'zh-TW'))
			await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
			const page = await context.newPage()
			// The packaged server serves loopback only, so the refusal of a plain-HTTP network origin is simulated.
			await page.route('**/api/access/members', route => route.fulfill({
				status: 403,
				contentType: 'application/json',
				body: JSON.stringify({ status: 'blocked', code: 'access.admin_origin_rejected', message: 'Roster administration is not served on a plain-HTTP network origin.', diagnostics: [] }),
			}))
			await page.goto(`${server.origin}/members`, { waitUntil: 'networkidle' })
			const refused = page.locator('[data-testid="admin-origin-refused"]')
			await refused.waitFor({ timeout: 15_000 })
			expect(await refused.innerText()).toContain('這個網址無法管理名冊')
			expect(await refused.innerText()).toContain('成員、Token、登入連結與工作階段只能在伺服器主機的本機迴路網址或 HTTPS 網址上管理')
		}
		finally { await context.close() }
	}, 60_000)
})

describe('the notice of keys no person holds', () => {
	it('lists the catalog keys no human member holds, links to the Access presets page and opens the signed-in member\'s checklist', async () => {
		const { context, page } = await openMembers()
		try {
			await page.locator('[data-members-table] tbody tr').first().waitFor({ timeout: 15_000 })
			// The Owner holds every key, so there is no notice.
			expect(await page.locator('[data-testid="unheld-keys"]').count()).toBe(0)
		}
		finally { await context.close() }

		// Another person takes over members.manage, and the Owner gives up the keys no one else holds.
		const lead = await member('human', [...presetKeys('editor'), 'members.manage'], 'p5-lead')
		await writeStoredKeys('tester', [...presetKeys('editor'), 'members.manage'])
		const second = await openMembers()
		try {
			const notice = second.page.locator('[data-testid="unheld-keys"]')
			await notice.waitFor({ timeout: 15_000 })
			expect((await notice.locator('[data-unheld-keys]').innerText()).trim()).toBe('decisions.decide, checkpoints.delete, locks.force-release, presets.manage')
			const presets = notice.locator('[data-unheld-open-presets]')
			expect(await presets.getAttribute('href')).toBe('/workspace/access-presets')
			expect((await presets.innerText()).trim()).toBe('Open Access presets')
			await presets.click()
			await second.page.waitForURL(url => url.pathname === '/workspace/access-presets')
			await second.page.locator('[data-access-presets]').waitFor({ timeout: 15_000 })
			await second.page.goBack()
			await notice.waitFor({ timeout: 15_000 })
			await notice.locator('[data-unheld-open-checklist]').click()
			const editor = second.page.locator('[data-member-editor]')
			await editor.waitFor()
			expect(await editor.locator('input[data-member-editor-nickname], [data-member-editor-nickname] input').inputValue()).toBe('tester')
		}
		finally {
			await second.context.close()
			await writeStoredKeys('tester', [...PERMISSION_KEYS])
			await writeStoredKeys(lead, presetKeys('editor'))
		}
	}, 60_000)
})
