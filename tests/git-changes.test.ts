import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AccessDeniedError } from '../src/application/access/scoped-session'
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
		for (const [kind, key] of [['view', '../../etc/passwd'], ['view', 'not-a-uuid'], ['locale', '../x'], ['asset', '-x'], ['review', VIEW_ID], ['bogus', 'x']] as const)
			expect(await ctx.app.readChangeDiff({ kind, key }), `${kind}:${key}`).toMatchObject({ status: 'invalid' })
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
	it('refuses a member without workspace.read and a system credential, and serves a Viewer', async () => {
		const ctx = await fixture()
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
