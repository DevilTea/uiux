import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runAccessCommand } from '../src/cli/access'
import { runMigrateCommand } from '../src/cli/migrate'
import type { HostVersionRecord } from '../src/domain/history/schema'
import { emptyProductKit } from '../src/domain/product-kit/schema'
import { canonicalJsonBytes, FileNativePersistence, upgradeSnapshotInMemory, type PersistenceFaultPoint } from '../src/persistence/file-native'
import { HostHistoryStore } from '../src/persistence/history/host-store'
import { LEGACY_LAYOUT, V5_LAYOUT } from '../src/persistence/paths'
import { defineWorkspaceSchemaPolicy } from '../src/persistence/schema-policy'
import { acquireServerHold } from '../src/persistence/server-hold'
import { checkWorkspaceSelection, isRelocatedSourceOf } from '../src/persistence/workspace-selection'
import {
	CURRENT_WORKSPACE_SCHEMA_VERSION,
	placeV4AdapterSpecifier,
	PRODUCT_WORKSPACE_SCHEMA_POLICY,
	WORKSPACE_GITIGNORE_RULES,
	WORKSPACE_V4_TO_V5_STEP,
	WORKSPACE_V4_TO_V5_STEP_ID,
} from '../src/product/workspace-schema'
import { verifyCredential } from '../src/server/access/roster'
import { AccessStore, hostHistoryPaths } from '../src/server/access/store'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'
import { V4_TEST_SCHEMA_POLICY, V5_TEST_SCHEMA_POLICY } from './support/workspace-layout'

/**
 * The `uiux.v4-to-v5` relocation (issue #141, units K4 and K6): Clause 01a11bb1-8f5f-77ea-817b-46679c5a6475,
 * Rules 01a11bb1-95f2-…, 01a11bb1-9658-…, 01a12626-6a4f-…, 01a11bb1-96bb-… and 01a12626-5a0c-…, Clauses
 * 01a1144e-5605-…, 01a12626-e5c9-…, 01a12626-e8fe-… and 01a1144e-56bd-…. The runs use
 * `V5_TEST_SCHEMA_POLICY`, which is UIUX's own policy now that schemaVersion 5 is current.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const REVIEW_ID = '22222222-2222-4222-8222-222222222222'
const ASSET_ID = '55555555-5555-4555-8555-555555555555'
const SUBMISSION_ID = '44444444-4444-4444-8444-444444444444'
const ARTIFACT_HEX = 'ab'.repeat(32)
const TIME = '2026-10-04T06:35:53.025Z'
const LATER = '2026-10-04T06:36:02.699Z'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	roots.push(directory)
	return directory
}

const view = {
	id: VIEW_ID,
	name: 'Checkout',
	ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
	variants: {},
	spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
}

/** A Review that `uiux.v1-to-v2` rewrites (a resolve without a resolution), so a chained run changes a data file. */
function v1ResolvedReview() {
	return {
		id: REVIEW_ID,
		anchor: { viewId: VIEW_ID, widgetId: 'root' },
		variantNames: [],
		status: 'resolved',
		messages: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', actor: { type: 'human' }, at: TIME, body: 'Add a nav bar?' }],
		submissions: [{
			id: SUBMISSION_ID, actor: { type: 'agent' }, at: TIME, changeDomains: ['view-structure'],
			resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: 'r_1' }], scope: {},
			evidenceRefs: [{ kind: 'screenshot', evidence: `sha256:${'c'.repeat(64)}` }],
		}],
		history: [
			{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'lifecycle', from: 'open', to: 'ready-for-review', actor: { type: 'agent' }, at: TIME, submissionId: SUBMISSION_ID },
			{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'lifecycle', from: 'ready-for-review', to: 'resolved', actor: { type: 'human', displayName: 'Reviewer' }, at: LATER, submissionId: SUBMISSION_ID },
		],
	}
}

type Seed = Readonly<{ version?: number; adapters?: readonly { moduleSpecifier: string; config?: unknown }[]; kitPackage?: unknown }>

/**
 * An old-layout Workspace `<parent>/design` at `schemaVersion` 4 (or `version`), with every data
 * directory, an artifact, a kit module under `.uiux/kit/`, and files outside the Workspace data
 * (`adapters/`, `package.json`) that the relocation must leave alone.
 */
async function seedOldLayout(seed: Seed = {}): Promise<string> {
	const parent = await makeDirectory('uiux-relocation-')
	const root = join(parent, 'design')
	const version = seed.version ?? 4
	const adapters = seed.adapters ?? [{ moduleSpecifier: './.uiux/kit/adapters/reference.ts', config: { density: 'compact' } }, { moduleSpecifier: '@acme/uiux-adapter' }]
	await mkdir(join(root, '.uiux', 'kit', 'adapters'), { recursive: true })
	await mkdir(join(root, '.uiux', 'artifacts', 'sha256', 'ab'), { recursive: true })
	await mkdir(join(root, 'views'), { recursive: true })
	await mkdir(join(root, 'flows'), { recursive: true })
	await mkdir(join(root, 'reviews'), { recursive: true })
	await mkdir(join(root, 'i18n'), { recursive: true })
	await mkdir(join(root, 'assets', ASSET_ID), { recursive: true })
	await mkdir(join(root, 'adapters'), { recursive: true })
	await writeFile(join(root, '.uiux', 'workspace.json'), `${JSON.stringify({ schemaVersion: version, i18n: { defaultLocale: 'en-US' }, adapters, viewports: {}, themes: {} }, null, 2)}\n`)
	await writeFile(join(root, '.uiux', 'kit', 'adapters', 'reference.ts'), 'export default {}\n')
	const kitPackage = seed.kitPackage === undefined ? { name: 'kit', dependencies: { '@acme/uiux-adapter': '1.0.0' } } : seed.kitPackage
	if (kitPackage !== null) await writeFile(join(root, '.uiux', 'kit', 'package.json'), typeof kitPackage === 'string' ? kitPackage : `${JSON.stringify(kitPackage)}\n`)
	await writeFile(join(root, '.uiux', 'artifacts', 'sha256', 'ab', ARTIFACT_HEX), 'artifact bytes')
	await writeFile(join(root, 'views', `${VIEW_ID}.view.json`), `${JSON.stringify(view)}\n`)
	const review = version === 1 ? v1ResolvedReview() : { ...v1ResolvedReview(), history: v1ResolvedReview().history.map((entry, index) => index === 1 ? { ...entry, resolution: 'verified' } : entry) }
	await writeFile(join(root, 'reviews', `${REVIEW_ID}.review.json`), `${JSON.stringify(review)}\n`)
	await writeFile(join(root, 'i18n', 'en-US.json'), '{"app.title":"Checkout"}\n')
	await writeFile(join(root, 'assets', ASSET_ID, 'asset.json'), `${JSON.stringify({ id: ASSET_ID, name: 'icon', contentFilename: 'icon.svg', mediaType: 'image/svg+xml' })}\n`)
	await writeFile(join(root, 'assets', ASSET_ID, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
	await writeFile(join(root, 'adapters', 'other.ts'), 'export default {}\n')
	await writeFile(join(root, 'package.json'), '{"name":"product"}\n')
	return root
}

/** Every file and directory under `root`, with each file's bytes; runtime lock files are left out. */
async function tree(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {}
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')
		if (/(?:^|\/)\.persistence(?:\.lock|-lock-)/u.test(path)) continue
		if (entry.isDirectory()) files[`${path}/`] = ''
		else if (entry.isSymbolicLink()) files[path] = 'symbolic link'
		else files[path] = (await readFile(join(root, path))).toString('base64')
	}
	return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)))
}

/** `tree` without the transaction directory, which a recovered Workspace may keep empty. */
async function canonicalTree(root: string): Promise<Record<string, string>> {
	return Object.fromEntries(Object.entries(await tree(root)).filter(([path]) => !path.includes('.transactions/')))
}

function capture() {
	const out: string[] = []
	const err: string[] = []
	return { out, err, stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) }
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(() => true, () => false)
}

describe('uiux.v4-to-v5 on the logical snapshot', () => {
	it('is UIUX\'s last step: schemaVersion 5 is current and uiux.v4-to-v5 is registered in UIUX\'s own policy', () => {
		expect(CURRENT_WORKSPACE_SCHEMA_VERSION).toBe(5)
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.steps.map(step => step.id).at(-1)).toBe(WORKSPACE_V4_TO_V5_STEP_ID)
		expect(WORKSPACE_V4_TO_V5_STEP).toMatchObject({ id: 'uiux.v4-to-v5', fromVersion: 4, toVersion: 5 })
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.steps.at(-1)).toBe(WORKSPACE_V4_TO_V5_STEP)
	})

	it('moves the manifest without adapters, writes product-kit.json with rebased Adapters, and keeps every data path', async () => {
		const manifest = { schemaVersion: 4, i18n: { defaultLocale: 'en-US' }, adapters: [{ moduleSpecifier: './.uiux/kit/adapters/reference.ts', config: { density: 'compact' } }, { moduleSpecifier: '@acme/uiux-adapter' }], viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: {} }
		const viewBytes = canonicalJsonBytes(view)
		const snapshot = new Map<string, Uint8Array>([[LEGACY_LAYOUT.manifestPath, canonicalJsonBytes(manifest)], [`views/${VIEW_ID}.view.json`, viewBytes]])
		const next = await WORKSPACE_V4_TO_V5_STEP.apply(snapshot)
		expect([...next.keys()].sort()).toEqual(['product-kit.json', `views/${VIEW_ID}.view.json`, 'workspace.json'])
		expect(JSON.parse(new TextDecoder().decode(next.get('workspace.json')))).toEqual({ schemaVersion: 5, i18n: { defaultLocale: 'en-US' }, viewports: manifest.viewports, themes: {} })
		expect(JSON.parse(new TextDecoder().decode(next.get('product-kit.json')))).toEqual({ ...emptyProductKit(), adapters: [{ moduleSpecifier: './adapters/reference.ts', config: { density: 'compact' } }, { moduleSpecifier: '@acme/uiux-adapter' }] })
		expect(next.get(`views/${VIEW_ID}.view.json`)).toEqual(viewBytes)
		// Deterministic, and refused on its own output rather than applied twice.
		expect(await WORKSPACE_V4_TO_V5_STEP.apply(snapshot)).toEqual(next)
		expect(() => WORKSPACE_V4_TO_V5_STEP.apply(next)).toThrow(/requires \.uiux\/workspace\.json/u)
		expect(await WORKSPACE_V4_TO_V5_STEP.refuse!(snapshot, { readWorkspaceFile: async () => new TextEncoder().encode(JSON.stringify({ peerDependencies: { '@acme/uiux-adapter': '*' } })) })).toBeUndefined()
	})

	it('places each v4 specifier: rebased inside .uiux/kit/, and an exact replacement for the ones outside', () => {
		expect(placeV4AdapterSpecifier('@acme/uiux-adapter')).toEqual({ kind: 'bare', packageName: '@acme/uiux-adapter' })
		expect(placeV4AdapterSpecifier('lodash/fp/map.js')).toEqual({ kind: 'bare', packageName: 'lodash' })
		expect(placeV4AdapterSpecifier('#internal/adapter')).toEqual({ kind: 'bare' })
		expect(placeV4AdapterSpecifier('lodash/%2e%2e/other')).toEqual({ kind: 'bare' })
		expect(placeV4AdapterSpecifier('./.uiux/kit/adapters/reference.ts')).toEqual({ kind: 'kit', rebased: './adapters/reference.ts' })
		expect(placeV4AdapterSpecifier('./adapters/../.uiux/kit/index.ts')).toEqual({ kind: 'kit', rebased: './index.ts' })
		// Clause 01a12626-e5c9: `./<p>` -> `./.uiux/kit/<p>`, with `<p>` normalized relative to the old root.
		expect(placeV4AdapterSpecifier('./adapters/reference.ts')).toEqual({ kind: 'outside', replacement: './.uiux/kit/adapters/reference.ts', exact: true })
		expect(placeV4AdapterSpecifier('./adapters/./x/../reference.ts')).toEqual({ kind: 'outside', replacement: './.uiux/kit/adapters/reference.ts', exact: true })
		// The edge forms the Contract leaves to the step.
		expect(placeV4AdapterSpecifier('./.uiux/adapters/reference.ts')).toEqual({ kind: 'outside', replacement: './.uiux/kit/adapters/reference.ts', exact: true })
		expect(placeV4AdapterSpecifier('./.uiux/kit/../reference.ts')).toEqual({ kind: 'outside', replacement: './.uiux/kit/reference.ts', exact: true })
		expect(placeV4AdapterSpecifier('./node_modules/@acme/adapter/dist/index.js')).toEqual({ kind: 'outside', replacement: '@acme/adapter/dist/index.js', exact: true, packageName: '@acme/adapter' })
		// Owner ruling 2 of #139 c18858856: a ./ specifier in kit/node_modules/ gets its bare replacement.
		expect(placeV4AdapterSpecifier('./.uiux/kit/node_modules/@acme/adapter/index.js')).toEqual({ kind: 'outside', replacement: '@acme/adapter/index.js', exact: true, packageName: '@acme/adapter' })
		expect(placeV4AdapterSpecifier('./.uiux/kit/node_modules/.bin/adapter')).toEqual({ kind: 'outside', replacement: '<package>/<subpath>', exact: false })
		// The innermost node_modules/ names the package, in any case, as the v5 dependency guard reads it.
		expect(placeV4AdapterSpecifier('./node_modules/a/node_modules/@b/c/x.js')).toEqual({ kind: 'outside', replacement: '@b/c/x.js', exact: true, packageName: '@b/c' })
		expect(placeV4AdapterSpecifier('./.uiux/kit/Node_Modules/@acme/adapter/index.js')).toEqual({ kind: 'outside', replacement: '@acme/adapter/index.js', exact: true, packageName: '@acme/adapter' })
		// A bare subpath through node_modules/ names no package (src/adapters/kit-dependencies.ts).
		expect(placeV4AdapterSpecifier('lodash/node_modules/other/index.js')).toEqual({ kind: 'bare' })
		expect(placeV4AdapterSpecifier('./../shared/adapter.ts')).toEqual({ kind: 'outside', replacement: './.uiux/kit/adapter.ts', exact: false })
		expect(placeV4AdapterSpecifier('./.uiux/kit')).toMatchObject({ kind: 'outside', exact: false })
	})

	it('keeps an outside specifier unchanged in an in-memory upgrade of a recorded version, which never refuses', async () => {
		const manifest = { schemaVersion: 4, i18n: { defaultLocale: 'en-US' }, adapters: [{ moduleSpecifier: './adapters/reference.ts' }], viewports: {}, themes: {} }
		const upgraded = await upgradeSnapshotInMemory(new Map([[LEGACY_LAYOUT.manifestPath, canonicalJsonBytes(manifest)]]), 4, V5_TEST_SCHEMA_POLICY)
		expect(upgraded.steps).toEqual([WORKSPACE_V4_TO_V5_STEP_ID])
		expect(JSON.parse(new TextDecoder().decode(upgraded.snapshot.get('product-kit.json'))).adapters).toEqual([{ moduleSpecifier: './adapters/reference.ts' }])
	})
})

describe('uiux migrate relocates an old-layout Workspace in place', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('moves the data directories into .uiux/, keeps the manifest, artifact and kit paths, and leaves everything else alone', async () => {
		const root = await seedOldLayout()
		const before = await tree(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect(persistence.layout).toBe(LEGACY_LAYOUT)
		const result = await persistence.migrateWorkspace()
		const newRoot = join(root, '.uiux')
		expect(result).toMatchObject({ fromVersion: 4, version: 5, steps: [WORKSPACE_V4_TO_V5_STEP_ID], changedFiles: ['.uiux/product-kit.json', '.uiux/workspace.json'] })
		expect(result.relocation).toEqual({ root: newRoot, metadataDir: '.uiux', moved: ['views', 'flows', 'reviews', 'i18n', 'assets'] })

		const after = await tree(root)
		// Rule 01a11bb1-95f2: the manifest, artifacts and kit keep their physical paths.
		for (const path of ['.uiux/workspace.json', `.uiux/artifacts/sha256/ab/${ARTIFACT_HEX}`, '.uiux/kit/adapters/reference.ts', 'adapters/other.ts', 'package.json'])
			expect(path in after, path).toBe(true)
		expect(after[`.uiux/artifacts/sha256/ab/${ARTIFACT_HEX}`]).toBe(before[`.uiux/artifacts/sha256/ab/${ARTIFACT_HEX}`])
		expect(after['adapters/other.ts']).toBe(before['adapters/other.ts'])
		// Every data file moved byte-identical; nothing is left at the old root.
		for (const path of Object.keys(before).filter(path => /^(?:views|flows|reviews|i18n|assets)\//u.test(path))) {
			expect(after[`.uiux/${path}`], path).toBe(before[path])
			expect(path in after, path).toBe(false)
		}
		expect((await readdir(root)).sort()).toEqual(['.uiux', 'adapters', 'package.json'])
		expect(JSON.parse(await readFile(join(newRoot, 'workspace.json'), 'utf8'))).toEqual({ schemaVersion: 5, i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {} })
		expect(JSON.parse(await readFile(join(newRoot, 'product-kit.json'), 'utf8'))).toEqual({ ...emptyProductKit(), adapters: [{ moduleSpecifier: './adapters/reference.ts', config: { density: 'compact' } }, { moduleSpecifier: '@acme/uiux-adapter' }] })
		expect(await readdir(join(newRoot, '.transactions')).catch(() => [])).toEqual([])

		// The new root is a current schemaVersion 5 Workspace; the old root is refused as its parent.
		expect(checkWorkspaceSelection(newRoot, V5_TEST_SCHEMA_POLICY)).toEqual({ ok: true, layout: V5_LAYOUT })
		expect(checkWorkspaceSelection(root, V5_TEST_SCHEMA_POLICY)).toMatchObject({ ok: false, reason: 'relocated_parent' })
		const reopened = new FileNativePersistence({ root: newRoot, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect(reopened.layout).toBe(V5_LAYOUT)
		expect((await reopened.inspectWorkspace()).inspection).toMatchObject({ state: 'current', version: 5 })
		expect((await reopened.views.read(VIEW_ID))?.resource).toEqual(view)
		expect(await reopened.migrateWorkspace()).toMatchObject({ version: 5, steps: [], changedFiles: [] })
	})

	it('chains 1 -> 5: a data file an earlier step rewrites is written in its new place', async () => {
		const root = await seedOldLayout({ version: 1 })
		const result = await new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY }).migrateWorkspace()
		expect(result).toMatchObject({ fromVersion: 1, version: 5, steps: ['uiux.v1-to-v2', 'uiux.v2-to-v3', 'uiux.v3-to-v4', WORKSPACE_V4_TO_V5_STEP_ID] })
		expect(result.changedFiles).toEqual(['.uiux/product-kit.json', `.uiux/reviews/${REVIEW_ID}.review.json`, '.uiux/workspace.json'])
		const review = JSON.parse(await readFile(join(root, '.uiux', 'reviews', `${REVIEW_ID}.review.json`), 'utf8')) as ReturnType<typeof v1ResolvedReview>
		expect(review.history[1]).toMatchObject({ resolution: 'verified' })
		expect(await exists(join(root, 'reviews'))).toBe(false)
		const reopened = new FileNativePersistence({ root: join(root, '.uiux'), schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect((await reopened.reviews.readInspected(REVIEW_ID))?.diagnostics).toEqual([])
	})

	it('relocates a Workspace with no data directories yet', async () => {
		const parent = await makeDirectory('uiux-relocation-empty-')
		await mkdir(join(parent, '.uiux'))
		await writeFile(join(parent, '.uiux', 'workspace.json'), JSON.stringify({ schemaVersion: 4, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }))
		const result = await new FileNativePersistence({ root: parent, schemaPolicy: V5_TEST_SCHEMA_POLICY }).migrateWorkspace()
		expect(result.relocation?.moved).toEqual([])
		expect((await readdir(join(parent, '.uiux'))).filter(name => !name.startsWith('.persistence') && name !== '.transactions').sort()).toEqual(['product-kit.json', 'workspace.json'])
	})

	it('prints the dry-run plan without writing anything, then migrates, prints the new root, the copy command and the .gitignore rules, and writes no .gitignore', async () => {
		const root = await seedOldLayout()
		const home = join(await makeDirectory('uiux-relocation-home-'), 'home')
		const before = await tree(root)
		const dry = capture()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: true, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: dry.stdout, stderr: dry.stderr })).toBe(0)
		const plan = dry.out.join('\n')
		expect(plan).toContain('dry run, nothing written')
		expect(plan).toContain('schemaVersion: 4 -> 5')
		expect(plan).toContain(`steps: ${WORKSPACE_V4_TO_V5_STEP_ID}`)
		expect(plan).toContain('moved (5):\n    views/ -> .uiux/views/\n    flows/ -> .uiux/flows/\n    reviews/ -> .uiux/reviews/\n    i18n/ -> .uiux/i18n/\n    assets/ -> .uiux/assets/')
		expect(plan).toContain('changedFiles (2):\n    .uiux/product-kit.json\n    .uiux/workspace.json')
		expect(plan).toContain(`new Workspace root (after a real run): ${join(root, '.uiux')}`)
		expect(plan).not.toContain('access copy')
		expect(await tree(root)).toEqual(before)
		expect(await exists(home)).toBe(false)
		// Idempotent: a second dry run plans the same.
		const again = capture()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: true, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: again.stdout, stderr: again.stderr })).toBe(0)
		expect(again.out).toEqual(dry.out)

		const real = capture()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: real.stdout, stderr: real.stderr }), real.err.join('\n')).toBe(0)
		expect(real.err).toEqual([])
		const output = real.out.join('\n')
		expect(output).toContain(`Migrated UIUX Workspace ${root}`)
		expect(output).toContain(`new Workspace root: ${join(root, '.uiux')}`)
		expect(output).toContain(`    uiux access copy --from ${root} --workspace ${join(root, '.uiux')}`)
		expect(output).toContain(`Suggested .gitignore rules for ${join(root, '.uiux')} (uiux migrate writes no .gitignore):\n${WORKSPACE_GITIGNORE_RULES.map(rule => `    ${rule}`).join('\n')}`)
		expect(WORKSPACE_GITIGNORE_RULES).toEqual(['.server-hold.json', '.server-hold-*.tmp', '.persistence.lock', '.persistence-lock-*', '.transactions/', 'kit/node_modules/', 'kit/dist/'])
		expect(Object.keys(await tree(root)).filter(path => path.endsWith('.gitignore'))).toEqual([])

		// Re-runs: the old root is refused as the relocated parent; the new root is already current.
		const old = capture()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: old.stdout, stderr: old.stderr })).toBe(2)
		expect(old.err.join('\n')).toContain('select that directory instead')
		const current = capture()
		expect(await runMigrateCommand({ workspaceRoot: join(root, '.uiux'), dryRun: false, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: current.stdout, stderr: current.stderr })).toBe(0)
		expect(current.out.join('\n')).toContain('is already at schemaVersion 5; nothing to migrate.')
	})

	it('quotes a root with spaces in the printed copy command', async () => {
		const parent = await makeDirectory('uiux-relocation-quote-')
		const root = join(parent, 'my design')
		await mkdir(join(root, '.uiux'), { recursive: true })
		await writeFile(join(root, '.uiux', 'workspace.json'), JSON.stringify({ schemaVersion: 4, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }))
		const run = capture()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, home: join(parent, 'home'), schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: run.stdout, stderr: run.stderr })).toBe(0)
		expect(run.out.join('\n')).toContain(`uiux access copy --from '${root}' --workspace '${join(root, '.uiux')}'`)
	})
})

describe('uiux.v4-to-v5 refusals, before anything is written', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('lists every ./ Adapter outside .uiux/kit/ with its exact replacement, in a dry run and a real run, and writes nothing, not even the Checkpoint', async () => {
		const root = await seedOldLayout({ adapters: [
			{ moduleSpecifier: './adapters/reference.ts' },
			{ moduleSpecifier: '@acme/uiux-adapter' },
			{ moduleSpecifier: './.uiux/kit/adapters/kit.ts' },
			{ moduleSpecifier: './.uiux/adapters/legacy.ts' },
		] })
		const home = join(await makeDirectory('uiux-relocation-home-'), 'home')
		const before = await tree(root)
		for (const dryRun of [true, false]) {
			const run = capture()
			expect(await runMigrateCommand({ workspaceRoot: root, dryRun, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: run.stdout, stderr: run.stderr })).toBe(1)
			const errors = run.err.join('\n')
			expect(errors).toContain('uiux.v4-to-v5 refuses 2 Adapters that the relocated Workspace could not resolve, and nothing was written. Move each ./ module into .uiux/kit/. Edit each listed specifier in .uiux/workspace.json by hand as shown. Then run uiux migrate again.')
			expect(errors).toContain('/adapters/0/moduleSpecifier: ./adapters/reference.ts lies outside .uiux/kit/: replace it with ./.uiux/kit/adapters/reference.ts')
			expect(errors).toContain('/adapters/3/moduleSpecifier: ./.uiux/adapters/legacy.ts lies outside .uiux/kit/: replace it with ./.uiux/kit/adapters/legacy.ts')
			expect(errors).not.toContain('/adapters/1/')
			expect(errors).not.toContain('/adapters/2/')
			expect(errors).not.toContain('pre-migration Checkpoint')
			expect(await tree(root)).toEqual(before)
			expect(await exists(home)).toBe(false)
		}
	})

	it('no longer refuses once the module is moved into .uiux/kit/ and the specifier is edited by hand to the printed replacement (Rule 01a12626-6a4f)', async () => {
		const root = await seedOldLayout({ adapters: [{ moduleSpecifier: './adapters/other.ts' }] })
		const refused = capture()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: true, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: refused.stdout, stderr: refused.stderr })).toBe(1)
		const replacement = /replace it with (?<specifier>\S+)/u.exec(refused.err.join('\n'))?.groups?.specifier
		expect(replacement).toBe('./.uiux/kit/adapters/other.ts')
		await rename(join(root, 'adapters', 'other.ts'), join(root, '.uiux', 'kit', 'adapters', 'other.ts'))
		const manifestPath = join(root, '.uiux', 'workspace.json')
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
		await writeFile(manifestPath, JSON.stringify({ ...manifest, adapters: [{ moduleSpecifier: replacement }] }))
		const run = capture()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, home: join(root, '..', 'home'), schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: run.stdout, stderr: run.stderr }), run.err.join('\n')).toBe(0)
		expect(JSON.parse(await readFile(join(root, '.uiux', 'product-kit.json'), 'utf8')).adapters).toEqual([{ moduleSpecifier: './adapters/other.ts' }])
	})

	it('refuses a symbolic-linked data directory and never follows it out of the Workspace', async () => {
		const root = await seedOldLayout()
		const outside = await makeDirectory('uiux-relocation-outside-')
		await writeFile(join(outside, 'keep.txt'), 'outside')
		await rm(join(root, 'flows'), { recursive: true })
		await symlink(outside, join(root, 'flows'))
		const before = await tree(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		await expect(persistence.migrateWorkspace()).rejects.toMatchObject({ code: 'persistence.path_rejected' })
		expect(await tree(root)).toEqual(before)
		expect((await lstat(join(root, 'flows'))).isSymbolicLink()).toBe(true)
		expect(await readdir(outside)).toEqual(['keep.txt'])
	})

	it('refuses while a server holds the Workspace, at the old layout\'s hold path; a dry run still plans and notes the server', async () => {
		const root = await seedOldLayout()
		const before = await tree(root)
		const hold = (await acquireServerHold(root, { layout: LEGACY_LAYOUT }))!
		try {
			const real = capture()
			expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, home: join(root, '..', 'home'), schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: real.stdout, stderr: real.stderr })).toBe(1)
			expect(real.err.join('\n')).toContain(`a UIUX server (pid ${process.pid}`)
			const dry = capture()
			expect(await runMigrateCommand({ workspaceRoot: root, dryRun: true, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: dry.stdout, stderr: dry.stderr })).toBe(0)
			expect(dry.out.join('\n')).toContain('stop it before the real run')
			expect(Object.fromEntries(Object.entries(await tree(root)).filter(([path]) => !path.startsWith('.uiux/.server-hold')))).toEqual(before)
		}
		finally {
			await hold.release()
		}
	})
})

describe('uiux.v4-to-v5 refuses Adapters the kit project does not declare (owner ruling 2 of #139 c18858856)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	async function refusal(seed: Seed): Promise<Readonly<{ root: string; errors: string; before: Record<string, string>; home: string }>> {
		const root = await seedOldLayout(seed)
		const home = join(await makeDirectory('uiux-relocation-home-'), 'home')
		const before = await tree(root)
		let errors = ''
		for (const dryRun of [true, false]) {
			const run = capture()
			expect(await runMigrateCommand({ workspaceRoot: root, dryRun, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: run.stdout, stderr: run.stderr })).toBe(1)
			errors = run.err.join('\n')
			expect(await tree(root)).toEqual(before)
			expect(await exists(home)).toBe(false)
		}
		return { root, errors, before, home }
	}

	it('refuses a bare Adapter whose package kit/package.json does not declare, lists the packages to declare, and writes no package.json', async () => {
		const { root, errors } = await refusal({
			adapters: [{ moduleSpecifier: '@acme/uiux-adapter' }, { moduleSpecifier: 'lodash/fp.js' }, { moduleSpecifier: './.uiux/kit/adapters/reference.ts' }, { moduleSpecifier: '@acme/declared' }],
			kitPackage: { name: 'kit', devDependencies: { '@acme/declared': '1.0.0' } },
		})
		expect(errors).toContain('uiux.v4-to-v5 refuses 2 Adapters that the relocated Workspace could not resolve, and nothing was written. Declare @acme/uiux-adapter, lodash in .uiux/kit/package.json (dependencies, devDependencies, peerDependencies or optionalDependencies); uiux migrate writes no package.json. Then run uiux migrate again.')
		expect(errors).toContain('/adapters/0/moduleSpecifier: @acme/uiux-adapter names the package @acme/uiux-adapter, which .uiux/kit/package.json does not declare: declare it there')
		expect(errors).toContain('/adapters/1/moduleSpecifier: lodash/fp.js names the package lodash, which .uiux/kit/package.json does not declare: declare it there')
		expect(errors).not.toContain('/adapters/2/')
		expect(errors).not.toContain('/adapters/3/')
		expect(errors).not.toContain('pre-migration Checkpoint')
		expect(JSON.parse(await readFile(join(root, '.uiux', 'kit', 'package.json'), 'utf8'))).toEqual({ name: 'kit', devDependencies: { '@acme/declared': '1.0.0' } })
	})

	it('refuses every bare Adapter when the kit project has no package.json, and creates none', async () => {
		const { root, errors } = await refusal({ kitPackage: null })
		expect(errors).toContain('/adapters/1/moduleSpecifier: @acme/uiux-adapter names the package @acme/uiux-adapter, which .uiux/kit/package.json does not declare')
		expect(await exists(join(root, '.uiux', 'kit', 'package.json'))).toBe(false)
	})

	it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])('accepts a package declared in %s', async member => {
		const root = await seedOldLayout({ kitPackage: { [member]: { '@acme/uiux-adapter': '*' } } })
		const plan = await new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY }).planWorkspaceMigration()
		expect(plan).toMatchObject({ fromVersion: 4, version: 5, steps: [WORKSPACE_V4_TO_V5_STEP_ID] })
	})

	it('refuses a ./ Adapter inside .uiux/kit/node_modules/ with its bare replacement, and asks to declare it only when undeclared', async () => {
		const undeclared = await refusal({ adapters: [{ moduleSpecifier: './.uiux/kit/node_modules/@acme/uiux-adapter/index.js' }], kitPackage: { name: 'kit' } })
		expect(undeclared.errors).toContain('/adapters/0/moduleSpecifier: ./.uiux/kit/node_modules/@acme/uiux-adapter/index.js lies in a node_modules/ directory: replace it with @acme/uiux-adapter/index.js and declare @acme/uiux-adapter in .uiux/kit/package.json')
		expect(undeclared.errors).toContain('Edit each listed specifier in .uiux/workspace.json by hand as shown. Declare @acme/uiux-adapter in .uiux/kit/package.json')
		const declared = await refusal({ adapters: [{ moduleSpecifier: './.uiux/kit/node_modules/@acme/uiux-adapter/index.js' }] })
		expect(declared.errors).toMatch(/lies in a node_modules\/ directory: replace it with @acme\/uiux-adapter\/index\.js$/mu)
		expect(declared.errors).not.toContain('Declare ')
	})

	it('refuses a bare specifier that names no npm package, a node_modules/ subpath of a declared one included', async () => {
		const { errors } = await refusal({ adapters: [{ moduleSpecifier: '#internal/adapter' }, { moduleSpecifier: '@acme/uiux-adapter/node_modules/other/index.js' }] })
		expect(errors).toContain('/adapters/0/moduleSpecifier: #internal/adapter names no npm package')
		expect(errors).toContain('/adapters/1/moduleSpecifier: @acme/uiux-adapter/node_modules/other/index.js names no npm package')
	})

	it('fails closed on a kit package.json that is not a well-formed package file or is a symbolic link, writing nothing', async () => {
		const malformed = await refusal({ kitPackage: '{ not json' })
		expect(malformed.errors).toContain('kit/package.json could not be read as JSON')
		const wrongMember = await refusal({ kitPackage: { dependencies: ['@acme/uiux-adapter'] } })
		expect(wrongMember.errors).toContain('member dependencies is not an object')

		const root = await seedOldLayout({ kitPackage: null })
		const elsewhere = join(await makeDirectory('uiux-relocation-elsewhere-'), 'package.json')
		await writeFile(elsewhere, JSON.stringify({ dependencies: { '@acme/uiux-adapter': '*' } }))
		await symlink(elsewhere, join(root, '.uiux', 'kit', 'package.json'))
		const before = await tree(root)
		await expect(new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY }).migrateWorkspace()).rejects.toMatchObject({ code: 'persistence.path_rejected' })
		expect(await tree(root)).toEqual(before)
	})

	it('reads no package.json when no Adapter needs it, so a malformed one does not refuse a Workspace without bare Adapters', async () => {
		const root = await seedOldLayout({ adapters: [{ moduleSpecifier: './.uiux/kit/adapters/reference.ts' }], kitPackage: '{ not json' })
		expect(await new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY }).migrateWorkspace()).toMatchObject({ version: 5 })
	})
})

/** Every point of a relocation where a failure (or a kill) can land, in the order a run reaches them. */
const FAULT_POINTS: readonly (readonly [PersistenceFaultPoint, string])[] = [
	['relocation.before_move', 'views'],
	['relocation.after_move', 'views'],
	['relocation.after_move', 'reviews'],
	['relocation.after_move', 'assets'],
	['migration.before_apply', 'product-kit.json'],
	['migration.after_apply', 'product-kit.json'],
	['migration.before_apply', 'workspace.json'],
]

describe('relocation crash safety', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it.each(FAULT_POINTS)('rolls a failure at %s %s back in place, and a second run then succeeds', async (point, path) => {
		const root = await seedOldLayout()
		const before = await canonicalTree(root)
		let armed = true
		const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY, fault(hit, details) {
			if (armed && hit === point && details.path === path) {
				armed = false
				throw new Error(`injected fault at ${hit} ${path}`)
			}
		} })
		await expect(persistence.migrateWorkspace()).rejects.toMatchObject({ code: 'workspace.migration_failed', message: expect.stringContaining('restored as it was') })
		expect(await canonicalTree(root)).toEqual(before)
		expect(await readdir(join(root, '.uiux', '.transactions')).catch(() => [])).toEqual([])
		expect(await persistence.migrateWorkspace()).toMatchObject({ version: 5 })
		expect(await exists(join(root, '.uiux', 'views', `${VIEW_ID}.view.json`))).toBe(true)
	})

	it('treats a failure after the manifest was replaced as committed', async () => {
		const root = await seedOldLayout()
		const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY, fault(hit, details) {
			if (hit === 'migration.after_apply' && details.path === 'workspace.json') throw new Error('injected fault after the commit point')
		} })
		expect(await persistence.migrateWorkspace()).toMatchObject({ version: 5, relocation: { moved: ['views', 'flows', 'reviews', 'i18n', 'assets'] } })
		expect(await readdir(join(root, '.uiux', '.transactions')).catch(() => [])).toEqual([])
		expect((await new FileNativePersistence({ root: join(root, '.uiux'), schemaPolicy: V5_TEST_SCHEMA_POLICY }).inspectWorkspace()).inspection.state).toBe('current')
	})

	/**
	 * A kill at `point`: the disk state there (every write before it is synced) is copied aside, the
	 * live run goes on, and the copy stands for the Workspace a killed process left behind. Its lock
	 * file names this live process, so it is removed, as a dead holder's stale lock would be.
	 */
	async function killedAt(point: PersistenceFaultPoint, path: string, seed: Seed = {}): Promise<Readonly<{ original: Record<string, string>; killed: string }>> {
		const root = await seedOldLayout(seed)
		const original = await canonicalTree(root)
		const killed = join(await makeDirectory('uiux-relocation-killed-'), 'design')
		const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY, async fault(hit, details) {
			if (hit === point && details.path === path) await cp(root, killed, { recursive: true, verbatimSymlinks: true })
		} })
		await persistence.migrateWorkspace()
		await rm(join(killed, '.uiux', '.persistence.lock'), { force: true })
		expect(await readdir(join(killed, '.uiux', '.transactions'))).toHaveLength(1)
		return { original, killed }
	}

	it.each(FAULT_POINTS)('recovers a kill at %s %s from the old root by rolling everything back', async (point, path) => {
		const { original, killed } = await killedAt(point, path)
		// The journal uses the v5 format, so nothing reads it as a plain old-layout transaction.
		const [transaction] = await readdir(join(killed, '.uiux', '.transactions'))
		const journal = JSON.parse(await readFile(join(killed, '.uiux', '.transactions', transaction!, 'journal.json'), 'utf8')) as Record<string, unknown>
		expect(journal).toMatchObject({ layout: 'v5', relocation: { from: 'legacy', metadataDir: '.uiux', moves: ['views', 'flows', 'reviews', 'i18n', 'assets'] } })
		expect(journal).not.toHaveProperty('changes')
		// Not committed: the new root cannot roll back, so it keeps the journal and blocks.
		expect(checkWorkspaceSelection(killed, V5_TEST_SCHEMA_POLICY)).toEqual({ ok: true, layout: LEGACY_LAYOUT })
		const fromNewRoot = new FileNativePersistence({ root: join(killed, '.uiux'), schemaPolicy: V5_TEST_SCHEMA_POLICY, layout: V5_LAYOUT })
		await expect(fromNewRoot.inspectWorkspace()).rejects.toMatchObject({ code: 'persistence.recovery_failed' })
		expect(await readdir(join(killed, '.uiux', '.transactions'))).toEqual([transaction])

		const reopened = new FileNativePersistence({ root: killed, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect((await reopened.inspectWorkspace()).inspection).toMatchObject({ state: 'migration_required', version: 4 })
		expect(await canonicalTree(killed)).toEqual(Object.fromEntries(Object.entries(original).map(([key, value]) => [key, value])))
		expect(await reopened.migrateWorkspace()).toMatchObject({ version: 5 })
	})

	it.each([['relocation.after_move', 'views'], ['relocation.after_move', 'reviews'], ['migration.after_apply', `reviews/${REVIEW_ID}.review.json`]] as const)(
		'rolls back a 1 -> 5 run killed at %s %s, where a data file is rewritten, leaving nothing behind in .uiux/',
		async (point, path) => {
			const { original, killed } = await killedAt(point, path, { version: 1 })
			const reopened = new FileNativePersistence({ root: killed, schemaPolicy: V5_TEST_SCHEMA_POLICY })
			expect((await reopened.inspectWorkspace()).inspection).toMatchObject({ state: 'migration_required', version: 1 })
			expect(await canonicalTree(killed)).toEqual(original)
		},
	)

	it('recovers a kill after the manifest was replaced as committed, from the new root', async () => {
		const { killed } = await killedAt('migration.after_apply', 'workspace.json')
		expect(checkWorkspaceSelection(killed, V5_TEST_SCHEMA_POLICY)).toMatchObject({ ok: false, reason: 'relocated_parent' })
		const reopened = new FileNativePersistence({ root: join(killed, '.uiux'), schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect((await reopened.inspectWorkspace()).inspection).toMatchObject({ state: 'current', version: 5 })
		expect(await readdir(join(killed, '.uiux', '.transactions'))).toEqual([])
		expect((await reopened.views.read(VIEW_ID))?.resource).toEqual(view)
	})

	it('discards a committed relocation journal from the old root too, without moving anything back', async () => {
		const { killed } = await killedAt('migration.after_apply', 'workspace.json')
		const stale = new FileNativePersistence({ root: killed, schemaPolicy: V5_TEST_SCHEMA_POLICY, layout: LEGACY_LAYOUT })
		await stale.withLock(async () => undefined)
		expect(await readdir(join(killed, '.uiux', '.transactions'))).toEqual([])
		expect(await exists(join(killed, '.uiux', 'views', `${VIEW_ID}.view.json`))).toBe(true)
		expect(await exists(join(killed, 'views'))).toBe(false)
	})

	it('keeps a relocation journal it cannot place and blocks, instead of guessing', async () => {
		const { killed } = await killedAt('relocation.after_move', 'reviews')
		// The views directory is now on both sides.
		await mkdir(join(killed, 'views'))
		const reopened = new FileNativePersistence({ root: killed, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		await expect(reopened.inspectWorkspace()).rejects.toMatchObject({ code: 'persistence.recovery_failed' })
		expect(await readdir(join(killed, '.uiux', '.transactions'))).toHaveLength(1)
		expect(await exists(join(killed, '.uiux', 'views', `${VIEW_ID}.view.json`))).toBe(true)
	})
	it('writes a journal that names no `entries` and no `changes`, so builds before relocations fail closed on it', async () => {
		const { killed } = await killedAt('relocation.after_move', 'views')
		const [transaction] = await readdir(join(killed, '.uiux', '.transactions'))
		const journal = JSON.parse(await readFile(join(killed, '.uiux', '.transactions', transaction!, 'journal.json'), 'utf8')) as Record<string, unknown>
		expect(journal).not.toHaveProperty('entries')
		expect(journal).not.toHaveProperty('changes')
		expect(journal.relocationEntries).toEqual([{ path: 'product-kit.json', existed: false }, { path: 'workspace.json', existed: true }])
		expect(journal.relocation).toMatchObject({ createdDirectories: [] })
		// A relocation journal that also carries a plain `entries` list is not guessed at either.
		await writeFile(join(killed, '.uiux', '.transactions', transaction!, 'journal.json'), JSON.stringify({ ...journal, entries: [] }))
		await expect(new FileNativePersistence({ root: killed, schemaPolicy: V5_TEST_SCHEMA_POLICY }).inspectWorkspace()).rejects.toMatchObject({ code: 'persistence.recovery_failed' })
		expect(await readdir(join(killed, '.uiux', '.transactions'))).toEqual([transaction])
	})

	it('completes, on the next open, a rollback that a kill interrupted, with nothing lost', async () => {
		const { original, killed } = await killedAt('migration.before_apply', 'workspace.json')
		// The recovery itself is killed after it moved one directory back.
		const killedAgain = join(await makeDirectory('uiux-relocation-killed-again-'), 'design')
		let failures = 0
		const interrupted = new FileNativePersistence({ root: killed, schemaPolicy: V5_TEST_SCHEMA_POLICY, async fault(hit, details) {
			if (hit === 'relocation.before_rollback_move' && details.index === 1) {
				await cp(killed, killedAgain, { recursive: true, verbatimSymlinks: true })
				failures += 1
				throw new Error('injected kill during the rollback')
			}
		} })
		await expect(interrupted.inspectWorkspace()).rejects.toMatchObject({ code: 'persistence.recovery_failed' })
		expect(failures).toBe(1)
		await rm(join(killedAgain, '.uiux', '.persistence.lock'), { force: true })
		// Mid-rollback: the last directory is back at the old root, the others are still in .uiux/.
		expect(await exists(join(killedAgain, 'assets'))).toBe(true)
		expect(await exists(join(killedAgain, '.uiux', 'views'))).toBe(true)
		expect(await readdir(join(killedAgain, '.uiux', '.transactions'))).toHaveLength(1)

		for (const root of [killed, killedAgain]) {
			const reopened = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY })
			expect((await reopened.inspectWorkspace()).inspection).toMatchObject({ state: 'migration_required', version: 4 })
			expect(await canonicalTree(root)).toEqual(original)
			expect(await reopened.migrateWorkspace()).toMatchObject({ version: 5 })
		}
	})

	it('removes only the directories a rolled-back relocation created, keeping an empty one that existed before', async () => {
		const NEW_ASSET = '66666666-6666-4666-8666-666666666666'
		const EMPTY_ASSET = '77777777-7777-4777-8777-777777777777'
		// A step that, like a future one might, adds Assets while relocating: one in a new directory,
		// one in a directory that already exists and is empty.
		const asset = (id: string) => [
			[`assets/${id}/asset.json`, canonicalJsonBytes({ id, name: 'new', contentFilename: 'new.svg', mediaType: 'image/svg+xml' })],
			[`assets/${id}/new.svg`, new TextEncoder().encode('<svg/>')],
		] as const
		const policy = defineWorkspaceSchemaPolicy({
			currentVersion: 5,
			recognizedVersions: [4, 5],
			steps: [{
				...WORKSPACE_V4_TO_V5_STEP,
				async apply(snapshot) {
					return new Map([...await WORKSPACE_V4_TO_V5_STEP.apply(snapshot), ...asset(NEW_ASSET), ...asset(EMPTY_ASSET)])
				},
			}],
		})
		const root = await seedOldLayout()
		await mkdir(join(root, 'assets', EMPTY_ASSET))
		const before = await canonicalTree(root)
		const killed = join(await makeDirectory('uiux-relocation-killed-'), 'design')
		const persistence = new FileNativePersistence({ root, schemaPolicy: policy, async fault(hit, details) {
			if (hit === 'migration.before_apply' && details.path === 'workspace.json') {
				await cp(root, killed, { recursive: true, verbatimSymlinks: true })
				throw new Error('injected fault before the commit point')
			}
		} })
		await expect(persistence.migrateWorkspace()).rejects.toMatchObject({ code: 'workspace.migration_failed' })
		expect(await canonicalTree(root)).toEqual(before)
		expect(await exists(join(root, 'assets', NEW_ASSET))).toBe(false)
		expect((await readdir(join(root, 'assets', EMPTY_ASSET)))).toEqual([])

		// The journal names only the new directory, and a recovery after a kill there keeps the empty one too.
		const [transaction] = await readdir(join(killed, '.uiux', '.transactions'))
		const journal = JSON.parse(await readFile(join(killed, '.uiux', '.transactions', transaction!, 'journal.json'), 'utf8')) as { relocation: { createdDirectories: string[] } }
		expect(journal.relocation.createdDirectories).toEqual([`assets/${NEW_ASSET}`])
		await rm(join(killed, '.uiux', '.persistence.lock'), { force: true })
		await new FileNativePersistence({ root: killed, schemaPolicy: policy }).inspectWorkspace()
		expect(await canonicalTree(killed)).toEqual(before)
	})

})

describe('history across the relocation', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('records the Checkpoint and the system version under the old root, the version read in the new layout', async () => {
		const root = await seedOldLayout()
		const home = join(await makeDirectory('uiux-relocation-home-'), 'home')
		const run = capture()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: run.stdout, stderr: run.stderr }), run.err.join('\n')).toBe(0)
		expect(run.err).toEqual([])
		const output = run.out.join('\n')
		const systemVersion = /system version: (?<id>\S+)/u.exec(output)?.groups?.id
		expect(systemVersion).toBeDefined()
		// The pre-migration Checkpoint's physical directory is the new root's history/checkpoints/.
		const [checkpointFile] = await readdir(join(root, '.uiux', 'history', 'checkpoints'))
		const checkpoint = JSON.parse(await readFile(join(root, '.uiux', 'history', 'checkpoints', checkpointFile!), 'utf8')) as Record<string, unknown>
		expect(checkpoint).toMatchObject({ type: 'checkpoint', name: 'Before migration to schemaVersion 5', workspaceSchemaVersion: 4 })
		expect(output).toContain(`pre-migration Checkpoint: ${String(checkpoint.id)}`)

		// Rule 01a12626-5a0c: the host versions are the old root's; Rule 01a11bb1-96bb: the new root has none.
		const oldHost = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, root) }))!
		const versions = (await oldHost.listVersions()).records as HostVersionRecord[]
		const migration = versions.find(version => version.id === systemVersion)!
		expect(migration).toMatchObject({ type: 'system', actor: { type: 'system', id: 'system:migrate' }, workspaceSchemaVersion: 5, netChange: true })
		// Taken with the new root's layout: the Views are still there, and the Product Kit file is new.
		expect(migration.resources.map(resource => `${resource.kind}:${resource.key}`).sort()).toEqual([`asset:${ASSET_ID}`, 'locale:en-US', 'product-kit:product-kit', `view:${VIEW_ID}`, 'workspace:workspace'])
		expect(Object.keys(migration.resources.find(resource => resource.kind === 'view')!.files)).toEqual([`views/${VIEW_ID}.view.json`])
		expect(await HostHistoryStore.open({ paths: hostHistoryPaths(home, join(root, '.uiux')) })).toBeUndefined()
	})

	it('migrate, then access copy --from the old root, carries the roster and the history without --replace, and the Token works', async () => {
		const root = await seedOldLayout()
		const home = join(await makeDirectory('uiux-relocation-home-'), 'home')
		const access = async (...argv: string[]) => {
			const run = capture()
			const code = await runAccessCommand({ argv, env: { UIUX_HOME: home }, cwd: root, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: run.stdout, stderr: run.stderr })
			return { code, out: run.out.join('\n'), err: run.err.join('\n') }
		}
		expect((await access('member', 'add', 'claude', '--kind', 'agent', '--preset', 'Editor', '--workspace', root)).code).toBe(0)
		const token = (await access('token', 'create', '--member', 'claude', '--workspace', root)).out.match(/uiux_t_\S+/u)![0]

		const migrate = capture()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: migrate.stdout, stderr: migrate.stderr }), migrate.err.join('\n')).toBe(0)
		const newRoot = join(root, '.uiux')
		expect(await AccessStore.open({ workspaceRoot: newRoot, home })).toBeUndefined()

		const started = Date.now()
		const copied = await access('access', 'copy', '--from', root, '--workspace', newRoot)
		expect(copied, copied.err).toMatchObject({ code: 0, err: '' })
		// The source's lock is the target's own: no wait for a lock this command already holds.
		expect(Date.now() - started).toBeLessThan(10_000)
		expect(copied.out).toContain(`Copied 1 member(s) and 1 token(s)`)
		expect(copied.out).toContain(`Copied the host history`)
		const target = (await AccessStore.open({ workspaceRoot: newRoot, home }))!
		expect(target.data.workspaceRoot).toBe(newRoot)
		expect(verifyCredential(target.data, token, Date.now())).toMatchObject({ ok: true, member: { nickname: 'claude' } })
		const newHost = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, newRoot) }))!
		expect((await newHost.listVersions()).records.some(version => version.type === 'system' && version.workspaceSchemaVersion === 5)).toBe(true)
		// Once only: a second copy needs --replace.
		expect(await access('access', 'copy', '--from', root, '--workspace', newRoot)).toMatchObject({ code: 1, err: expect.stringContaining('--replace') })
	})
})

describe('the relocated-source exception to the entry check of access copy --from', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	async function relocated(): Promise<Readonly<{ root: string; newRoot: string }>> {
		const root = await seedOldLayout()
		await new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY }).migrateWorkspace()
		return { root, newRoot: join(root, '.uiux') }
	}

	it('holds for a finished relocation into the target', async () => {
		const { root, newRoot } = await relocated()
		expect(isRelocatedSourceOf(root, newRoot, V5_TEST_SCHEMA_POLICY)).toBe(true)
	})

	it('fails when the source is not a relocated parent (an old-layout Workspace, or a policy without schemaVersion 5)', async () => {
		const plain = await seedOldLayout()
		expect(isRelocatedSourceOf(plain, join(plain, '.uiux'), V5_TEST_SCHEMA_POLICY)).toBe(false)
		const { root, newRoot } = await relocated()
		// A build that does not recognize 5 sees the source as `unknown_schema`, never relocated.
		expect(checkWorkspaceSelection(root, V4_TEST_SCHEMA_POLICY)).toMatchObject({ ok: false, reason: 'unknown_schema' })
		expect(isRelocatedSourceOf(root, newRoot, V4_TEST_SCHEMA_POLICY)).toBe(false)
	})

	it('fails when <old>/.uiux does not pass the v5 entry check', async () => {
		const { root, newRoot } = await relocated()
		await rm(join(newRoot, 'product-kit.json'))
		expect(isRelocatedSourceOf(root, newRoot, V5_TEST_SCHEMA_POLICY)).toBe(false)
	})

	it('fails when <old>/.uiux is not the target root', async () => {
		const { root } = await relocated()
		const other = await relocated()
		expect(isRelocatedSourceOf(root, other.newRoot, V5_TEST_SCHEMA_POLICY)).toBe(false)
		expect(isRelocatedSourceOf(root, root, V5_TEST_SCHEMA_POLICY)).toBe(false)
	})

	it('fails when <old>/.uiux is a symbolic link, even to the target', async () => {
		const { newRoot } = await relocated()
		const parent = await makeDirectory('uiux-relocation-linked-')
		await symlink(newRoot, join(parent, '.uiux'))
		expect(isRelocatedSourceOf(parent, newRoot, V5_TEST_SCHEMA_POLICY)).toBe(false)
	})

	it.each(['views', 'flows', 'reviews', 'i18n', 'assets'])('fails while the old-layout data directory %s is left in the source', async directory => {
		const { root, newRoot } = await relocated()
		await mkdir(join(root, directory))
		expect(isRelocatedSourceOf(root, newRoot, V5_TEST_SCHEMA_POLICY)).toBe(false)
	})

	it('makes access copy refuse the source when the exception does not hold', async () => {
		const { root, newRoot } = await relocated()
		const home = join(await makeDirectory('uiux-relocation-home-'), 'home')
		await mkdir(join(root, 'views'))
		const run = capture()
		expect(await runAccessCommand({ argv: ['access', 'copy', '--from', root, '--workspace', newRoot], env: { UIUX_HOME: home }, cwd: root, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: run.stdout, stderr: run.stderr })).toBe(2)
		expect(run.err.join('\n')).toContain('The source ')
		expect(run.err.join('\n')).toContain('select that directory instead')
	})
})
