import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { authorizeOperation } from '../src/application/access/policy'
import type { SystemPrincipal } from '../src/application/access/principal'
import { AccessDeniedError } from '../src/application/access/scoped-session'
import { parseCatFileBatch } from '../src/application/services/git-changes'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { FileNativePersistence } from '../src/persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { listChangesForHttp, readChangeBlobForHttp, readChangeDiffForHttp } from '../src/server/changes-http'
import { scoped, testMember } from './support/access'
import { commitAll, git, initGit, makeDirectoryOutsideGit } from './support/git'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * The read-only view of the changes since a Git base (Feature 01a1ece7-8d4e-763c-8897-2c35ef129a4d),
 * checked against its Rules and Scenarios (01a1ece9-a069, 01a1ece9-a13b, 01a1ece9-a20a, 01a1ece9-a2d8):
 * the default base is HEAD against the working tree, a toggle moves it to the merge base with the
 * default branch, the toggle is unavailable without a default branch, git that cannot supply the
 * base is reported, and the view stores nothing and writes nothing.
 */
const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VIEW_ID = '22222222-2222-4222-8222-222222222222'
const ASSET_ID = '33333333-3333-4333-8333-333333333333'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const FLOW_ID = '55555555-5555-4555-8555-555555555555'
const STEP_ID = '66666666-6666-4666-8666-666666666666'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64')
const PNG_V2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]).toString('base64')

const cleanup: string[] = []
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function spec(intent: string) {
	return { intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
}

type Fixture = Readonly<{ repo: string; root: string; app: WorkspaceApplicationSession; persistence: FileNativePersistence }>

/** A Git repository on `main` whose `.uiux/` is a Workspace holding a View, a Locale and an Asset, all committed. */
async function fixture(options: Readonly<{ branch?: string; commit?: boolean }> = {}): Promise<Fixture> {
	const repo = await realpath(await mkdtemp(join(tmpdir(), 'uiux-git-changes-')))
	cleanup.push(repo)
	initGit(repo, options.branch ?? 'main')
	const root = join(repo, '.uiux')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence)
	await persistence.locales.create('en-US', { greeting: 'Hello' })
	const app = createWorkspaceApplicationSession(persistence)
	expect(await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })).toMatchObject({ status: 'created' })
	expect(await app.createAsset({ id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png', contentBase64: PNG })).toMatchObject({ status: 'created' })
	if (options.commit !== false) commitAll(repo, 'initial')
	return { repo, root, app, persistence }
}

async function rename(ctx: Fixture, name: string): Promise<void> {
	const read = await ctx.persistence.views.read(VIEW_ID)
	expect(await ctx.app.updateViewMetadata({ key: VIEW_ID, expectedRevision: read!.revision, name })).toMatchObject({ status: 'updated' })
}

/** Every file under `directory` with its bytes and modification time, so any write at all shows. */
async function snapshot(directory: string): Promise<Record<string, string>> {
	const entries: Record<string, string> = {}
	for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name)
		const info = await stat(path)
		entries[path.slice(directory.length)] = entry.isDirectory() ? 'dir' : `${info.mtimeMs}:${(await readFile(path)).toString('base64')}`
	}
	return entries
}

describe('the changes view lists what changed since the Git base (Rules 01a1ece7-8e23, 01a1ece7-8f2f and 01a1ece7-8fe1)', () => {
	it('compares the working tree with HEAD by default, so an uncommitted edit, an added resource and a removed one are listed', async () => {
		const ctx = await fixture()
		// Nothing changed yet: nothing listed.
		expect(await ctx.app.listChanges({})).toMatchObject({ status: 'listed', base: { base: 'head' }, changes: [] })

		await rename(ctx, 'Pay')
		expect(await ctx.app.createView({ id: OTHER_VIEW_ID, name: 'Receipt', spec: spec('Receipt') })).toMatchObject({ status: 'created' })
		await rm(join(ctx.root, 'i18n', 'en-US.json'))
		const listed = await ctx.app.listChanges({})
		expect(listed).toMatchObject({ status: 'listed', base: { base: 'head' } })
		expect((listed as unknown as { changes: unknown[] }).changes).toEqual([
			{ kind: 'locale', key: 'en-US', status: 'removed' },
			{ kind: 'view', key: VIEW_ID, status: 'modified' },
			{ kind: 'view', key: OTHER_VIEW_ID, status: 'added' },
		])
	})

	it('shows the edit of a listed resource as semantic differences from the View as committed at HEAD', async () => {
		const ctx = await fixture()
		await rename(ctx, 'Pay')
		const diff = await ctx.app.readChangeDiff({ kind: 'view', key: VIEW_ID })
		expect(diff).toMatchObject({ status: 'compared', kind: 'view', key: VIEW_ID, changeStatus: 'modified', diff: { type: 'view', name: { before: 'Checkout', after: 'Pay' } } })
	})

	it('diffs an added resource against nothing and a removed one against nothing', async () => {
		const ctx = await fixture()
		await rm(join(ctx.root, 'i18n', 'en-US.json'))
		await ctx.persistence.locales.create('fr-FR', { greeting: 'Bonjour' })
		expect(await ctx.app.readChangeDiff({ kind: 'locale', key: 'en-US' })).toMatchObject({ status: 'compared', changeStatus: 'removed', diff: { type: 'locale' } })
		expect(await ctx.app.readChangeDiff({ kind: 'locale', key: 'fr-FR' })).toMatchObject({ status: 'compared', changeStatus: 'added', diff: { type: 'locale' } })
		expect(await ctx.app.readChangeDiff({ kind: 'locale', key: 'de-DE' })).toMatchObject({ status: 'not_found' })
	})

	it('lists every kind of canonical resource: Workspace settings, Product Kit, Access presets, Locale, View, Flow, Asset and Review thread (Rule 01a1ece7-8e23)', async () => {
		const ctx = await fixture({ commit: false })
		expect(await ctx.app.createFlow({ id: FLOW_ID, name: 'Pay flow', entryStepId: STEP_ID, steps: { [STEP_ID]: { target: { viewId: VIEW_ID }, transitions: [] } } })).toMatchObject({ status: 'created' })
		commitAll(ctx.repo, 'initial with a Flow')
		// Touch each file in the working tree: the view lists what differs from Git, whoever wrote it.
		for (const path of ['access-presets.json', 'product-kit.json', 'workspace.json', 'i18n/en-US.json', `views/${VIEW_ID}.view.json`, `flows/${FLOW_ID}.flow.json`, `assets/${ASSET_ID}/asset.json`])
			await writeFile(join(ctx.root, path), `${(await readFile(join(ctx.root, path), 'utf8')).trimEnd()}\n\n`)
		expect(await ctx.app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })).toMatchObject({ status: 'created' })
		const listed = await ctx.app.listChanges({}) as unknown as { changes: { kind: string; key: string; status: string }[] }
		expect(listed.changes.map(change => `${change.kind}:${change.status}`)).toEqual([
			'access-presets:modified',
			'asset:modified',
			'flow:modified',
			'locale:modified',
			'product-kit:modified',
			'review:added',
			'view:modified',
			'workspace:modified',
		])
	})

	it('shows a Review thread added, changed or removed since the base, with its structural difference', async () => {
		const ctx = await fixture()
		expect(await ctx.app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })).toMatchObject({ status: 'created' })
		expect(await ctx.app.listChanges({})).toMatchObject({ changes: [{ kind: 'review', key: REVIEW_ID, status: 'added' }] })
		expect(await ctx.app.readChangeDiff({ kind: 'review', key: REVIEW_ID })).toMatchObject({ status: 'compared', changeStatus: 'added', diff: { type: 'structural' } })
		commitAll(ctx.repo, 'with a thread')
		const file = join(ctx.root, 'reviews', `${REVIEW_ID}.review.json`)
		const thread = JSON.parse(await readFile(file, 'utf8')) as { messages: unknown[] }
		await writeFile(file, `${JSON.stringify({ ...thread, displayHint: { pin: { x: 0.5, y: 0.5 } } }, null, 2)}\n`)
		expect(await ctx.app.listChanges({})).toMatchObject({ changes: [{ kind: 'review', key: REVIEW_ID, status: 'modified' }] })
		const diff = await ctx.app.readChangeDiff({ kind: 'review', key: REVIEW_ID })
		expect(diff).toMatchObject({ status: 'compared', changeStatus: 'modified', diff: { type: 'structural' } })
		expect((diff as unknown as { diff: { changes: unknown[] } }).diff.changes.length).toBeGreaterThan(0)
		await rm(file)
		expect(await ctx.app.listChanges({})).toMatchObject({ changes: [{ kind: 'review', key: REVIEW_ID, status: 'removed' }] })
	})

	it('shows an Asset whose content changed with its image before (read from Git by digest) and after', async () => {
		const ctx = await fixture()
		const before = await ctx.persistence.assets.read(ASSET_ID)
		const replaced = await ctx.app.replaceAsset({ assetId: ASSET_ID, expectedRevision: before!.revision, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png', contentBase64: PNG_V2 })
		expect(replaced, JSON.stringify(replaced)).toMatchObject({ status: 'updated' })
		const diff = await ctx.app.readChangeDiff({ kind: 'asset', key: ASSET_ID })
		expect(diff).toMatchObject({ status: 'compared', changeStatus: 'modified', diff: { type: 'asset', image: { before: { mediaType: 'image/png' }, after: { mediaType: 'image/png' } } } })
		const image = (diff as { diff: { image: { before: { digest: string } } } }).diff.image.before
		const blob = await ctx.app.readChangeBlob({ key: ASSET_ID, digest: image.digest })
		expect(blob).toMatchObject({ status: 'found' })
		expect(Buffer.from((blob as { bytes: Uint8Array }).bytes).toString('base64')).toBe(PNG)
		expect(await ctx.app.readChangeBlob({ key: ASSET_ID, digest: `sha256:${'0'.repeat(64)}` })).toMatchObject({ status: 'not_found' })
	})

	it('rejects a resource that is not a canonical resource of the Workspace, and never passes it to git', async () => {
		const ctx = await fixture()
		for (const [kind, key] of [['view', '../../etc/passwd'], ['view', 'not-a-uuid'], ['locale', '../x'], ['asset', '-x'], ['review', 'not-a-uuid'], ['review', '../x'], ['bogus', 'x']] as const)
			expect(await ctx.app.readChangeDiff({ kind, key }), `${kind}:${key}`).toMatchObject({ status: 'invalid' })
		expect(await ctx.app.readChangeDiff({ kind: 'review', key: REVIEW_ID })).toMatchObject({ status: 'not_found' })
		expect(await ctx.app.readChangeBlob({ key: '../x', digest: `sha256:${'0'.repeat(64)}` })).toMatchObject({ status: 'invalid' })
		expect(await ctx.app.readChangeBlob({ key: ASSET_ID, digest: 'sha256:short' })).toMatchObject({ status: 'invalid' })
	})
})

describe('the toggle moves the base to the merge base with the default branch (Rules 01a1ece7-907a and 01a1ece7-9239)', () => {
	it('lists a change committed on the branch only against the merge base, with nothing uncommitted', async () => {
		const ctx = await fixture()
		git(ctx.repo, 'switch', '-q', '-c', 'feature')
		await rename(ctx, 'Pay')
		commitAll(ctx.repo, 'rename on the branch')
		const head = await ctx.app.listChanges({})
		expect(head).toMatchObject({ status: 'listed', base: { base: 'head' }, mergeBase: { available: true, defaultBranch: 'main' }, changes: [] })
		const merged = await ctx.app.listChanges({ base: 'merge-base' })
		expect(merged).toMatchObject({ status: 'listed', base: { base: 'merge-base' }, changes: [{ kind: 'view', key: VIEW_ID, status: 'modified' }] })
		// The merge base is the commit of the default branch the branch left, not HEAD.
		expect((merged as { base: { commit: string } }).base.commit).toBe(git(ctx.repo, 'rev-parse', 'main').trim().slice(0, 12))
		expect(await ctx.app.readChangeDiff({ base: 'merge-base', kind: 'view', key: VIEW_ID })).toMatchObject({ status: 'compared', diff: { name: { before: 'Checkout', after: 'Pay' } } })
		// The current content stays the working tree: an uncommitted edit is listed on top.
		await rename(ctx, 'Pay now')
		expect(await ctx.app.readChangeDiff({ base: 'merge-base', kind: 'view', key: VIEW_ID })).toMatchObject({ diff: { name: { before: 'Checkout', after: 'Pay now' } } })
	})

	it('makes the toggle unavailable when no default branch can be determined, and keeps HEAD as the base', async () => {
		const ctx = await fixture({ branch: 'trunk-less' })
		await rename(ctx, 'Pay')
		const listed = await ctx.app.listChanges({ base: 'merge-base' })
		expect(listed).toMatchObject({ status: 'listed', base: { base: 'head' }, mergeBase: { available: false }, changes: [{ kind: 'view', key: VIEW_ID, status: 'modified' }] })
		expect((listed as { mergeBase: { defaultBranch?: string } }).mergeBase.defaultBranch).toBeUndefined()
	})

	it('finds the default branch through origin/HEAD, even when it is not main or master', async () => {
		const ctx = await fixture({ branch: 'develop' })
		git(ctx.repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD')
		git(ctx.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
		expect(await ctx.app.listChanges({})).toMatchObject({ mergeBase: { available: true, defaultBranch: 'develop' } })
	})
})

describe('when git cannot supply the base the view says so and lists nothing (Rule 01a1ece7-92cf)', () => {
	it('reports a repository without a commit', async () => {
		const ctx = await fixture({ commit: false })
		expect(await ctx.app.listChanges({})).toMatchObject({ status: 'unavailable', code: 'git.no_commit', mergeBase: { available: false } })
		expect(await ctx.app.readChangeDiff({ kind: 'view', key: VIEW_ID })).toMatchObject({ status: 'unavailable', code: 'git.no_commit' })
	})

	it('reports a Workspace outside any Git work tree, and the rest of the application keeps working', async () => {
		const directory = await makeDirectoryOutsideGit('uiux-git-changes-outside-')
		cleanup.push(directory)
		const persistence = new FileNativePersistence({ root: join(directory, 'ws'), schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await createCurrentWorkspace(persistence)
		const app = createWorkspaceApplicationSession(persistence)
		expect(await app.listChanges({})).toMatchObject({ status: 'unavailable', code: 'git.unavailable' })
		expect(await app.createView({ id: VIEW_ID, name: 'Still works', spec: spec('x') })).toMatchObject({ status: 'created' })
	})

	it('reports git that cannot be run', async () => {
		const ctx = await fixture()
		const path = process.env.PATH
		process.env.PATH = join(ctx.repo, 'no-such-directory')
		try {
			const listed = await ctx.app.listChanges({})
			expect(listed).toMatchObject({ status: 'unavailable', code: 'git.unavailable', message: expect.stringContaining('git cannot be run') })
			expect((listed as { changes?: unknown }).changes).toBeUndefined()
		}
		finally {
			process.env.PATH = path
		}
		expect(await ctx.app.listChanges({})).toMatchObject({ status: 'listed' })
	})

	it('answers the HTTP read with status 200 and unavailable for the list, and 503 for a diff', async () => {
		const ctx = await fixture({ commit: false })
		const session = scoped(ctx.app, testMember({ preset: 'viewer', kind: 'human', credential: 'session' }))
		expect(await listChangesForHttp(session, {})).toMatchObject({ status: 200, body: { status: 'unavailable' }, headers: { 'Cache-Control': 'no-store' } })
		expect(await readChangeDiffForHttp(session, { kind: 'view', key: VIEW_ID })).toMatchObject({ status: 503 })
	})
})

describe('the changes view stores nothing and writes nothing (Rules 01a1ece7-910f and 01a1ece7-91a3, Scenario 01a1ece9-a2d8)', () => {
	it('leaves every file of the repository, .git included, and the home directory exactly as they were', async () => {
		const ctx = await fixture()
		await rename(ctx, 'Pay')
		await ctx.persistence.locales.create('fr-FR', { greeting: 'Bonjour' })
		git(ctx.repo, 'switch', '-q', '-c', 'feature')
		const before = await snapshot(ctx.repo)
		const home = process.env.UIUX_HOME!
		const homeBefore = await readdir(home).catch(() => [])
		for (const base of [undefined, 'merge-base', 'head', 'merge-base'] as const) {
			await ctx.app.listChanges(base ? { base } : {})
			await ctx.app.readChangeDiff({ ...(base ? { base } : {}), kind: 'view', key: VIEW_ID })
			await ctx.app.readChangeDiff({ ...(base ? { base } : {}), kind: 'locale', key: 'fr-FR' })
		}
		expect(await snapshot(ctx.repo)).toEqual(before)
		expect(await readdir(home).catch(() => [])).toEqual(homeBefore)
	})

	it('offers no write: the routes are reads, and the scoped session has no restore or revert', async () => {
		const ctx = await fixture()
		const session = scoped(ctx.app, testMember({ preset: 'owner', kind: 'human', credential: 'session' })) as unknown as Record<string, unknown>
		for (const name of ['restoreResourceVersion', 'revertChange', 'restoreChange', 'createCheckpoint']) expect(session[name], name).toBeUndefined()
	})
})

describe('the changes view needs only the key to read the Workspace', () => {
	it('refuses a member without workspace.read and the system credential, and serves a Viewer', async () => {
		const ctx = await fixture()
		// The system credential is allowlisted for a few operations (Clause 01a11c09-a3bb), none of them these reads.
		const system: SystemPrincipal = { type: 'system', id: 'system:capture', credential: 'system' }
		for (const operation of ['listChanges', 'readChangeDiff', 'readChangeBlob'] as const)
			expect(authorizeOperation(system, operation), operation).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['workspace.read'] })
		const none = scoped(ctx.app, testMember({ keys: ['views.write'], kind: 'human', credential: 'session' }))
		await expect(none.listChanges({})).rejects.toBeInstanceOf(AccessDeniedError)
		await expect(none.readChangeDiff({ kind: 'view', key: VIEW_ID })).rejects.toBeInstanceOf(AccessDeniedError)
		await expect(none.readChangeBlob({ key: ASSET_ID, digest: `sha256:${'0'.repeat(64)}` })).rejects.toBeInstanceOf(AccessDeniedError)
		const viewer = scoped(ctx.app, testMember({ preset: 'viewer', kind: 'agent', credential: 'token' }))
		expect(await viewer.listChanges({})).toMatchObject({ status: 'listed' })
		const blob = await readChangeBlobForHttp(viewer, { key: ASSET_ID, digest: `sha256:${'0'.repeat(64)}` })
		expect(blob).toMatchObject({ status: 404 })
	})

	it('validates the query of each route', async () => {
		const ctx = await fixture()
		const viewer = scoped(ctx.app, testMember({ preset: 'viewer', kind: 'human', credential: 'session' }))
		expect(await listChangesForHttp(viewer, { base: 'main' })).toMatchObject({ status: 400 })
		expect(await listChangesForHttp(viewer, { other: '1' })).toMatchObject({ status: 400 })
		expect(await readChangeDiffForHttp(viewer, { kind: 'view' })).toMatchObject({ status: 400 })
		expect(await readChangeDiffForHttp(viewer, { kind: 'view', key: 'nope' })).toMatchObject({ status: 400 })
	})
})

describe('the answers of git cat-file --batch', () => {
	const oid = 'a'.repeat(40)
	const answer = (type: string, body: string) => `${oid} ${type} ${Buffer.byteLength(body)}\n${body}\n`

	it('skips the body of an answer by its size whatever the type, so an object that is not a blob cannot misalign the next answer', () => {
		const tree = `first line\n100644 blob ${oid}\tx\n`
		const stream = Buffer.from(answer('tree', tree) + answer('blob', 'JSON') + 'views/gone missing\n' + answer('commit', `tree ${oid}\n`) + answer('blob', 'last'))
		const read = parseCatFileBatch(stream, ['a/tree', 'b/blob', 'c/missing', 'd/commit', 'e/blob'])
		expect([...read.keys()]).toEqual(['a/tree', 'b/blob', 'c/missing', 'd/commit', 'e/blob'])
		expect(read.get('a/tree')).toBeUndefined()
		expect(Buffer.from(read.get('b/blob')!).toString()).toBe('JSON')
		expect(read.get('c/missing')).toBeUndefined()
		expect(read.get('d/commit')).toBeUndefined()
		expect(Buffer.from(read.get('e/blob')!).toString()).toBe('last')
	})

	it('reads a blob whose own bytes hold line breaks and header-like lines', () => {
		const body = `${oid} blob 3\nabc`
		const read = parseCatFileBatch(Buffer.from(answer('blob', body) + answer('blob', 'next')), ['x', 'y'])
		expect(Buffer.from(read.get('x')!).toString()).toBe(body)
		expect(Buffer.from(read.get('y')!).toString()).toBe('next')
	})
})

describe('a Workspace root below the repository top level', () => {
	it('reads the base through the root\'s prefix, and ignores a change outside the Workspace', async () => {
		const repo = await realpath(await mkdtemp(join(tmpdir(), 'uiux-git-changes-nested-')))
		cleanup.push(repo)
		initGit(repo)
		const root = join(repo, 'packages', 'design', '.uiux')
		await mkdir(root, { recursive: true })
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await createCurrentWorkspace(persistence)
		const app = createWorkspaceApplicationSession(persistence)
		expect(await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })).toMatchObject({ status: 'created' })
		await writeFile(join(repo, 'README.md'), 'one\n')
		commitAll(repo, 'initial')
		const read = await persistence.views.read(VIEW_ID)
		await app.updateViewMetadata({ key: VIEW_ID, expectedRevision: read!.revision, name: 'Pay' })
		await writeFile(join(repo, 'README.md'), 'two\n')
		expect(await app.listChanges({})).toMatchObject({ status: 'listed', changes: [{ kind: 'view', key: VIEW_ID, status: 'modified' }] })
		expect(await app.readChangeDiff({ kind: 'view', key: VIEW_ID })).toMatchObject({ status: 'compared', diff: { name: { before: 'Checkout', after: 'Pay' } } })
	})
})
