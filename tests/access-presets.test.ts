import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUILT_IN_ACCESS_PRESETS, keysOfPreset, PERMISSION_KEYS } from '../src/application/access/keys'
import { memberLabel } from '../src/application/access/labels'
import { createLeaseManager } from '../src/application/access/leases'
import type { MemberPrincipal } from '../src/application/access/principal'
import { createHistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { runAccessCommand } from '../src/cli/access'
import { runInitCommand } from '../src/cli/init'
import {
	ACCESS_PRESETS_FILENAME,
	builtInAccessPresetsFile,
	validateAccessPresetsFile,
	type AccessPreset,
} from '../src/domain/access-presets/schema'
import type { HostVersionRecord } from '../src/domain/history/schema'
import { canonicalJsonBytes, FileNativePersistence, V5_LAYOUT } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY, WORKSPACE_V5_TO_V6_STEP } from '../src/product/workspace-schema'
import { readAccessPresetsForHttp, updateAccessPresetsForHttp } from '../src/server/access-presets-http'
import { addMember } from '../src/server/access/roster'
import { AccessService, memberPrincipal } from '../src/server/access/service'
import { AccessStore } from '../src/server/access/store'
import { readWorkspaceAccessPresets } from '../src/server/access/workspace-presets'
import { createHistoryStoreFactory } from '../src/server/history-stores'
import { connectMcp, scoped, testMember } from './support/access'
import { createCurrentWorkspace, v5Manifest, writeCurrentWorkspace, writeManifest } from './support/workspace-layout'

/**
 * The Access presets file, `uiux.v5-to-v6` and `update_access_presets` (issue #142, unit P6):
 * Feature 01a11c09-984a-7835-95ef-67164dd91746, Clauses 01a11c09-a855-…, 01a11c09-a8c3-…,
 * 01a11c09-a930-…, 01a11c09-a9a4-…, 01a11c09-a50e-…, 01a11c09-a57d-…, 01a11485-fa00-…,
 * 01a11485-fa66-…, 01a11c09-a42a-… and 01a11a5e-216d-…, Rule 01a11c09-c6b5-….
 */

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeRoot(prefix = 'uiux-access-presets-'): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	roots.push(root)
	return root
}

async function workspace() {
	const root = await makeRoot()
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence)
	const app = createWorkspaceApplicationSession(persistence)
	return { root, persistence, app, presetsPath: join(root, ACCESS_PRESETS_FILENAME) }
}

async function revision(app: WorkspaceApplicationSession): Promise<string> {
	const read = await app.readAccessPresets()
	if (!read?.revision) throw new Error('no Access presets file')
	return read.revision
}

const builtIns = (): AccessPreset[] => builtInAccessPresetsFile().presets
const OWNER = testMember({ nickname: 'olga', kind: 'human', role: 'owner', credential: 'session' })
const OWNER_TOKEN = testMember({ nickname: 'olga', kind: 'human', role: 'owner', credential: 'token' })
const EDITOR = testMember({ nickname: 'erin', kind: 'human', role: 'editor', credential: 'session' })
const VIEWER = testMember({ nickname: 'vera', kind: 'human', role: 'viewer', credential: 'session' })
const AGENT = testMember({ nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })
const MANAGER = testMember({ nickname: 'pia', kind: 'human', credential: 'session', keys: ['workspace.read', 'presets.manage'] })

const http = (app: WorkspaceApplicationSession, principal: MemberPrincipal) => scoped(app, principal, { leases: createLeaseManager() })

describe('the Access presets file (Clauses 01a11c09-a855, 01a11c09-a8c3 and 01a11c09-a930)', () => {
	it('holds the four built-in presets, in order, with keys in catalog order, and validates', () => {
		const file = builtInAccessPresetsFile()
		expect(file.presets.map(preset => [preset.id, preset.name])).toEqual([['viewer', 'Viewer'], ['reviewer', 'Reviewer'], ['editor', 'Editor'], ['owner', 'Owner']])
		for (const preset of file.presets) expect(preset.keys).toEqual(PERMISSION_KEYS.filter(key => preset.keys.includes(key)))
		expect(file.presets.at(-1)!.keys).toEqual([...PERMISSION_KEYS])
		expect(validateAccessPresetsFile(file)).toMatchObject({ ok: true, diagnostics: [] })
		expect(validateAccessPresetsFile({ presets: [] }).ok).toBe(true)
	})

	it('reports a file broken on disk with the codes of Clause 01a11c09-a57d (Rule 01a11c09-cb08)', () => {
		const codes = (presets: unknown[]) => validateAccessPresetsFile({ presets }).diagnostics.map(item => item.code)
		const viewer = builtIns()[0]!
		expect(codes([viewer, { ...viewer, id: 'readers', name: 'Readers' }])).toEqual(['access.preset_duplicate'])
		const duplicate = validateAccessPresetsFile({ presets: [viewer, { ...viewer, id: 'readers', name: 'Readers' }] }).diagnostics[0]!
		expect(duplicate).toMatchObject({ path: '/presets/1/keys' })
		expect(duplicate.message).toContain('"Viewer" (viewer)')
		expect(duplicate.message).toContain('"Readers" (readers)')
		expect(codes([viewer, { id: 'other', name: 'VIEWER', keys: ['workspace.read'] }])).toEqual(['access.preset_name_taken'])
		expect(codes([{ id: 'resolver', name: 'Resolver', keys: ['workspace.read', 'reviews.resolve'] }])).toEqual(['access.key_requires'])
		expect(codes([{ id: 'future', name: 'Future', keys: ['workspace.read', 'future.capability'] }])).toEqual(['access.unknown_key'])
	})

	it('refuses a name that is empty, longer than 40 characters or Custom, a bad id, and keys out of catalog order, with the codes of Clause 01a12f9d-eb8d', () => {
		const codes = (preset: unknown) => validateAccessPresetsFile({ presets: [preset] }).diagnostics.map(item => item.code)
		expect(codes({ id: 'a', name: '', keys: ['workspace.read'] })).toEqual(['access.preset_name_invalid'])
		expect(codes({ id: 'a', name: 'x'.repeat(41), keys: ['workspace.read'] })).toEqual(['access.preset_name_invalid'])
		expect(codes({ id: 'a', name: 'x'.repeat(40), keys: ['workspace.read'] })).toEqual([])
		expect(codes({ id: 'a', name: 'custom', keys: ['workspace.read'] })).toEqual(['access.preset_name_invalid'])
		expect(codes({ id: 'Not A Slug', name: 'A', keys: ['workspace.read'] })).toEqual(['access.preset_id_invalid'])
		expect(codes({ id: 'a', name: 'A', keys: ['views.write', 'workspace.read'] })).toEqual(['access.preset_keys_unordered'])
		expect(codes({ id: 'a', name: 'A', keys: ['workspace.read', 'workspace.read'] })).toEqual(['identity.duplicate'])
		expect(validateAccessPresetsFile({ presets: [], extra: 1 }).diagnostics.map(item => item.code)).toEqual(['schema.unknown_field'])
	})

	it('compares names after NFC normalization and trimming, and refuses control and format characters, without folding confusables (Clause 01a11c09-a8c3, #140 owner ruling 4 of 2026-10-12)', () => {
		const codes = (presets: unknown[]) => validateAccessPresetsFile({ presets }).diagnostics.map(item => item.code)
		const [viewer, reviewer] = builtIns()
		// A Greek capital Omicron makes another name: confusables are not detected.
		expect(codes([{ ...viewer, name: 'Owner' }, { ...reviewer, name: 'Οwner' }])).toEqual([])
		// NFC and NFD spell one name, and so do names that differ only in surrounding spaces.
		expect(codes([{ ...viewer, name: 'Café' }, { ...reviewer, name: 'Café' }])).toEqual(['access.preset_name_taken'])
		expect(codes([{ ...viewer, name: 'Lead' }, { ...reviewer, name: '  lead ' }])).toEqual(['access.preset_name_taken'])
		// A zero-width space, a right-to-left override, a newline, a tab, and a name of a zero-width joiner alone.
		for (const name of ['Edi​tor', '‮Editor', 'Edi\ntor', 'Editor\t', '‍'])
			expect(codes([{ ...viewer, name }]), JSON.stringify(name)).toEqual(['access.preset_name_invalid'])
		expect(codes([{ ...viewer, name: ' custom ' }])).toEqual(['access.preset_name_invalid'])
		expect(codes([{ ...viewer, name: '   ' }])).toEqual(['access.preset_name_invalid'])
	})
})

describe('uiux.v5-to-v6 and uiux init (Clauses 01a11c09-a9a4 and 01a1144e-55a3, Rule 01a11c09-c6b5)', () => {
	it('adds the presets file with the built-in presets and changes only the manifest schemaVersion', async () => {
		const root = await makeRoot()
		await writeManifest(root, canonicalJsonBytes(v5Manifest({ viewports: { phone: { dimensions: { width: 390, height: 844 } } } })), V5_LAYOUT)
		await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes({ designSystems: [], adapters: [], styles: [], themes: {}, components: {}, widgets: {} }))
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect((await persistence.inspectWorkspace()).inspection.state).toBe('migration_required')
		const productKit = await readFile(join(root, 'product-kit.json'))
		const result = await persistence.migrateWorkspace()
		expect(result).toMatchObject({ fromVersion: 5, version: 6, steps: ['uiux.v5-to-v6'] })
		expect([...result.changedFiles].sort()).toEqual(['access-presets.json', 'workspace.json'])
		expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'))).toEqual({ ...v5Manifest({ viewports: { phone: { dimensions: { width: 390, height: 844 } } } }), schemaVersion: 6 })
		expect(await readFile(join(root, 'product-kit.json'))).toEqual(productKit)
		expect(await readFile(join(root, ACCESS_PRESETS_FILENAME))).toEqual(canonicalJsonBytes(builtInAccessPresetsFile()))
		expect(await persistence.accessPresets.readInspected()).toMatchObject({ diagnostics: [] })
	})

	it('makes uiux migrate refuse a schemaVersion 5 Workspace that already holds a presets file, writing nothing, while an in-memory upgrade still reads', async () => {
		const snapshot = new Map<string, Uint8Array>([
			['workspace.json', canonicalJsonBytes(v5Manifest())],
			[ACCESS_PRESETS_FILENAME, canonicalJsonBytes({ presets: [] })],
		])
		const refusal = await WORKSPACE_V5_TO_V6_STEP.refuse!(snapshot, { readWorkspaceFile: async () => undefined })
		expect(refusal?.message).toContain('access-presets.json, which this schemaVersion 5 Workspace already holds')
		expect((await WORKSPACE_V5_TO_V6_STEP.apply(snapshot)).get(ACCESS_PRESETS_FILENAME)).toEqual(canonicalJsonBytes(builtInAccessPresetsFile()))

		const root = await makeRoot()
		await writeManifest(root, canonicalJsonBytes(v5Manifest()), V5_LAYOUT)
		await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes({ designSystems: [], adapters: [], styles: [], themes: {}, components: {}, widgets: {} }))
		await writeFile(join(root, ACCESS_PRESETS_FILENAME), '{"presets":[]}')
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await expect(persistence.migrateWorkspace()).rejects.toMatchObject({ code: 'workspace.migration_failed' })
		expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).schemaVersion).toBe(5)
		expect(await readFile(join(root, ACCESS_PRESETS_FILENAME), 'utf8')).toBe('{"presets":[]}')
	})

	it('writes the presets file in a new Workspace', async () => {
		const parent = await makeRoot()
		const root = join(parent, 'ws')
		expect(await runInitCommand({ workspace: root, cwd: parent, env: { UIUX_HOME: join(parent, 'home') }, stdout: () => undefined, stderr: () => undefined })).toBe(0)
		expect(JSON.parse(await readFile(join(root, ACCESS_PRESETS_FILENAME), 'utf8'))).toEqual(builtInAccessPresetsFile())
		expect((await readdir(root)).sort()).toEqual(['.gitignore', 'access-presets.json', 'product-kit.json', 'workspace.json'])
	})

	it('refuses to initialize a directory that already holds a presets file', async () => {
		const root = await makeRoot()
		await writeFile(join(root, ACCESS_PRESETS_FILENAME), '{}')
		const errors: string[] = []
		expect(await runInitCommand({ workspace: root, cwd: root, env: { UIUX_HOME: `${root}-home` }, stdout: () => undefined, stderr: line => errors.push(line) })).toBe(2)
		expect(errors.join('\n')).toContain('already holds access-presets.json')
	})
})

describe('reading and update_access_presets over HTTP (Clauses 01a11c09-a50e, 01a11c09-a57d, 01a11485-fa00 and 01a11485-fa66)', () => {
	it('reads the presets with workspace.read, and 404 below schemaVersion 6', async () => {
		const ctx = await workspace()
		const read = await readAccessPresetsForHttp(http(ctx.app, VIEWER))
		expect(read).toMatchObject({ status: 200, body: { kind: 'access-presets', key: 'access-presets', resource: builtInAccessPresetsFile(), diagnostics: [] } })
		const none = testMember({ nickname: 'nobody', kind: 'human', credential: 'session', keys: [] })
		expect(await readAccessPresetsForHttp(http(ctx.app, none))).toMatchObject({ status: 403, body: { code: 'auth.scope_denied', requiredKeys: ['workspace.read'] } })

		const old = await makeRoot()
		await writeManifest(old, canonicalJsonBytes(v5Manifest()), V5_LAYOUT)
		await writeFile(join(old, 'product-kit.json'), canonicalJsonBytes({ designSystems: [], adapters: [], styles: [], themes: {}, components: {}, widgets: {} }))
		const oldApp = createWorkspaceApplicationSession(new FileNativePersistence({ root: old, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }))
		expect(await readAccessPresetsForHttp(http(oldApp, VIEWER))).toMatchObject({ status: 404 })
		expect(await updateAccessPresetsForHttp(http(oldApp, OWNER), { expectedRevision: 'r', presets: [] })).toMatchObject({ status: 422, body: { status: 'blocked', code: 'workspace.migration_required' } })
	})

	it('replaces the whole presets array with compare-and-swap, keys stored in catalog order, and an empty array is valid (Rule 01a11c09-c78f)', async () => {
		const ctx = await workspace()
		const presets = [
			{ id: 'lead', name: 'Lead', keys: ['views.write', 'workspace.read', 'history.read'] },
			...builtIns().filter(preset => preset.id !== 'owner'),
		]
		const updated = await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: await revision(ctx.app), presets })
		expect(updated).toMatchObject({ status: 200, body: { status: 'updated', key: 'access-presets', diagnostics: [] } })
		const stored = JSON.parse(await readFile(ctx.presetsPath, 'utf8')) as { presets: AccessPreset[] }
		expect(stored.presets.map(preset => preset.id)).toEqual(['lead', 'viewer', 'reviewer', 'editor'])
		expect(stored.presets[0]!.keys).toEqual(['workspace.read', 'history.read', 'views.write'])

		const stale = await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: (updated.body as { revision: string }).revision.replace(/.$/u, '0'), presets: [] })
		expect(stale).toMatchObject({ status: 409, body: { status: 'conflict', currentRevision: await revision(ctx.app) } })

		expect(await updateAccessPresetsForHttp(http(ctx.app, MANAGER), { expectedRevision: await revision(ctx.app), presets: [] })).toMatchObject({ status: 200 })
		expect(JSON.parse(await readFile(ctx.presetsPath, 'utf8'))).toEqual({ presets: [] })
	})

	it('needs presets.manage on a human member\'s Workbench session: an Editor, an Owner\'s bearer Token and an Agent are refused', async () => {
		const ctx = await workspace()
		const before = await readFile(ctx.presetsPath)
		const body = { expectedRevision: await revision(ctx.app), presets: [] }
		for (const principal of [EDITOR, OWNER_TOKEN, AGENT, VIEWER]) {
			const refused = await updateAccessPresetsForHttp(http(ctx.app, principal), body)
			expect(refused, principal.nickname).toMatchObject({ status: 403, body: { status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['presets.manage'] } })
		}
		const token = await updateAccessPresetsForHttp(http(ctx.app, OWNER_TOKEN), body)
		expect((token.body as { message: string }).message).toContain('humanOnly')
		expect(await readFile(ctx.presetsPath)).toEqual(before)
	})

	it('refuses equal key sets naming both presets, a taken name, a missing requirement and a new unknown key, writing nothing (Rule 01a11c09-c7ff)', async () => {
		const ctx = await workspace()
		const before = await readFile(ctx.presetsPath)
		const expectedRevision = await revision(ctx.app)
		const [viewer, reviewer] = builtIns()
		const cases: [unknown[], string][] = [
			[[viewer, { id: 'readers', name: 'Readers', keys: [...viewer!.keys].reverse() }], 'access.preset_duplicate'],
			[[viewer, { ...reviewer, name: 'viewer' }], 'access.preset_name_taken'],
			[[{ id: 'resolver', name: 'Resolver', keys: ['workspace.read', 'reviews.resolve'] }], 'access.key_requires'],
			[[{ id: 'future', name: 'Future', keys: ['workspace.read', 'future.capability'] }], 'access.unknown_key'],
		]
		for (const [presets, code] of cases) {
			const refused = await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision, presets })
			expect(refused, code).toMatchObject({ status: 400, body: { status: 'invalid', code, diagnostics: [expect.objectContaining({ code })] } })
		}
		const duplicate = await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision, presets: cases[0]![0] })
		expect((duplicate.body as { message: string }).message).toMatch(/"Viewer" \(viewer\) and "Readers" \(readers\)/u)
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision, presets: [{ id: 'x', name: 'Custom', keys: ['workspace.read'] }] }))
			.toMatchObject({ status: 400, body: { code: 'access.preset_name_invalid' } })
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision, presets: [{ id: 'Not A Slug', name: 'A', keys: ['workspace.read'] }] }))
			.toMatchObject({ status: 400, body: { code: 'access.preset_id_invalid' } })
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision, presets: 'all' })).toMatchObject({ status: 400, body: { code: 'malformed_payload' } })
		expect(await readFile(ctx.presetsPath)).toEqual(before)
	})

	it('refuses a name that is another preset\'s after NFC normalization and trimming, " custom " and a bidirectional control, and allows a confusable name (Clause 01a11c09-a8c3)', async () => {
		const ctx = await workspace()
		const before = await readFile(ctx.presetsPath)
		const expectedRevision = await revision(ctx.app)
		const [viewer, reviewer] = builtIns()
		const save = (presets: unknown[]) => updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision, presets })
		expect(await save([{ ...viewer, name: 'Café' }, { ...reviewer, name: 'Café' }])).toMatchObject({ status: 400, body: { code: 'access.preset_name_taken' } })
		expect(await save([{ ...viewer, name: ' custom ' }])).toMatchObject({ status: 400, body: { code: 'access.preset_name_invalid' } })
		expect(await save([{ ...viewer, name: 'Edi‮tor' }])).toMatchObject({ status: 400, body: { code: 'access.preset_name_invalid' } })
		expect(await readFile(ctx.presetsPath)).toEqual(before)
		expect(await save([{ ...viewer, name: 'Owner' }, { ...reviewer, name: 'Οwner' }])).toMatchObject({ status: 200, body: { status: 'updated' } })
	})

	it('keeps a key unknown to this version that the file already holds, and reports it as a diagnostic (#140 owner ruling 1 of 2026-10-11)', async () => {
		const ctx = await workspace()
		const future = { id: 'future', name: 'Future', keys: ['workspace.read', 'future.capability'] }
		await writeFile(ctx.presetsPath, `${JSON.stringify({ presets: [...builtIns(), future] })}\n`)
		const read = await readAccessPresetsForHttp(http(ctx.app, VIEWER))
		expect((read.body as { diagnostics: { code: string }[] }).diagnostics.map(item => item.code)).toEqual(['access.unknown_key'])
		const renamed = { ...future, name: 'Later' }
		const updated = await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: await revision(ctx.app), presets: [renamed, ...builtIns()] })
		expect(updated).toMatchObject({ status: 200, body: { status: 'updated', diagnostics: [expect.objectContaining({ code: 'access.unknown_key' })] } })
		expect((JSON.parse(await readFile(ctx.presetsPath, 'utf8')) as { presets: AccessPreset[] }).presets[0]).toEqual(renamed)
	})

	it('reads a presets file a merge left conflict markers in as no resource with persistence.invalid_json, and replaces it with its revision (Rules 01a11c09-cb08 and 01a12f9c-3dab, Clause 01a12f98-f466)', async () => {
		const ctx = await workspace()
		const conflicted = [
			'{',
			'  "presets": [',
			'<<<<<<< HEAD',
			'    { "id": "viewer", "name": "Viewer", "keys": ["workspace.read"] }',
			'=======',
			'    { "id": "viewer", "name": "Reader", "keys": ["workspace.read"] }',
			'>>>>>>> theirs',
			'  ]',
			'}',
			'',
		].join('\n')
		await writeFile(ctx.presetsPath, conflicted)
		const bytesRevision = await ctx.persistence.accessPresets.readRevision()
		const read = await readAccessPresetsForHttp(http(ctx.app, VIEWER))
		expect(read).toMatchObject({ status: 200, body: { kind: 'access-presets', key: 'access-presets', resource: null, revision: bytesRevision, diagnostics: [{ code: 'persistence.invalid_json', path: '/access-presets.json' }] } })
		expect((read.body as { diagnostics: unknown[] }).diagnostics).toHaveLength(1)
		// No preset labels anybody meanwhile.
		expect(await readWorkspaceAccessPresets(ctx.root)).toEqual([])

		const [viewer] = builtIns()
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: bytesRevision!.replace(/.$/u, '0'), presets: [viewer] })).toMatchObject({ status: 409, body: { currentRevision: bytesRevision } })
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: null, presets: [viewer] })).toMatchObject({ status: 409, body: { currentRevision: bytesRevision } })
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: bytesRevision, presets: [{ id: 'x', name: 'Custom', keys: [] }] })).toMatchObject({ status: 400 })
		expect(await readFile(ctx.presetsPath, 'utf8')).toBe(conflicted)

		const replaced = await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: bytesRevision, presets: builtIns() })
		expect(replaced).toMatchObject({ status: 200, body: { status: 'updated', diagnostics: [] } })
		expect(JSON.parse(await readFile(ctx.presetsPath, 'utf8'))).toEqual(builtInAccessPresetsFile())
		expect(await readAccessPresetsForHttp(http(ctx.app, VIEWER))).toMatchObject({ status: 200, body: { resource: builtInAccessPresetsFile(), diagnostics: [] } })
	})

	it('keeps a schemaVersion 6 Workspace without its presets file usable: the read reports access.presets_missing and a write with expectedRevision null creates the file (Rules 01a12f98-c032 and 01a12f98-d643, Clause 01a12f98-f466)', async () => {
		const ctx = await workspace()
		await rm(ctx.presetsPath)
		expect((await ctx.persistence.inspectWorkspace()).inspection.state).toBe('current')
		expect(await readAccessPresetsForHttp(http(ctx.app, VIEWER))).toMatchObject({
			status: 200,
			body: { kind: 'access-presets', key: 'access-presets', resource: null, revision: null, diagnostics: [{ code: 'access.presets_missing', path: '/access-presets.json' }] },
		})
		// The rest of the Workspace stays writable.
		const settings = await ctx.app.readPointResource('workspace', 'workspace')
		if (settings?.kind !== 'workspace') throw new Error('workspace')
		expect(await ctx.app.updateWorkspaceSettings({ expectedRevision: settings.revision, settings: { ...settings.resource, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } } } })).toMatchObject({ status: 'updated' })

		// A revision names an existing file, so it finds none; a refused write creates nothing.
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: 'r_missing', presets: [] })).toMatchObject({ status: 404, body: { status: 'not_found' } })
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: null, presets: [{ id: 'x', name: 'Custom', keys: [] }] })).toMatchObject({ status: 400, body: { code: 'access.preset_name_invalid' } })
		expect(await updateAccessPresetsForHttp(http(ctx.app, EDITOR), { expectedRevision: null, presets: [] })).toMatchObject({ status: 403, body: { code: 'auth.scope_denied' } })
		await expect(readFile(ctx.presetsPath)).rejects.toMatchObject({ code: 'ENOENT' })

		const created = await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: null, presets: builtIns() })
		expect(created).toMatchObject({ status: 201, body: { status: 'created', key: 'access-presets', revision: await revision(ctx.app), diagnostics: [] } })
		expect(JSON.parse(await readFile(ctx.presetsPath, 'utf8'))).toEqual(builtInAccessPresetsFile())
		// Once the file exists, `null` conflicts with it.
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: null, presets: [] })).toMatchObject({ status: 409, body: { status: 'conflict', currentRevision: await revision(ctx.app) } })
	})

	it('lets the next save fix a file a merge broke', async () => {
		const ctx = await workspace()
		const viewer = builtIns()[0]!
		await writeFile(ctx.presetsPath, `${JSON.stringify({ presets: [viewer, { ...viewer, id: 'readers', name: 'Readers' }] })}\n`)
		const read = await ctx.app.readAccessPresets()
		expect(read?.diagnostics.map(item => item.code)).toEqual(['access.preset_duplicate'])
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: read!.revision, presets: [viewer] })).toMatchObject({ status: 200, body: { diagnostics: [] } })
	})

	it('is not offered over MCP: no Tool or Resource, and restore_resource_version refuses the kind (Rule 01a11c09-cbea)', async () => {
		const ctx = await workspace()
		const mcp = await connectMcp(ctx.app, AGENT)
		try {
			const tools = (await mcp.client.listTools()).tools.map(tool => tool.name)
			expect(tools.filter(name => name.includes('preset'))).toEqual([])
			const resources = [...(await mcp.client.listResources()).resources.map(resource => resource.uri), ...(await mcp.client.listResourceTemplates()).resourceTemplates.map(template => template.uriTemplate)]
			expect(resources.filter(uri => uri.includes('preset'))).toEqual([])
			const restored = await mcp.client.callTool({ name: 'restore_resource_version', arguments: { versionId: '11111111-1111-4111-8111-111111111111', resource: { kind: 'access-presets', key: 'access-presets' }, expectedRevision: await revision(ctx.app) } })
			expect(restored).toMatchObject({ isError: true, structuredContent: { code: 'history.restore_unsupported_kind' } })
		}
		finally { await mcp.close() }
	})
})

describe('Access presets history and restore (Clauses 01a11a5e-1fc4, 01a11a5e-216d and 01a11c09-a42a)', () => {
	const clock = (): HistoryRecorderClock => ({ now: () => Date.parse('2026-10-12T00:00:00.000Z'), setTimeout: () => Symbol('timer'), clearTimeout: () => undefined })

	it('records updateAccessPresets as a write event of the access-presets resource, and restores it only with presets.manage', async () => {
		const base = await workspace()
		const home = join(await makeRoot('uiux-access-presets-home-'), 'home')
		const history = createHistoryStoreFactory({ workspaceRoot: base.root, persistence: base.persistence, home: () => home })
		const recorder = createHistoryRecorder({ persistence: base.persistence, stores: () => history.open(), clock: clock(), log: () => undefined })
		const app = createWorkspaceApplicationSession(base.persistence, { history, historyBoundary: () => recorder })
		const { baseline } = await recorder.start()
		const checkpoint = JSON.parse(await readFile(join(base.root, 'history', 'checkpoints', `${baseline}.json`), 'utf8')) as { resources: { kind: string; key: string; files: Record<string, string> }[] }
		expect(checkpoint.resources.find(resource => resource.kind === 'access-presets')).toMatchObject({ key: 'access-presets', files: { 'access-presets.json': expect.stringMatching(/^sha256:/u) } })

		const renamed = builtIns().map(preset => preset.id === 'editor' ? { ...preset, name: 'Maker' } : preset)
		expect(await updateAccessPresetsForHttp(http(app, OWNER), { expectedRevision: await revision(app), presets: renamed })).toMatchObject({ status: 200 })
		await recorder.stop()
		const versions = (await (await history.open())!.host.listVersions()).records as HostVersionRecord[]
		expect(versions.flatMap(version => version.events.map(event => `${event.operation}:${event.source}`))).toEqual(['updateAccessPresets:workbench'])
		expect(versions[0]!.resources.find(resource => resource.kind === 'access-presets')?.revision).toBe(await revision(app))

		const restore = { versionId: baseline!, resource: { kind: 'access-presets', key: 'access-presets' }, expectedRevision: await revision(app) }
		const restorer = testMember({ nickname: 'rhea', kind: 'human', credential: 'session', keys: ['workspace.read', 'history.read', 'history.restore'] })
		expect(await http(app, restorer).restoreResourceVersion(restore)).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['presets.manage'] })
		expect(await http(app, OWNER_TOKEN).restoreResourceVersion(restore)).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['presets.manage'] })
		expect(await http(app, OWNER).restoreResourceVersion(restore)).toMatchObject({ status: 'updated', kind: 'access-presets', key: 'access-presets', restoredFrom: baseline })
		expect(JSON.parse(await readFile(base.presetsPath, 'utf8'))).toEqual(builtInAccessPresetsFile())
	})
})

describe('the Access presets Scenarios', () => {
	/** A Workspace with a host roster holding `members`, labeled through the server's presets reader. */
	async function withRoster(members: readonly Readonly<{ nickname: string; kind: 'human' | 'agent'; preset: string }>[]) {
		const ctx = await workspace()
		const home = join(await makeRoot('uiux-access-presets-home-'), 'home')
		const store = (await AccessStore.open({ workspaceRoot: ctx.root, home, create: true }))!
		for (const member of members)
			await store.update(file => addMember(file, { nickname: member.nickname, kind: member.kind, keys: keysOfPreset(member.kind, builtIns().find(preset => preset.id === member.preset)!.keys) }))
		const service = new AccessService({ store, leases: createLeaseManager(), presets: () => readWorkspaceAccessPresets(ctx.root) })
		const labels = async () => {
			const presets = await service.presets()
			return Object.fromEntries(store.data.members.map(member => [member.nickname, memberLabel(member, presets)]))
		}
		const keys = () => Object.fromEntries(store.data.members.map(member => [member.nickname, member.keys]))
		return { ...ctx, store, service, labels, keys }
	}

	it('renames a preset in a pulled commit, which changes labels only (Scenario 01a11c09-d68e)', async () => {
		const ctx = await withRoster([{ nickname: 'erin', kind: 'human', preset: 'editor' }])
		expect(await ctx.labels()).toEqual({ erin: { preset: { id: 'editor', name: 'Editor' } } })
		const keys = ctx.keys()
		// A pulled commit is a change of the file on disk, outside any UIUX operation.
		await writeFile(ctx.presetsPath, `${JSON.stringify({ presets: builtIns().map(preset => preset.id === 'editor' ? { ...preset, name: 'Author' } : preset) }, null, 2)}\n`)
		expect(await ctx.labels()).toEqual({ erin: { preset: { id: 'editor', name: 'Author' } } })
		await ctx.service.refresh(true)
		expect(ctx.keys()).toEqual(keys)
	})

	it('deletes every preset, which leaves every member Custom with unchanged keys (Scenario 01a11c09-d6fe)', async () => {
		const ctx = await withRoster([
			{ nickname: 'olga', kind: 'human', preset: 'owner' },
			{ nickname: 'mei', kind: 'human', preset: 'reviewer' },
			{ nickname: 'claude', kind: 'agent', preset: 'editor' },
		])
		expect(Object.values(await ctx.labels()).every(label => 'preset' in label)).toBe(true)
		const keys = ctx.keys()
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: await revision(ctx.app), presets: [] })).toMatchObject({ status: 200 })
		expect(await ctx.labels()).toEqual({ olga: { custom: true }, mei: { custom: true }, claude: { custom: true } })
		await ctx.service.refresh(true)
		expect(ctx.keys()).toEqual(keys)
	})

	it('refuses saving QA with the keys of Reviewer, naming both, and leaves the file unchanged (Scenario 01a11c09-d774)', async () => {
		const ctx = await workspace()
		const reviewer = builtIns().find(preset => preset.id === 'reviewer')!
		const qa = { id: 'qa', name: 'QA', keys: ['workspace.read', 'reviews.write'] }
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: await revision(ctx.app), presets: [...builtIns(), qa] })).toMatchObject({ status: 200 })
		const before = await readFile(ctx.presetsPath)
		const refused = await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: await revision(ctx.app), presets: [...builtIns(), { ...qa, keys: reviewer.keys }] })
		expect(refused).toMatchObject({ status: 400, body: { status: 'invalid', code: 'access.preset_duplicate' } })
		expect((refused.body as { message: string }).message).toContain('"Reviewer" (reviewer) and "QA" (qa)')
		expect(await readFile(ctx.presetsPath)).toEqual(before)
	})
})

describe('labels and --preset from the Workspace\'s presets (Rules 01a11c09-c724, 01a11c09-ca2d, 01a11c09-ca9b, 01a11c33-265e and 01a11c09-cb79)', () => {
	it('reads the built-in presets below schemaVersion 6 and the presets file from 6, first match first and unknown keys labeling nobody', async () => {
		const old = await makeRoot()
		await writeManifest(old, canonicalJsonBytes(v5Manifest()), V5_LAYOUT)
		expect(await readWorkspaceAccessPresets(old)).toBe(BUILT_IN_ACCESS_PRESETS)

		const ctx = await workspace()
		expect(await readWorkspaceAccessPresets(ctx.root)).toEqual(builtIns())
		const viewerKeys = builtIns()[0]!.keys
		const presets = [
			{ id: 'readers', name: 'Readers', keys: viewerKeys },
			{ id: 'viewer', name: 'Viewer', keys: viewerKeys },
			{ id: 'future', name: 'Future', keys: [...builtIns()[1]!.keys, 'future.capability'] },
		]
		await writeFile(ctx.presetsPath, JSON.stringify({ presets }))
		const read = await readWorkspaceAccessPresets(ctx.root)
		expect(read.map(preset => preset.id)).toEqual(['readers', 'viewer', 'future'])
		expect(memberLabel({ kind: 'human', keys: viewerKeys }, read)).toEqual({ preset: { id: 'readers', name: 'Readers' } })
		expect(memberLabel({ kind: 'human', keys: [...builtIns()[1]!.keys, 'future.capability'] }, read)).toEqual({ custom: true })

		// A missing or unreadable presets file at schemaVersion 6 gives no presets: every member is Custom.
		await rm(ctx.presetsPath)
		expect(await readWorkspaceAccessPresets(ctx.root)).toEqual([])
		await symlink(join(old, 'workspace.json'), ctx.presetsPath)
		expect(await readWorkspaceAccessPresets(ctx.root)).toEqual([])
	})

	it('labels sessions and Tokens from the presets file, so editing a preset changes labels only, never keys', async () => {
		const ctx = await workspace()
		const home = join(await makeRoot('uiux-access-presets-home-'), 'home')
		const store = (await AccessStore.open({ workspaceRoot: ctx.root, home, create: true }))!
		await store.update(file => addMember(file, { nickname: 'mei', keys: keysOfPreset('human', builtIns()[1]!.keys), kind: 'human' }))
		const service = new AccessService({ store, leases: createLeaseManager(), presets: () => readWorkspaceAccessPresets(ctx.root) })
		const member = store.data.members[0]!
		expect(memberPrincipal(member, 'session', 's', await service.presets()).label).toEqual({ preset: { id: 'reviewer', name: 'Reviewer' } })

		const renamed = builtIns().map(preset => preset.id === 'reviewer' ? { ...preset, name: 'Critic' } : preset)
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: await revision(ctx.app), presets: renamed })).toMatchObject({ status: 200 })
		expect(memberPrincipal(member, 'session', 's', await service.presets()).label).toEqual({ preset: { id: 'reviewer', name: 'Critic' } })
		await service.refresh(true)
		expect(store.data.members[0]!.keys).toEqual(member.keys)

		const withoutReviewer = builtIns().filter(preset => preset.id !== 'reviewer')
		expect(await updateAccessPresetsForHttp(http(ctx.app, OWNER), { expectedRevision: await revision(ctx.app), presets: withoutReviewer })).toMatchObject({ status: 200 })
		expect(memberPrincipal(member, 'session', 's', await service.presets()).label).toEqual({ custom: true })
	})

	it('resolves --preset against the presets file at that moment, failing with the available names, and lists labels from it (Rule 01a11c09-ccc6)', async () => {
		const base = await makeRoot()
		const root = join(base, 'ws')
		await writeCurrentWorkspace(root)
		const home = join(base, 'home')
		const run = async (...argv: string[]) => {
			const out: string[] = []
			const err: string[] = []
			const code = await runAccessCommand({ argv, env: { UIUX_HOME: home }, cwd: base, stdout: line => out.push(line), stderr: line => err.push(line) })
			return { code, out: out.join('\n'), err: err.join('\n') }
		}
		const lead = { id: 'lead', name: 'Lead', keys: ['workspace.read', 'history.read', 'views.write', 'future.capability'] }
		await writeFile(join(root, ACCESS_PRESETS_FILENAME), JSON.stringify({ presets: [...builtIns().filter(preset => preset.id !== 'reviewer'), lead] }))

		expect(await run('member', 'add', 'deviltea', '--preset', 'owner', '--workspace', root)).toMatchObject({ code: 0, out: expect.stringContaining('(Owner, 22 keys)') })
		expect(await run('member', 'add', 'mei', '--preset', 'Reviewer', '--workspace', root)).toMatchObject({ code: 1, err: expect.stringContaining('The presets are Viewer, Editor, Owner, Lead.') })
		// A preset key this version does not know is never applied; the member is then Custom.
		const added = await run('member', 'add', 'lee', '--preset', 'Lead', '--workspace', root)
		expect(added).toMatchObject({ code: 0, out: expect.stringContaining('(Custom, 3 keys)') })
		expect(added.out).toContain('The Lead preset holds future.capability, unknown to this UIUX version; it was not applied.')
		await writeFile(join(root, ACCESS_PRESETS_FILENAME), JSON.stringify({ presets: [...builtIns(), { ...lead, keys: lead.keys.slice(0, 3) }] }))
		const list = await run('member', 'list', '--workspace', root)
		expect(list.out).toMatch(/lee\s+human\s+Lead\s+/u)
		expect(list.out).toMatch(/deviltea\s+human\s+Owner\s+/u)
	})
})
