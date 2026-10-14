import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { BUILT_IN_ACCESS_PRESETS, keysForRole, keysOfPreset, type PermissionKey } from '../src/application/access/keys'
import type { MemberKind } from '../src/application/access/principal'
import { ACCESS_PRESETS_FILENAME, type AccessPreset } from '../src/domain/access-presets/schema'
import { orderedKeys } from '../app/utils/member-keys'
import { provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Access presets page (issue #142, P7) against the built Workbench and a private copy of the
 * frozen fixture Workspace (migrated to `schemaVersion` 6), signed in as its Owner (`tester`):
 *
 * - `/workspace/access-presets` is in the Workspace sub-navigation (Clause 01a11c09-b049, Rule
 *   01a116f0-8a01) and lists the presets in file order, with key counts, the members on this host
 *   each labels, names as written and unknown keys flagged (Rules 01a11c09-cd38, 01a11c09-cef3 and
 *   01a11c09-ca9b);
 * - an edit that would make two presets equal, or reuse a name, is refused inline (Rule 01a11c09-ce14);
 * - after a key edit, the holders of the old keys are counted, and the separate update step gives
 *   them the new keys as grant/revoke deltas, an Agent without `humanOnly` keys (Rules 01a11c09-ce86
 *   and 01a11c33-2761; owner rulings of 2026-10-08 and 2026-10-11);
 * - rename, reorder and delete change the file only (Rules 01a11c09-cda4 and 01a11c09-ca2d);
 * - the page is read-only without `presets.manage` and on a tablet (Rule 01a11c09-cda4);
 * - a missing and an unparsable presets file are reported, and saving creates or replaces the file
 *   (#140 owner rulings of 2026-10-12).
 */

let server: WorkbenchServer
let browser: Browser

const unique = () => randomUUID().slice(0, 8)
const VIEWER = keysForRole('human', 'viewer')
const BUILT_IN: AccessPreset[] = BUILT_IN_ACCESS_PRESETS.map(preset => ({ id: preset.id, name: preset.name, keys: [...preset.keys] }))

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type Read = { resource: { presets: AccessPreset[] } | null; revision: string | null; diagnostics: { code: string }[] }
type RosterMember = { id: string; nickname: string; kind: MemberKind; keys: string[]; label: { preset?: { id: string; name: string }; custom?: true } }

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, { method, headers: { 'content-type': 'application/json', ...server.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

const readPresets = () => request<Read>('/api/access-presets')

/** Replaces the whole presets file through `update_access_presets`, as the Owner. */
async function setPresets(presets: readonly AccessPreset[]): Promise<void> {
	const { revision } = await readPresets()
	await request('/api/access-presets', 'PUT', { expectedRevision: revision, presets })
}

async function member(kind: MemberKind, keys: readonly string[]): Promise<string> {
	const nickname = `p7-${unique()}`
	await provisionToken(server.workspaceRoot, { nickname, kind, keys })
	return nickname
}

async function rosterMember(nickname: string): Promise<RosterMember> {
	const roster = await request<{ members: RosterMember[] }>('/api/access/members')
	return roster.members.find(item => item.nickname === nickname)!
}

async function open(options: Readonly<{ cookie?: { name: string; value: string }; width?: number; locale?: 'en-US' | 'zh-TW' }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript((value) => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', value)
	}, options.locale ?? 'en-US')
	await context.addCookies([{ ...(options.cookie ?? server.cookie), url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}/workspace/access-presets`, { waitUntil: 'networkidle' })
	await page.locator('[data-access-presets]:not([data-state="loading"])').waitFor({ timeout: 15_000 })
	return { context, page }
}

const row = (page: Page, id: string): Locator => page.locator('[data-presets-table] tbody tr').filter({ has: page.locator(`[data-preset-row="${id}"]`) })
const names = async (page: Page) => (await page.locator('[data-preset-name]').allInnerTexts()).map(text => text.trim())

async function editPreset(page: Page, id: string): Promise<Locator> {
	await row(page, id).locator('[data-preset-key-count]').click()
	const editor = page.locator('[data-preset-editor]')
	await editor.waitFor()
	return editor
}

async function action(page: Page, id: string, name: string): Promise<void> {
	await row(page, id).locator('[data-preset-actions]').click()
	await page.getByRole('menuitem', { name, exact: true }).click()
}

const checkbox = (editor: Locator, key: string) => editor.locator(`[data-key="${key}"]`).getByRole('checkbox')

describe('the list', () => {
	it('lists the presets in file order with key counts, members on this host and unknown keys flagged', async () => {
		const qaKeys = [...VIEWER, 'reviews.write'] as PermissionKey[]
		await setPresets([...BUILT_IN, { id: 'qa', name: 'QA · 測試', keys: qaKeys }])
		// A key a newer UIUX wrote, which this version does not know; a write over HTTP cannot add one.
		const file = join(server.workspaceRoot, ACCESS_PRESETS_FILENAME)
		const current = (await readPresets()).resource!
		await writeFile(file, `${JSON.stringify({ presets: [...current.presets, { id: 'future', name: 'Future', keys: [...VIEWER, 'future.key'] }] }, null, 2)}\n`)
		await member('human', qaKeys)
		await member('human', qaKeys)
		await member('agent', keysOfPreset('agent', qaKeys))
		const { context, page } = await open()
		try {
			const entry = page.locator('[data-workspace-subnav] a[href="/workspace/access-presets"]')
			expect((await entry.innerText()).trim()).toBe('Access presets')
			expect(await names(page)).toEqual(['Viewer', 'Reviewer', 'Editor', 'Owner', 'QA · 測試', 'Future'])
			expect((await row(page, 'qa').locator('[data-preset-key-count]').innerText()).trim()).toBe(`${qaKeys.length} keys`)
			expect((await row(page, 'qa').locator('[data-preset-member-count]').innerText()).trim()).toBe('3 members')
			expect((await row(page, 'future').locator('[data-preset-member-count]').innerText()).trim()).toBe('No members')
			expect(await row(page, 'future').locator('[data-preset-unknown-keys]').getAttribute('aria-description')).toBe('Holds future.key, which this version of UIUX doesn’t know, so it labels no member.')
			expect(await page.locator('[data-preset-unknown-keys]').count()).toBe(1)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('editing', () => {
	it('refuses equal key sets and taken or reserved names inline, before saving', async () => {
		await setPresets([...BUILT_IN, { id: 'qa', name: 'QA', keys: [...VIEWER, 'reviews.write'] }])
		const before = (await readPresets()).revision
		const { context, page } = await open()
		try {
			const editor = await editPreset(page, 'qa')
			await editor.locator('[data-key-editor-preset]').click()
			// The preset being edited is not offered to start from.
			expect(await page.getByRole('menuitem', { name: 'QA', exact: true }).count()).toBe(0)
			await page.getByRole('menuitem', { name: 'Reviewer', exact: true }).click()
			expect((await editor.locator('[data-preset-editor-duplicate]').innerText()).trim()).toBe('Reviewer already has exactly these keys. No two presets can be equal.')
			expect(await editor.locator('[data-preset-editor-save]').isDisabled()).toBe(true)
			await checkbox(editor, 'flows.write').click()
			expect(await editor.locator('[data-preset-editor-duplicate]').count()).toBe(0)
			await editor.locator('[data-preset-editor-name]').fill(' editor ')
			await expect.poll(async () => await editor.getByText('Another preset is already named Editor.').count()).toBe(1)
			expect(await editor.locator('[data-preset-editor-save]').isDisabled()).toBe(true)
			await editor.locator('[data-preset-editor-name]').fill('custom')
			await expect.poll(async () => await editor.getByText('This name is reserved for members no preset matches, so a preset can’t use it.').count()).toBe(1)
			expect(await editor.locator('[data-preset-editor-save]').isDisabled()).toBe(true)
			expect((await readPresets()).revision).toBe(before)
		}
		finally { await context.close() }
	}, 60_000)

	it('counts the holders of the old keys, then gives them the new keys on this host as deltas', async () => {
		const old = [...VIEWER, 'reviews.write', 'reviews.submit'] as PermissionKey[]
		await setPresets([...BUILT_IN, { id: 'qa', name: 'QA', keys: old }])
		const ann = await member('human', old)
		const bea = await member('human', old)
		const bot = await member('agent', old)
		const outsider = await member('human', [...old, 'flows.write'])
		const { context, page } = await open()
		try {
			const editor = await editPreset(page, 'qa')
			await checkbox(editor, 'checkpoints.create').click()
			await checkbox(editor, 'reviews.resolve').click()
			await editor.locator('[data-preset-editor-save]').click()
			const followUp = page.locator('[data-preset-follow-up]')
			await followUp.waitFor()
			expect(await followUp.getAttribute('data-holders')).toBe('3')
			expect(await followUp.innerText()).toContain('3 members on this host held the old keys of QA.')
			// Saving the preset changed no member's keys.
			expect((await rosterMember(ann)).keys).toEqual(old)

			// Meanwhile another manager gives Bea a key; the update step must keep it.
			await request(`/api/access/members/${(await rosterMember(bea)).id}`, 'PATCH', { grant: ['flows.write'] })

			await followUp.getByRole('button', { name: 'Also update these members' }).click()
			const dialog = page.locator('[data-preset-update]')
			await dialog.waitFor()
			expect(await dialog.locator('[data-preset-update-member]').count()).toBe(3)
			expect((await dialog.locator(`[data-preset-update-member="${bot}"]`).innerText())).toContain('Gets checkpoints.create')
			expect((await dialog.locator(`[data-preset-update-member="${bot}"]`).innerText())).not.toContain('reviews.resolve')
			await dialog.locator('[data-preset-update-confirm]').click()
			await dialog.waitFor({ state: 'detached' })

			const next = orderedKeys([...old, 'checkpoints.create', 'reviews.resolve'])
			expect((await rosterMember(ann)).keys).toEqual(next)
			expect((await rosterMember(ann)).label.preset?.id).toBe('qa')
			expect((await rosterMember(bea)).keys).toEqual(orderedKeys([...next, 'flows.write']))
			expect((await rosterMember(bot)).keys).toEqual(orderedKeys([...old, 'checkpoints.create']))
			expect((await rosterMember(bot)).label.preset?.id).toBe('qa')
			expect((await rosterMember(outsider)).keys).toEqual(orderedKeys([...old, 'flows.write']))
			expect(await page.locator('[data-preset-follow-up]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('adds, renames, reorders and deletes presets without changing any member\'s keys', async () => {
		const keys = [...VIEWER, 'reviews.write', 'flows.write'] as PermissionKey[]
		await setPresets(BUILT_IN)
		const holder = await member('human', keys)
		const { context, page } = await open()
		try {
			await page.locator('[data-preset-add]').click()
			const editor = page.locator('[data-preset-editor]')
			await editor.waitFor()
			await editor.locator('[data-preset-editor-name]').fill('  Flow author  ')
			for (const key of keys) await checkbox(editor, key).click()
			await editor.locator('[data-preset-editor-save]').click()
			await editor.waitFor({ state: 'detached' })
			await expect.poll(async () => (await readPresets()).resource!.presets.map(preset => preset.id)).toEqual(['viewer', 'reviewer', 'editor', 'owner', 'flow-author'])
			expect((await readPresets()).resource!.presets[4]).toEqual({ id: 'flow-author', name: 'Flow author', keys: orderedKeys(keys) })
			await expect.poll(async () => (await row(page, 'flow-author').locator('[data-preset-member-count]').innerText()).trim()).toBe('1 member')

			const renamed = await editPreset(page, 'flow-author')
			await renamed.locator('[data-preset-editor-name]').fill('Author')
			await renamed.locator('[data-preset-editor-save]').click()
			await renamed.waitFor({ state: 'detached' })
			// A rename alone offers no member step.
			expect(await page.locator('[data-preset-follow-up]').count()).toBe(0)

			await action(page, 'flow-author', 'Move up')
			await expect.poll(async () => await names(page)).toEqual(['Viewer', 'Reviewer', 'Editor', 'Author', 'Owner'])
			expect((await readPresets()).resource!.presets.map(preset => preset.name)).toEqual(['Viewer', 'Reviewer', 'Editor', 'Author', 'Owner'])

			await action(page, 'flow-author', 'Delete')
			const confirm = page.locator('[data-preset-delete]')
			await confirm.waitFor()
			expect((await confirm.locator('[data-preset-delete-count]').innerText()).trim()).toBe('It labels 1 member on this host.')
			await confirm.locator('[data-preset-delete-confirm]').click()
			await confirm.waitFor({ state: 'detached' })
			await expect.poll(async () => await names(page)).toEqual(['Viewer', 'Reviewer', 'Editor', 'Owner'])
			expect((await rosterMember(holder)).keys).toEqual(orderedKeys(keys))
			expect((await rosterMember(holder)).label).toEqual({ custom: true })
		}
		finally { await context.close() }
	}, 60_000)
})

describe('a concurrent change', () => {
	it('refuses a save against an older revision, then saves the draft against the newer presets', async () => {
		await setPresets(BUILT_IN)
		const { context, page } = await open()
		try {
			const editor = await editPreset(page, 'viewer')
			await checkbox(editor, 'flows.write').click()
			// Meanwhile another manager reorders the presets.
			await setPresets([BUILT_IN[1]!, BUILT_IN[0]!, BUILT_IN[2]!, BUILT_IN[3]!])
			await editor.locator('[data-preset-editor-save]').click()
			await editor.locator('[data-preset-editor-error]').waitFor()
			expect((await readPresets()).resource!.presets[1]).toEqual(BUILT_IN[0])
			await editor.locator('[data-preset-editor-save]').click()
			await editor.waitFor({ state: 'detached' })
			const presets = (await readPresets()).resource!.presets
			expect(presets.map(preset => preset.id)).toEqual(['reviewer', 'viewer', 'editor', 'owner'])
			expect(presets[1]!.keys).toEqual(orderedKeys([...VIEWER, 'flows.write']))
		}
		finally { await context.close() }
	}, 60_000)
})

describe('read-only', () => {
	it('is read-only without presets.manage, naming it, and cannot count members without members.manage', async () => {
		await setPresets(BUILT_IN)
		const cookie = await sessionCookieFor(server.origin, await provisionToken(server.workspaceRoot, { nickname: `p7-${unique()}`, kind: 'human', keys: ['workspace.read'] }))
		const { context, page } = await open({ cookie })
		try {
			expect(await names(page)).toEqual(['Viewer', 'Reviewer', 'Editor', 'Owner'])
			expect(await page.locator('[data-preset-add]').count()).toBe(0)
			expect(await page.locator('[data-preset-actions]').count()).toBe(0)
			expect(await page.locator('[data-access-notice]').getAttribute('data-missing-key')).toBe('presets.manage')
			expect(await row(page, 'viewer').locator('[data-preset-member-count]').getAttribute('aria-label')).toBe('Counting the members on this host needs members.manage.')
			const editor = await editPreset(page, 'viewer')
			expect(await editor.locator('[data-preset-editor-name]').count()).toBe(0)
			expect(await editor.locator('[data-preset-editor-save]').count()).toBe(0)
			expect(await checkbox(editor, 'workspace.read').isDisabled()).toBe(true)
		}
		finally { await context.close() }
	}, 60_000)

	it('is read-only on a tablet', async () => {
		const { context, page } = await open({ width: 1024 })
		try {
			await page.locator('[data-access-notice]').waitFor()
			expect(await page.locator('[data-access-notice]').innerText()).toContain('Edit on desktop')
			expect(await page.locator('[data-preset-add]').count()).toBe(0)
			expect(await page.locator('[data-preset-actions]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('a missing or unparsable presets file', () => {
	const file = () => join(server.workspaceRoot, ACCESS_PRESETS_FILENAME)

	it('reports a missing file and creates it from the built-in presets', async () => {
		await rm(file(), { force: true })
		const { context, page } = await open()
		try {
			expect(await page.locator('[data-access-presets]').getAttribute('data-file-state')).toBe('missing')
			expect(await page.locator('[data-presets-file-problem]').innerText()).toContain('This Workspace has no Access presets file')
			await page.locator('[data-presets-file-problem]').getByRole('button', { name: 'Start from the built-in presets' }).click()
			await expect.poll(async () => await names(page)).toEqual(['Viewer', 'Reviewer', 'Editor', 'Owner'])
			expect((await readPresets()).resource).toEqual({ presets: BUILT_IN })
		}
		finally { await context.close() }
	}, 60_000)

	it('reports a file that is not JSON and replaces it', async () => {
		await writeFile(file(), '<<<<<<< HEAD\n{ "presets": [] }\n=======\n')
		const { context, page } = await open()
		try {
			expect(await page.locator('[data-access-presets]').getAttribute('data-file-state')).toBe('unparsable')
			expect(await page.locator('[data-presets-file-problem]').innerText()).toContain('The Access presets file isn’t valid JSON')
			await page.locator('[data-presets-file-problem]').getByRole('button', { name: 'Start from the built-in presets' }).click()
			await expect.poll(async () => (await readPresets()).resource).toEqual({ presets: BUILT_IN })
			await expect.poll(async () => await page.locator('[data-access-presets]').getAttribute('data-file-state')).toBe('ok')
		}
		finally { await context.close() }
	}, 60_000)
})

describe('zh-TW', () => {
	it('names the page 存取預設集 and shows preset names as written', async () => {
		await setPresets(BUILT_IN)
		const { context, page } = await open({ locale: 'zh-TW' })
		try {
			expect((await page.locator('[data-workspace-subnav] a[href="/workspace/access-presets"]').innerText()).trim()).toBe('存取預設集')
			expect((await page.locator('h1').innerText()).trim()).toBe('存取預設集')
			expect(await names(page)).toEqual(['Viewer', 'Reviewer', 'Editor', 'Owner'])
		}
		finally { await context.close() }
	}, 60_000)
})
