import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { validateReviewRenderContextInput, validateReviewThread } from '../src/domain/reviews/schema'
import { FileNativePersistence } from '../src/persistence/file-native'
import { localeRelativePath, reviewRelativePath, viewRelativePath, workspaceRelativePath } from '../src/persistence/paths'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY, WORKSPACE_V3_TO_V4_STEP } from '../src/product/workspace-schema'

/**
 * Accepted decision group "Review render context" (Part 7, Discussion #7 c11), persisted shape only:
 * Clause 01a1170f-baf0-7eea-a904-7367227c10b3 (thread `renderContext`, Widget arm only, re-anchor
 * `before`/`after`) and the manifest-only `uiux.v3-to-v4` step (01a114ec-890a-73a1-808b-cb08087a9597).
 */

const V3 = { schemaVersion: 3 } as const
const V4 = { schemaVersion: 4 } as const
const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const REVIEW_ID = '22222222-2222-4222-8222-222222222222'
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333'
const EVENT_ID = '66666666-6666-4666-8666-666666666666'
const SECOND_EVENT_ID = '66666666-6666-4666-8666-666666666667'
const AUTHOR = { type: 'human', id: 'member:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'mei' }
const T0 = '2026-10-09T06:00:00.000Z'
const T1 = '2026-10-09T06:01:00.000Z'
const T2 = '2026-10-09T06:02:00.000Z'
const WIDGET = { viewId: VIEW_ID, widgetId: 'submit' }
const ROOT = { viewId: VIEW_ID, widgetId: 'root' }
const WORKSPACE = { scope: 'workspace' }
const ZH_MOBILE_DARK = { locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' }

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: REVIEW_ID,
		anchor: WIDGET,
		variantNames: [],
		status: 'open',
		messages: [{ id: MESSAGE_ID, actor: AUTHOR, at: T0, body: 'The label wraps on mobile.' }],
		history: [],
		submissions: [],
		...overrides,
	}
}

function reanchor(id: string, at: string, before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
	return { id, kind: 'reanchor', actor: AUTHOR, at, before: { variantNames: [], ...before }, after: { variantNames: [], ...after } }
}

function codes(input: unknown, context: { schemaVersion: number } = V4): string[] {
	return validateReviewThread(input, context).diagnostics.map(item => item.code)
}

function paths(input: unknown, context: { schemaVersion: number } = V4): string[] {
	return validateReviewThread(input, context).diagnostics.map(item => item.path)
}

describe('thread renderContext shape (schemaVersion 4)', () => {
	it('accepts any non-empty subset of locale, viewportId and themeId on the Widget arm, the RootShell anchor included', () => {
		for (const renderContext of [ZH_MOBILE_DARK, { locale: 'en-US' }, { viewportId: 'tablet' }, { themeId: 'light' }, { locale: 'zh-Hant-TW', themeId: 'dark' }])
			expect(validateReviewThread(thread({ renderContext }), V4).ok).toBe(true)
		expect(validateReviewThread(thread({ anchor: ROOT, renderContext: ZH_MOBILE_DARK }), V4).ok).toBe(true)
		// Absent stays valid: the context is unknown.
		expect(validateReviewThread(thread(), V4).ok).toBe(true)
	})

	it('never checks that a key still exists, so a stale key decodes', () => {
		expect(validateReviewThread(thread({ renderContext: { viewportId: 'deleted-viewport', themeId: 'retired-theme', locale: 'fr' } }), V4).ok).toBe(true)
	})

	it('rejects an empty object', () => {
		expect(codes(thread({ renderContext: {} }))).toEqual(['review.render_context_empty'])
		expect(paths(thread({ renderContext: {} }))).toEqual(['/renderContext'])
	})

	it('rejects unknown keys, alone or beside known ones', () => {
		expect(codes(thread({ renderContext: { variant: 'empty' } }))).toEqual(['schema.unknown_field'])
		expect(codes(thread({ renderContext: { locale: 'en-US', density: 'compact' } }))).toEqual(['schema.unknown_field'])
		expect(paths(thread({ renderContext: { locale: 'en-US', density: 'compact' } }))).toEqual(['/renderContext/density'])
	})

	it('rejects a locale that is not a canonical BCP 47 tag', () => {
		for (const locale of ['zh_TW', 'zh-tw', 'EN-us', '', 'not a locale', 42, null])
			expect(codes(thread({ renderContext: { locale } })), String(locale)).toEqual(['review.render_context_invalid_locale'])
		expect(paths(thread({ renderContext: { locale: 'zh-tw' } }))).toEqual(['/renderContext/locale'])
	})

	it('rejects empty or non-string viewport and theme ids and a non-object container', () => {
		expect(codes(thread({ renderContext: { viewportId: '' } }))).toEqual(['schema.empty_string'])
		expect(codes(thread({ renderContext: { themeId: 7 } }))).toEqual(['schema.expected_string'])
		expect(codes(thread({ renderContext: null }))).toEqual(['schema.expected_object'])
		expect(codes(thread({ renderContext: ['zh-TW'] }))).toEqual(['schema.expected_object'])
	})

	it('rejects renderContext on the Workspace arm', () => {
		expect(codes(thread({ anchor: WORKSPACE, renderContext: { locale: 'en-US' } }))).toEqual(['review.render_context_without_widget'])
		expect(paths(thread({ anchor: WORKSPACE, renderContext: { locale: 'en-US' } }))).toEqual(['/renderContext'])
	})
})

describe('re-anchor renderContext continuity (schemaVersion 4)', () => {
	it('accepts a re-anchor that sets, keeps, changes or clears the context when the thread matches the last after', () => {
		const set = reanchor(EVENT_ID, T1, { anchor: WIDGET }, { anchor: ROOT, renderContext: ZH_MOBILE_DARK })
		expect(validateReviewThread(thread({ anchor: ROOT, renderContext: ZH_MOBILE_DARK, history: [set] }), V4).ok).toBe(true)
		const keep = reanchor(SECOND_EVENT_ID, T2, { anchor: ROOT, renderContext: ZH_MOBILE_DARK }, { anchor: WIDGET, renderContext: ZH_MOBILE_DARK })
		expect(validateReviewThread(thread({ renderContext: ZH_MOBILE_DARK, history: [set, keep] }), V4).ok).toBe(true)
		const change = reanchor(SECOND_EVENT_ID, T2, { anchor: ROOT, renderContext: ZH_MOBILE_DARK }, { anchor: WIDGET, renderContext: { locale: 'en-US' } })
		expect(validateReviewThread(thread({ renderContext: { locale: 'en-US' }, history: [set, change] }), V4).ok).toBe(true)
		const clear = reanchor(SECOND_EVENT_ID, T2, { anchor: ROOT, renderContext: ZH_MOBILE_DARK }, { anchor: WIDGET })
		expect(validateReviewThread(thread({ history: [set, clear] }), V4).ok).toBe(true)
	})

	it('compares members, not key order', () => {
		const set = reanchor(EVENT_ID, T1, { anchor: WIDGET }, { anchor: WIDGET, renderContext: { locale: 'zh-TW', themeId: 'dark' } })
		expect(validateReviewThread(thread({ renderContext: { themeId: 'dark', locale: 'zh-TW' }, history: [set] }), V4).ok).toBe(true)
	})

	it('requires the current renderContext to equal the latest after', () => {
		const set = reanchor(EVENT_ID, T1, { anchor: WIDGET }, { anchor: WIDGET, renderContext: ZH_MOBILE_DARK })
		expect(codes(thread({ history: [set] }))).toEqual(['review.render_context_history_mismatch'])
		expect(codes(thread({ renderContext: { locale: 'zh-TW' }, history: [set] }))).toEqual(['review.render_context_history_mismatch'])
		const none = reanchor(EVENT_ID, T1, { anchor: WIDGET }, { anchor: WIDGET })
		expect(codes(thread({ renderContext: ZH_MOBILE_DARK, history: [none] }))).toEqual(['review.render_context_history_mismatch'])
	})

	it('requires each before to repeat the preceding after', () => {
		const set = reanchor(EVENT_ID, T1, { anchor: WIDGET }, { anchor: WIDGET, renderContext: ZH_MOBILE_DARK })
		const forgot = reanchor(SECOND_EVENT_ID, T2, { anchor: WIDGET }, { anchor: ROOT, renderContext: ZH_MOBILE_DARK })
		expect(codes(thread({ anchor: ROOT, renderContext: ZH_MOBILE_DARK, history: [set, forgot] }))).toEqual(['review.render_context_discontinuous_history'])
		expect(paths(thread({ anchor: ROOT, renderContext: ZH_MOBILE_DARK, history: [set, forgot] }))).toEqual(['/history/1/before/renderContext'])
	})

	it('lets a thread created with a context keep it without any re-anchor', () => {
		expect(validateReviewThread(thread({ renderContext: ZH_MOBILE_DARK }), V4).ok).toBe(true)
	})

	it('clears the context on a re-anchor to the Workspace arm and refuses one recorded there', () => {
		const toWorkspace = reanchor(EVENT_ID, T1, { anchor: WIDGET, renderContext: ZH_MOBILE_DARK }, { anchor: WORKSPACE })
		expect(validateReviewThread(thread({ anchor: WORKSPACE, history: [toWorkspace] }), V4).ok).toBe(true)
		const kept = reanchor(EVENT_ID, T1, { anchor: WIDGET, renderContext: ZH_MOBILE_DARK }, { anchor: WORKSPACE, renderContext: ZH_MOBILE_DARK })
		expect(codes(thread({ anchor: WORKSPACE, history: [kept] }))).toEqual(['review.render_context_without_widget', 'review.render_context_history_mismatch'])
		expect(paths(thread({ anchor: WORKSPACE, history: [kept] }))[0]).toBe('/history/0/after/renderContext')
	})

	it('validates the shape inside before and after', () => {
		const empty = reanchor(EVENT_ID, T1, { anchor: WIDGET }, { anchor: WIDGET, renderContext: {} })
		expect(codes(thread({ history: [empty] }))).toContain('review.render_context_empty')
		const unknown = reanchor(EVENT_ID, T1, { anchor: WIDGET, renderContext: { device: 'phone' } }, { anchor: WIDGET })
		expect(codes(thread({ history: [unknown] }))).toEqual(['schema.unknown_field'])
	})
})

describe('version gating', () => {
	it('rejects renderContext on the thread and in re-anchor events under schemaVersion 3 and earlier', () => {
		for (const schemaVersion of [1, 2, 3]) {
			expect(codes(thread({ renderContext: ZH_MOBILE_DARK }), { schemaVersion })).toEqual(['schema.unknown_field'])
			const event = reanchor(EVENT_ID, T1, { anchor: WIDGET }, { anchor: ROOT, renderContext: ZH_MOBILE_DARK })
			expect(codes(thread({ anchor: ROOT, history: [event] }), { schemaVersion })).toEqual(['schema.unknown_field'])
		}
		expect(validateReviewThread(thread({ renderContext: ZH_MOBILE_DARK }), V3).diagnostics[0]?.path).toBe('/renderContext')
	})

	it('decodes every v3-valid thread under v4 unchanged', () => {
		const event = reanchor(EVENT_ID, T1, { anchor: WIDGET }, { anchor: WORKSPACE })
		for (const input of [thread(), thread({ anchor: WORKSPACE, history: [event] }), thread({ displayHint: { pin: { x: 0.5, y: 0.5 } } })]) {
			expect(validateReviewThread(input, V3).ok).toBe(true)
			expect(validateReviewThread(input, V4).ok).toBe(true)
		}
	})
})

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const v3Manifest = { schemaVersion: 3, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: { mobile: { dimensions: { width: 390, height: 844 } } }, themes: { dark: {} } }
const view = {
	id: VIEW_ID,
	name: 'Checkout',
	ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
	variants: {},
	spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
}

async function seedV3Workspace(reviews: readonly Record<string, unknown>[]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-v3-to-v4-'))
	roots.push(root)
	await mkdir(join(root, '.uiux'), { recursive: true })
	await mkdir(join(root, 'views'), { recursive: true })
	await mkdir(join(root, 'reviews'), { recursive: true })
	await writeFile(join(root, workspaceRelativePath()), `${JSON.stringify(v3Manifest, null, 2)}\n`)
	await writeFile(join(root, viewRelativePath(VIEW_ID)), `${JSON.stringify(view)}\n`)
	for (const review of reviews) await writeFile(join(root, reviewRelativePath(review.id as string)), `${JSON.stringify(review)}\n`)
	return root
}

async function snapshot(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {}
	for (const directory of ['.uiux', 'views', 'reviews']) {
		for (const entry of await readdir(join(root, directory), { withFileTypes: true }))
			if (entry.isFile()) files[`${directory}/${entry.name}`] = await readFile(join(root, directory, entry.name), 'utf8')
	}
	return files
}

describe('uiux.v3-to-v4 (manifest-only step)', () => {
	it('bumps only the manifest, backfills no renderContext, and is idempotent', async () => {
		const root = await seedV3Workspace([thread({ anchor: WORKSPACE })])
		const before = await snapshot(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect((await persistence.inspectWorkspace()).inspection).toMatchObject({ state: 'migration_required', version: 3, targetVersion: 4 })
		expect(await persistence.planWorkspaceMigration()).toMatchObject({ fromVersion: 3, version: 4, steps: ['uiux.v3-to-v4'], changedFiles: ['.uiux/workspace.json'] })
		expect(await snapshot(root)).toEqual(before)
		const result = await persistence.migrateWorkspace()
		expect(result).toMatchObject({ fromVersion: 3, version: 4, steps: ['uiux.v3-to-v4'], changedFiles: ['.uiux/workspace.json'] })
		const after = await snapshot(root)
		expect(JSON.parse(after['.uiux/workspace.json']!)).toEqual({ ...v3Manifest, schemaVersion: 4 })
		for (const path of Object.keys(before).filter(path => path !== '.uiux/workspace.json')) expect(after[path]).toBe(before[path])
		expect((await persistence.reviews.readInspected(REVIEW_ID))?.diagnostics).toEqual([])
		expect(await persistence.migrateWorkspace()).toMatchObject({ version: 4, steps: [], changedFiles: [], revision: result.revision })
		expect(await snapshot(root)).toEqual(after)
	})

	it('decodes a v4 thread with renderContext through persistence once migrated', async () => {
		const root = await seedV3Workspace([])
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await persistence.migrateWorkspace()
		await writeFile(join(root, reviewRelativePath(REVIEW_ID)), `${JSON.stringify(thread({ renderContext: ZH_MOBILE_DARK }))}\n`)
		expect((await persistence.reviews.readInspected(REVIEW_ID))?.diagnostics).toEqual([])
		expect((await persistence.reviews.read(REVIEW_ID))?.resource.renderContext).toEqual(ZH_MOBILE_DARK)
	})

	it('leaves v4-only content smuggled into a v3 file byte-identical: refused under v3, decoded under v4 once migrated', async () => {
		const smuggled = thread({ id: '77777777-7777-4777-8777-777777777777', renderContext: ZH_MOBILE_DARK })
		const root = await seedV3Workspace([thread(), smuggled])
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect((await persistence.reviews.readInspected(smuggled.id as string))?.diagnostics.map(item => item.code)).toEqual(['schema.unknown_field'])
		const bytes = await readFile(join(root, reviewRelativePath(smuggled.id as string)), 'utf8')
		expect((await persistence.migrateWorkspace()).changedFiles).toEqual(['.uiux/workspace.json'])
		expect(await readFile(join(root, reviewRelativePath(smuggled.id as string)), 'utf8')).toBe(bytes)
		expect((await persistence.reviews.readInspected(smuggled.id as string))?.diagnostics).toEqual([])
	})

	it('refuses to apply to anything but a v3 manifest and leaves unparseable Reviews to persistence', () => {
		const manifest = (version: number) => new Map([[workspaceRelativePath(), new TextEncoder().encode(JSON.stringify({ ...v3Manifest, schemaVersion: version }))]])
		expect(() => WORKSPACE_V3_TO_V4_STEP.apply(manifest(2))).toThrow(/schemaVersion 3/)
		expect(() => WORKSPACE_V3_TO_V4_STEP.apply(manifest(4))).toThrow(/schemaVersion 3/)
		expect(() => WORKSPACE_V3_TO_V4_STEP.apply(new Map())).toThrow(/workspace\.json/)
		const withBroken = manifest(3)
		withBroken.set('reviews/x.review.json', new TextEncoder().encode('{ not json'))
		const next = WORKSPACE_V3_TO_V4_STEP.apply(withBroken)
		expect(new TextDecoder().decode(next.get('reviews/x.review.json'))).toBe('{ not json')
		expect(JSON.parse(new TextDecoder().decode(next.get(workspaceRelativePath()))).schemaVersion).toBe(4)
	})
})

describe('re-anchor keeps or clears the recorded renderContext (owner ruling 1, omitted keeps)', () => {
	async function seedThreadWithContext() {
		const root = await seedV3Workspace([])
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await persistence.migrateWorkspace()
		await writeFile(join(root, reviewRelativePath(REVIEW_ID)), `${JSON.stringify(thread({ renderContext: ZH_MOBILE_DARK }))}\n`)
		return { root, persistence, app: createWorkspaceApplicationSession(persistence) }
	}

	async function readBack(root: string, persistence: FileNativePersistence) {
		expect((await persistence.reviews.readInspected(REVIEW_ID))?.diagnostics).toEqual([])
		const stored = JSON.parse(await readFile(join(root, reviewRelativePath(REVIEW_ID)), 'utf8')) as Record<string, unknown> & { history: Record<string, unknown>[] }
		expect(validateReviewThread(stored, V4).ok).toBe(true)
		return stored
	}

	it('keeps the context on a re-anchor to another Widget and records it on both sides', async () => {
		const { root, persistence, app } = await seedThreadWithContext()
		const revision = (await persistence.reviews.readRevision(REVIEW_ID))!
		expect(await app.reanchorReviewThread({ reviewId: REVIEW_ID, expectedRevision: revision, anchor: ROOT, actor: AUTHOR }))
			.toMatchObject({ status: 'updated' })
		const stored = await readBack(root, persistence)
		expect(stored.anchor).toEqual(ROOT)
		expect(stored.renderContext).toEqual(ZH_MOBILE_DARK)
		expect(stored.history.at(-1)).toMatchObject({
			kind: 'reanchor',
			before: { anchor: WIDGET, renderContext: ZH_MOBILE_DARK },
			after: { anchor: ROOT, renderContext: ZH_MOBILE_DARK },
		})
	})

	it('clears the context on a re-anchor to the Workspace arm, and a later Widget re-anchor stays unknown', async () => {
		const { root, persistence, app } = await seedThreadWithContext()
		const revision = (await persistence.reviews.readRevision(REVIEW_ID))!
		expect(await app.reanchorReviewThread({ reviewId: REVIEW_ID, expectedRevision: revision, anchor: { scope: 'workspace' }, actor: AUTHOR }))
			.toMatchObject({ status: 'updated' })
		const cleared = await readBack(root, persistence)
		expect(cleared.anchor).toEqual(WORKSPACE)
		expect(cleared).not.toHaveProperty('renderContext')
		expect(cleared.history.at(-1)).toMatchObject({ before: { anchor: WIDGET, renderContext: ZH_MOBILE_DARK } })
		expect(cleared.history.at(-1)!.after).toEqual({ anchor: WORKSPACE, variantNames: [] })

		const next = (await persistence.reviews.readRevision(REVIEW_ID))!
		expect(await app.reanchorReviewThread({ reviewId: REVIEW_ID, expectedRevision: next, anchor: ROOT, actor: AUTHOR }))
			.toMatchObject({ status: 'updated' })
		const back = await readBack(root, persistence)
		expect(back).not.toHaveProperty('renderContext')
		expect(back.history.at(-1)!.before).toEqual({ anchor: WORKSPACE, variantNames: [] })
		expect(back.history.at(-1)!.after).toEqual({ anchor: ROOT, variantNames: [] })
	})
})

describe('validateReviewRenderContextInput (writer-side shape check)', () => {
	it('accepts a non-empty context on a Widget anchor and reports each shape error once at the given path', () => {
		expect(validateReviewRenderContextInput(ZH_MOBILE_DARK, '/renderContext', WIDGET)).toMatchObject({ ok: true, value: ZH_MOBILE_DARK })
		const refuse = (value: unknown, anchor: typeof WIDGET | { scope: 'workspace' } = WIDGET) =>
			validateReviewRenderContextInput(value, '/renderContext', anchor).diagnostics.map(item => [item.code, item.path])
		expect(refuse({ locale: 'en-US' }, { scope: 'workspace' })).toEqual([['review.render_context_without_widget', '/renderContext']])
		expect(refuse({})).toEqual([['review.render_context_empty', '/renderContext']])
		expect(refuse({ locale: 'zh_TW' })).toEqual([['review.render_context_invalid_locale', '/renderContext/locale']])
		expect(refuse({ density: 'compact', themeId: 'dark' })).toEqual([['schema.unknown_field', '/renderContext/density']])
	})
})

/**
 * Write path (Clause 01a1170f-bba0-7982-bc92-7eef91459828; owner rulings, Discussion #7,
 * 2026-10-09): only Workspace-authored keys are recorded; on re-anchor an object sets, null clears
 * and omitted keeps.
 */
describe('Review authoring records only Workspace keys in renderContext', () => {
	async function seedV4Workspace() {
		const root = await seedV3Workspace([])
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await persistence.migrateWorkspace()
		await mkdir(join(root, 'i18n'), { recursive: true })
		await writeFile(join(root, localeRelativePath('zh-TW')), '{}\n')
		return { root, persistence, app: createWorkspaceApplicationSession(persistence) }
	}

	async function storedThread(root: string) {
		return JSON.parse(await readFile(join(root, reviewRelativePath(REVIEW_ID)), 'utf8')) as Record<string, unknown> & { history: Record<string, unknown>[] }
	}

	function refusals(result: unknown): Array<[string, string]> {
		const diagnostics = (result as { diagnostics?: { code: string; path: string }[] }).diagnostics ?? []
		return diagnostics.map(item => [item.code, item.path])
	}

	it('creates a thread with keys from the authored viewports and themes, an i18n file and the default Locale', async () => {
		const { root, persistence, app } = await seedV4Workspace()
		expect(await app.createReviewThread({ id: REVIEW_ID, anchor: WIDGET, renderContext: ZH_MOBILE_DARK })).toMatchObject({ status: 'created', diagnostics: [] })
		expect((await storedThread(root)).renderContext).toEqual(ZH_MOBILE_DARK)
		expect((await persistence.reviews.readInspected(REVIEW_ID))?.diagnostics).toEqual([])
		const second = '88888888-8888-4888-8888-888888888888'
		expect(await app.createReviewThread({ id: second, anchor: ROOT, renderContext: { locale: 'en-US' } })).toMatchObject({ status: 'created' })
		expect((await persistence.reviews.read(second))?.resource.renderContext).toEqual({ locale: 'en-US' })
	})

	it('refuses unknown keys, unauthored built-in fallbacks included, reports every one, and writes nothing', async () => {
		const { root, app } = await seedV4Workspace()
		const refused = await app.createReviewThread({ id: REVIEW_ID, anchor: WIDGET, renderContext: { locale: 'fr-FR', viewportId: 'default', themeId: 'light' } })
		expect(refused).toMatchObject({ status: 'invalid', key: REVIEW_ID })
		expect(refusals(refused)).toEqual([
			['review.render_context_unknown_key', '/renderContext/locale'],
			['review.render_context_unknown_key', '/renderContext/viewportId'],
			['review.render_context_unknown_key', '/renderContext/themeId'],
		])
		expect(await readdir(join(root, 'reviews'))).toEqual([])
		expect(refusals(await app.createReviewThread({ anchor: WIDGET, renderContext: { viewportId: 'mobile', themeId: 'retired' } })))
			.toEqual([['review.render_context_unknown_key', '/renderContext/themeId']])
		expect(await readdir(join(root, 'reviews'))).toEqual([])
	})

	it('refuses a renderContext on a Workspace anchor and writes nothing', async () => {
		const { root, app } = await seedV4Workspace()
		const refused = await app.createReviewThread({ id: REVIEW_ID, anchor: { scope: 'workspace' }, renderContext: { locale: 'en-US' } })
		expect(refused).toMatchObject({ status: 'invalid' })
		expect(refusals(refused)).toEqual([['review.render_context_without_widget', '/renderContext']])
		expect(await readdir(join(root, 'reviews'))).toEqual([])
	})

	it('re-anchors: an object sets, omitted keeps, null clears, each recorded on both sides of the event', async () => {
		const { root, persistence, app } = await seedV4Workspace()
		const created = await app.createReviewThread({ id: REVIEW_ID, anchor: WIDGET })
		if (created.status !== 'created') throw new Error('Thread fixture failed.')
		const revision = async () => (await persistence.reviews.readRevision(REVIEW_ID))!
		const ZH_MOBILE = { locale: 'zh-TW', viewportId: 'mobile' }

		expect(await app.reanchorReviewThread({ reviewId: REVIEW_ID, expectedRevision: created.revision, anchor: WIDGET, renderContext: ZH_MOBILE, actor: AUTHOR }))
			.toMatchObject({ status: 'updated' })
		let stored = await storedThread(root)
		expect(stored.renderContext).toEqual(ZH_MOBILE)
		expect(stored.history.at(-1)!.before).toEqual({ anchor: WIDGET, variantNames: [] })
		expect(stored.history.at(-1)!.after).toEqual({ anchor: WIDGET, variantNames: [], renderContext: ZH_MOBILE })

		expect(await app.reanchorReviewThread({ reviewId: REVIEW_ID, expectedRevision: await revision(), anchor: ROOT, actor: AUTHOR }))
			.toMatchObject({ status: 'updated' })
		stored = await storedThread(root)
		expect(stored.renderContext).toEqual(ZH_MOBILE)
		expect(stored.history.at(-1)!.after).toEqual({ anchor: ROOT, variantNames: [], renderContext: ZH_MOBILE })

		expect(await app.reanchorReviewThread({ reviewId: REVIEW_ID, expectedRevision: await revision(), anchor: ROOT, renderContext: null, actor: AUTHOR }))
			.toMatchObject({ status: 'updated' })
		stored = await storedThread(root)
		expect(stored).not.toHaveProperty('renderContext')
		expect(stored.history.at(-1)!.before).toEqual({ anchor: ROOT, variantNames: [], renderContext: ZH_MOBILE })
		expect(stored.history.at(-1)!.after).toEqual({ anchor: ROOT, variantNames: [] })
		expect((await persistence.reviews.readInspected(REVIEW_ID))?.diagnostics).toEqual([])
	})

	it('refuses an unknown key, or an object with a Workspace target, on re-anchor without writing, and never re-checks a kept stale key', async () => {
		const { root, persistence, app } = await seedV4Workspace()
		// The Workspace has no `tablet` viewport (any more): the recorded key is stale but valid.
		await writeFile(join(root, reviewRelativePath(REVIEW_ID)), `${JSON.stringify(thread({ renderContext: { viewportId: 'tablet' } }))}\n`)
		const revision = (await persistence.reviews.readRevision(REVIEW_ID))!
		const bytes = await readFile(join(root, reviewRelativePath(REVIEW_ID)), 'utf8')

		const unknown = await app.reanchorReviewThread({ reviewId: REVIEW_ID, expectedRevision: revision, anchor: ROOT, renderContext: { viewportId: 'tablet' }, actor: AUTHOR })
		expect(refusals(unknown)).toEqual([['review.render_context_unknown_key', '/renderContext/viewportId']])
		const toWorkspace = await app.reanchorReviewThread({ reviewId: REVIEW_ID, expectedRevision: revision, anchor: { scope: 'workspace' }, renderContext: { locale: 'en-US' }, actor: AUTHOR })
		expect(refusals(toWorkspace)).toEqual([['review.render_context_without_widget', '/renderContext']])
		expect(await readFile(join(root, reviewRelativePath(REVIEW_ID)), 'utf8')).toBe(bytes)

		expect(await app.reanchorReviewThread({ reviewId: REVIEW_ID, expectedRevision: revision, anchor: ROOT, actor: AUTHOR }))
			.toMatchObject({ status: 'updated' })
		expect((await storedThread(root)).renderContext).toEqual({ viewportId: 'tablet' })
	})
})
