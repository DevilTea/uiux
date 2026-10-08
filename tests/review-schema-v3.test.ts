import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
	anchorViewId,
	isMessageFrozen,
	isWidgetAnchor,
	isWorkspaceAnchor,
	messageEditedAt,
	validateReviewThread,
	type ReviewThread,
} from '../src/domain/reviews/schema'
import { FileNativePersistence } from '../src/persistence/file-native'
import { reviewRelativePath, viewRelativePath, workspaceRelativePath } from '../src/persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY, WORKSPACE_V2_TO_V3_STEP } from '../src/product/workspace-schema'

/**
 * Accepted decision group "Workspace-scoped Review threads and editable Review messages" (Part 7):
 * validator rules 2.1–2.6 and 13.1–13.7 under schemaVersion 3, and the manifest-only
 * `uiux.v2-to-v3` step.
 */

const V2 = { schemaVersion: 2 } as const
const V3 = { schemaVersion: 3 } as const
const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const REVIEW_ID = '22222222-2222-4222-8222-222222222222'
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333'
const SECOND_MESSAGE_ID = '33333333-3333-4333-8333-333333333334'
const EDIT_ID = '44444444-4444-4444-8444-444444444444'
const SECOND_EDIT_ID = '44444444-4444-4444-8444-444444444445'
const SUBMISSION_ID = '55555555-5555-4555-8555-555555555555'
const EVENT_ID = '66666666-6666-4666-8666-666666666666'
const SECOND_EVENT_ID = '66666666-6666-4666-8666-666666666667'
const THIRD_EVENT_ID = '66666666-6666-4666-8666-666666666668'
const AUTHOR = { type: 'human', id: 'member:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'mei' }
const OTHER = { type: 'human', id: 'member:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'rui' }
const AGENT = { type: 'agent', id: 'member:cccccccc-cccc-4ccc-8ccc-cccccccccccc', displayName: 'claude' }
const T0 = '2026-10-06T06:00:00.000Z'
const T1 = '2026-10-06T06:01:00.000Z'
const T2 = '2026-10-06T06:02:00.000Z'
const T3 = '2026-10-06T06:03:00.000Z'
const T4 = '2026-10-06T06:04:00.000Z'

type Mutable = Record<string, unknown> & { messages: Record<string, unknown>[]; history: Record<string, unknown>[]; submissions: Record<string, unknown>[] }

function workspaceThread(overrides: Record<string, unknown> = {}): Mutable {
	return {
		id: REVIEW_ID,
		anchor: { scope: 'workspace' },
		variantNames: [],
		status: 'open',
		messages: [{ id: MESSAGE_ID, actor: AUTHOR, at: T0, body: 'Use one date format everywhere.' }],
		history: [],
		submissions: [],
		...overrides,
	} as Mutable
}

function widgetThread(overrides: Record<string, unknown> = {}): Mutable {
	return workspaceThread({ anchor: { viewId: VIEW_ID, widgetId: 'submit' }, ...overrides })
}

function edited(edits: Record<string, unknown>[], body = 'Use one date format everywhere, please.', actor: Record<string, unknown> = AUTHOR): Record<string, unknown> {
	return { id: MESSAGE_ID, actor, at: T0, body, edits }
}

function submission(at: string): Record<string, unknown> {
	return {
		id: SUBMISSION_ID,
		actor: AGENT,
		at,
		changeDomains: ['copy'],
		resources: [{ identity: { type: 'workspace' }, revision: 'r_1' }],
		scope: {},
		evidenceRefs: [{ kind: 'screenshot', evidence: `sha256:${'a'.repeat(64)}` }],
	}
}

function codes(input: unknown, context: { schemaVersion: number } = V3): string[] {
	return validateReviewThread(input, context).diagnostics.map(item => item.code)
}

describe('Workspace anchor arm (rules 2.1–2.6)', () => {
	it('accepts { scope: "workspace" } with [] variants and no hint under v3, and keeps Widget threads unchanged', () => {
		expect(validateReviewThread(workspaceThread(), V3).ok).toBe(true)
		expect(validateReviewThread(widgetThread(), V3).ok).toBe(true)
		expect(validateReviewThread(widgetThread({ displayHint: { pin: { x: 0.5, y: 0.5 } }, variantNames: ['empty'] }), V3).ok).toBe(true)
	})

	it('keeps the Workspace arm invalid under schemaVersion 1 and 2 (version gating)', () => {
		for (const schemaVersion of [1, 2]) {
			const found = codes(workspaceThread(), { schemaVersion })
			expect(found).toContain('schema.unknown_field')
			expect(found.length).toBeGreaterThan(1)
		}
	})

	it('rejects another scope value, mixed members and an empty anchor', () => {
		expect(codes(workspaceThread({ anchor: { scope: 'flow' } }))).toEqual(['review.invalid_anchor_scope'])
		expect(codes(workspaceThread({ anchor: { scope: 'workspace', viewId: VIEW_ID } }))).toEqual(['schema.unknown_field'])
		expect(validateReviewThread(workspaceThread({ anchor: { scope: 'workspace', viewId: VIEW_ID } }), V3).diagnostics[0]?.path).toBe('/anchor/viewId')
		expect(codes(workspaceThread({ anchor: {} }))).not.toEqual([])
	})

	it('requires variantNames [] and forbids displayHint on a Workspace thread', () => {
		expect(codes(workspaceThread({ variantNames: ['empty'] }))).toEqual(['review.workspace_anchor_variants'])
		expect(codes(workspaceThread({ variantNames: undefined }))).toContain('schema.expected_array')
		expect(codes(workspaceThread({ displayHint: { pin: { x: 0.5, y: 0.5 } } }))).toEqual(['review.display_hint_without_widget'])
	})

	it('validates re-anchor history between the arms in both directions and compares arms first', () => {
		const toWorkspace = workspaceThread({
			history: [{ id: EVENT_ID, kind: 'reanchor', actor: AUTHOR, at: T1, before: { anchor: { viewId: VIEW_ID, widgetId: 'submit' }, variantNames: ['empty'] }, after: { anchor: { scope: 'workspace' }, variantNames: [] } }],
		})
		expect(validateReviewThread(toWorkspace, V3).ok).toBe(true)
		const back = widgetThread({
			history: [
				...toWorkspace.history,
				{ id: SECOND_EVENT_ID, kind: 'reanchor', actor: AUTHOR, at: T2, before: { anchor: { scope: 'workspace' }, variantNames: [] }, after: { anchor: { viewId: VIEW_ID, widgetId: 'submit' }, variantNames: [] } },
			],
		})
		expect(validateReviewThread(back, V3).ok).toBe(true)
		// Workspace -> Workspace records an event like a same-Widget re-anchor.
		const same = workspaceThread({ history: [{ id: EVENT_ID, kind: 'reanchor', actor: AUTHOR, at: T1, before: { anchor: { scope: 'workspace' }, variantNames: [] }, after: { anchor: { scope: 'workspace' }, variantNames: [] } }] })
		expect(validateReviewThread(same, V3).ok).toBe(true)
		// A Workspace anchor never equals a Widget anchor.
		expect(codes(widgetThread({ history: toWorkspace.history }))).toEqual(['review.anchor_history_mismatch'])
		const variantsOnWorkspace = workspaceThread({ history: [{ ...toWorkspace.history[0], after: { anchor: { scope: 'workspace' }, variantNames: ['empty'] } }] })
		expect(codes(variantsOnWorkspace)).toContain('review.workspace_anchor_variants')
		// Under v2 a Workspace arm inside history is an unknown field.
		expect(codes(toWorkspace, V2)).toContain('schema.unknown_field')
	})

	it('narrows the union with the exported guards', () => {
		expect(isWorkspaceAnchor({ scope: 'workspace' })).toBe(true)
		expect(isWorkspaceAnchor({ viewId: VIEW_ID, widgetId: 'root' })).toBe(false)
		expect(isWidgetAnchor({ viewId: VIEW_ID, widgetId: 'root' })).toBe(true)
		expect(isWidgetAnchor({ scope: 'workspace' })).toBe(false)
		expect(anchorViewId({ scope: 'workspace' })).toBeUndefined()
		expect(anchorViewId({ viewId: VIEW_ID, widgetId: 'root' })).toBe(VIEW_ID)
	})
})

describe('message edits[] (rules 13.1–13.7)', () => {
	it('accepts an author edit and derives edited-at, never storing it', () => {
		const thread = workspaceThread({ messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'Use one date format.' }])] })
		expect(validateReviewThread(thread, V3).ok).toBe(true)
		expect(messageEditedAt(thread.messages[0] as never)).toBe(T1)
		expect(messageEditedAt({})).toBeUndefined()
		const twice = workspaceThread({ messages: [edited([
			{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'v1' },
			{ id: SECOND_EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'v2' },
		], 'v3')] })
		expect(validateReviewThread(twice, V3).ok).toBe(true)
	})

	it('keeps edits an unknown field under schemaVersion 2', () => {
		const thread = workspaceThread({ anchor: { viewId: VIEW_ID, widgetId: 'root' }, messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'x' }])] })
		expect(codes(thread, V2)).toEqual(['schema.unknown_field'])
	})

	it('rejects an empty edits array, unknown members and malformed entries', () => {
		expect(codes(workspaceThread({ messages: [edited([])] }))).toEqual(['review.message_edits_empty'])
		expect(codes(workspaceThread({ messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'x', body: 'y' }])] }))).toEqual(['schema.unknown_field'])
		expect(codes(workspaceThread({ messages: [edited([{ id: 'not-a-uuid', actor: AUTHOR, at: T1, previousBody: 'x' }])] }))).toContain('identity.invalid_uuid')
		expect(codes(workspaceThread({ messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: 'yesterday', previousBody: 'x' }])] }))).toContain('time.invalid_rfc3339_utc')
		expect(codes(workspaceThread({ messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T1 }])] }))).toContain('schema.expected_string')
	})

	it('joins edit ids to the thread-wide UUID uniqueness check', () => {
		expect(codes(workspaceThread({ messages: [edited([{ id: MESSAGE_ID, actor: AUTHOR, at: T1, previousBody: 'x' }])] }))).toEqual(['identity.duplicate_uuid'])
		const two = workspaceThread({ messages: [
			edited([{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'x' }]),
			{ id: SECOND_MESSAGE_ID, actor: AUTHOR, at: T2, body: 'y', edits: [{ id: EDIT_ID, actor: AUTHOR, at: T3, previousBody: 'z' }] },
		] })
		expect(codes(two)).toEqual(['identity.duplicate_uuid'])
	})

	it('enforces the author invariant, including legacy messages without an id', () => {
		expect(codes(workspaceThread({ messages: [edited([{ id: EDIT_ID, actor: OTHER, at: T1, previousBody: 'x' }])] }))).toEqual(['review.message_edit_not_author'])
		expect(codes(workspaceThread({ messages: [edited([{ id: EDIT_ID, actor: { ...AUTHOR, type: 'agent' }, at: T1, previousBody: 'x' }])] }))).toEqual(['review.message_edit_not_author'])
		const legacy = edited([{ id: EDIT_ID, actor: { type: 'human' }, at: T1, previousBody: 'x' }], 'y', { type: 'human', displayName: 'mei' })
		expect(codes(workspaceThread({ messages: [legacy] }))).toEqual(['review.message_edit_not_author'])
	})

	it('requires edits to follow the message and each other in time', () => {
		expect(codes(workspaceThread({ messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T0, previousBody: 'x' }])] }))).toEqual(['review.message_edit_out_of_order'])
		expect(codes(workspaceThread({ messages: [edited([
			{ id: EDIT_ID, actor: AUTHOR, at: T2, previousBody: 'v1' },
			{ id: SECOND_EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'v2' },
		], 'v3')] }))).toEqual(['review.message_edit_out_of_order'])
	})

	it('freezes a message at a later submission or resolution, and reopening never unfreezes it (O2)', () => {
		const ready = {
			status: 'ready-for-review',
			submissions: [submission(T1)],
			history: [{ id: EVENT_ID, kind: 'lifecycle', actor: AGENT, at: T1, from: 'open', to: 'ready-for-review', submissionId: SUBMISSION_ID }],
		}
		const afterSubmission = workspaceThread({ ...ready, messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T2, previousBody: 'x' }])] })
		expect(codes(afterSubmission)).toEqual(['review.message_edit_after_formal_act'])
		expect(isMessageFrozen(afterSubmission as unknown as ReviewThread, MESSAGE_ID)).toEqual({ frozen: true, by: 'submission', id: SUBMISSION_ID, at: T1 })

		const resolvedThenReopened = {
			status: 'open',
			history: [
				{ id: EVENT_ID, kind: 'lifecycle', actor: AUTHOR, at: T1, from: 'open', to: 'resolved', resolution: 'answered' },
				{ id: SECOND_EVENT_ID, kind: 'lifecycle', actor: AUTHOR, at: T2, from: 'resolved', to: 'open' },
			],
		}
		const afterResolve = workspaceThread({ ...resolvedThenReopened, messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T3, previousBody: 'x' }])] })
		expect(codes(afterResolve)).toEqual(['review.message_edit_after_formal_act'])
		expect(isMessageFrozen(afterResolve as unknown as ReviewThread, MESSAGE_ID)).toMatchObject({ frozen: true, by: 'resolution', id: EVENT_ID })

		// A message posted after the last formal act stays editable, even on a resolved thread.
		const later = workspaceThread({
			status: 'resolved',
			history: [{ id: EVENT_ID, kind: 'lifecycle', actor: AUTHOR, at: T1, from: 'open', to: 'resolved', resolution: 'answered' }],
			messages: [
				{ id: MESSAGE_ID, actor: AUTHOR, at: T0, body: 'first' },
				{ id: SECOND_MESSAGE_ID, actor: AUTHOR, at: T2, body: 'after', edits: [{ id: EDIT_ID, actor: AUTHOR, at: T3, previousBody: 'afte' }] },
			],
		})
		expect(validateReviewThread(later, V3).ok).toBe(true)
		expect(isMessageFrozen(later as unknown as ReviewThread, MESSAGE_ID).frozen).toBe(true)
		expect(isMessageFrozen(later as unknown as ReviewThread, SECOND_MESSAGE_ID).frozen).toBe(false)
		expect(isMessageFrozen(later as unknown as ReviewThread, 'missing').frozen).toBe(false)
		// An edit made before the formal act stays valid after it.
		const editedBefore = workspaceThread({ ...resolvedThenReopened, history: [{ ...resolvedThenReopened.history[0], at: T4 }, { ...resolvedThenReopened.history[1], at: '2026-10-06T06:05:00.000Z' }], messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'x' }])] })
		expect(validateReviewThread(editedBefore, V3).ok).toBe(true)
		// A reopen alone (no resolve in range) does not freeze.
		expect(codes(workspaceThread({ status: 'open', history: [], messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'x' }])] }))).toEqual([])
		void THIRD_EVENT_ID
	})

	it('refuses an edit that empties the text and no-op edits (R13)', () => {
		expect(codes(workspaceThread({ messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'x' }], '   ')] }))).toEqual(['review.message_body_empty'])
		expect(codes(workspaceThread({ messages: [edited([{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'same' }], 'same')] }))).toEqual(['review.message_edit_noop'])
		expect(codes(workspaceThread({ messages: [edited([
			{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'v1' },
			{ id: SECOND_EDIT_ID, actor: AUTHOR, at: T2, previousBody: 'v1' },
		], 'v3')] }))).toEqual(['review.message_edit_noop'])
		// An unedited message may still have an empty body, as before.
		expect(validateReviewThread(workspaceThread({ messages: [{ id: MESSAGE_ID, actor: AUTHOR, at: T0, body: '' }] }), V3).ok).toBe(true)
	})
})

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'uiux.mjs')
const v2Manifest = { schemaVersion: 2, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }
const view = {
	id: VIEW_ID,
	name: 'Checkout',
	ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
	variants: {},
	spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
}
const v2Review = {
	id: REVIEW_ID,
	anchor: { viewId: VIEW_ID, widgetId: 'root' },
	variantNames: [],
	displayHint: { pin: { x: 0.25, y: 0.75 } },
	status: 'resolved',
	messages: [{ id: MESSAGE_ID, actor: AUTHOR, at: T0, body: 'Add a nav bar?' }],
	history: [{ id: EVENT_ID, kind: 'lifecycle', actor: AUTHOR, at: T1, from: 'open', to: 'resolved', resolution: 'answered' }],
	submissions: [],
}

async function seedV2Workspace(reviews: readonly Record<string, unknown>[] = [v2Review]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-v2-to-v3-'))
	roots.push(root)
	await mkdir(join(root, '.uiux'), { recursive: true })
	await mkdir(join(root, 'views'), { recursive: true })
	await mkdir(join(root, 'reviews'), { recursive: true })
	await writeFile(join(root, workspaceRelativePath()), `${JSON.stringify(v2Manifest, null, 2)}\n`)
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

describe('uiux.v2-to-v3 (manifest-only step)', () => {
	it('opens a v2 Workspace as migration_required and blocks every Review mutation, including the new ones', async () => {
		const root = await seedV2Workspace()
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect((await persistence.inspectWorkspace()).inspection).toMatchObject({ state: 'migration_required', version: 2, targetVersion: CURRENT_WORKSPACE_SCHEMA_VERSION })
		expect((await persistence.reviews.readInspected(REVIEW_ID))?.diagnostics).toEqual([])
		const { createWorkspaceApplicationSession } = await import('../src/application/services/workspace-session')
		const app = createWorkspaceApplicationSession(persistence)
		const revision = (await persistence.reviews.readRevision(REVIEW_ID))!
		expect(await app.editReviewMessage({ reviewId: REVIEW_ID, expectedRevision: revision, messageId: MESSAGE_ID, body: 'x', actor: AUTHOR }))
			.toMatchObject({ status: 'blocked', code: 'workspace.migration_required' })
		expect(await app.retractReviewThread({ reviewId: REVIEW_ID, expectedRevision: revision, actor: AUTHOR }))
			.toMatchObject({ status: 'blocked', code: 'workspace.migration_required' })
		expect(await app.createReviewThread({ anchor: { scope: 'workspace' } })).toMatchObject({ status: 'blocked', code: 'workspace.migration_required' })
	})

	it('plans a dry run that changes only the manifest and writes nothing', async () => {
		const root = await seedV2Workspace()
		const before = await snapshot(root)
		const plan = await new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).planWorkspaceMigration()
		expect(plan).toMatchObject({ fromVersion: 2, version: 4, steps: ['uiux.v2-to-v3', 'uiux.v3-to-v4'], changedFiles: ['.uiux/workspace.json'] })
		expect(await snapshot(root)).toEqual(before)
	})

	it('bumps only the manifest, leaves every Review byte-identical, and is idempotent', async () => {
		const root = await seedV2Workspace()
		const before = await snapshot(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const result = await persistence.migrateWorkspace()
		expect(result).toMatchObject({ fromVersion: 2, version: 4, steps: ['uiux.v2-to-v3', 'uiux.v3-to-v4'], changedFiles: ['.uiux/workspace.json'] })
		const after = await snapshot(root)
		expect(JSON.parse(after['.uiux/workspace.json']!)).toEqual({ ...v2Manifest, schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION })
		for (const path of Object.keys(before).filter(path => path !== '.uiux/workspace.json')) expect(after[path]).toBe(before[path])
		expect((await persistence.reviews.readInspected(REVIEW_ID))?.diagnostics).toEqual([])
		expect(await persistence.migrateWorkspace()).toMatchObject({ version: CURRENT_WORKSPACE_SCHEMA_VERSION, steps: [], changedFiles: [], revision: result.revision })
		expect(await snapshot(root)).toEqual(after)
		const second = await seedV2Workspace()
		expect((await new FileNativePersistence({ root: second, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).migrateWorkspace()).revision).toBe(result.revision)
	})

	it('never repairs v3-only content smuggled into a v2 file, and carries the v2 diagnostics through', async () => {
		const smuggled = { ...v2Review, id: '77777777-7777-4777-8777-777777777777', anchor: { scope: 'workspace' }, displayHint: undefined, messages: [{ ...v2Review.messages[0], edits: [{ id: EDIT_ID, actor: AUTHOR, at: T1, previousBody: 'x' }] }] }
		const root = await seedV2Workspace([v2Review, smuggled])
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect((await persistence.reviews.readInspected(smuggled.id))?.diagnostics.map(item => item.code)).toContain('schema.unknown_field')
		const bytes = await readFile(join(root, reviewRelativePath(smuggled.id)), 'utf8')
		const result = await persistence.migrateWorkspace()
		expect(result.changedFiles).toEqual(['.uiux/workspace.json'])
		expect(await readFile(join(root, reviewRelativePath(smuggled.id)), 'utf8')).toBe(bytes)
	})

	it('refuses to apply to anything but a v2 manifest and leaves unparseable Reviews to persistence', () => {
		const manifest = (version: number) => new Map([[workspaceRelativePath(), new TextEncoder().encode(JSON.stringify({ ...v2Manifest, schemaVersion: version }))]])
		expect(() => WORKSPACE_V2_TO_V3_STEP.apply(manifest(1))).toThrow(/schemaVersion 2/)
		expect(() => WORKSPACE_V2_TO_V3_STEP.apply(manifest(3))).toThrow(/schemaVersion 2/)
		expect(() => WORKSPACE_V2_TO_V3_STEP.apply(new Map())).toThrow(/workspace\.json/)
		const withBroken = manifest(2)
		withBroken.set('reviews/x.review.json', new TextEncoder().encode('{ not json'))
		const next = WORKSPACE_V2_TO_V3_STEP.apply(withBroken)
		expect(new TextDecoder().decode(next.get('reviews/x.review.json'))).toBe('{ not json')
	})

	it('runs through the CLI: dry run first, then the real run, then already current', async () => {
		const root = await seedV2Workspace()
		const before = await snapshot(root)
		const dryRun = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root, '--dry-run'], { encoding: 'utf8' })
		expect(dryRun.status).toBe(0)
		expect(dryRun.stdout).toContain('schemaVersion: 2 -> 4')
		expect(dryRun.stdout).toContain('steps: uiux.v2-to-v3, uiux.v3-to-v4')
		expect(dryRun.stdout).toContain('changedFiles (1):')
		expect(await snapshot(root)).toEqual(before)
		const real = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root], { encoding: 'utf8' })
		expect(real.status).toBe(0)
		expect(real.stdout).toContain('manifest revision:')
		const again = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root], { encoding: 'utf8' })
		expect(again.stdout).toContain(`already at schemaVersion ${CURRENT_WORKSPACE_SCHEMA_VERSION}`)
	})
})
