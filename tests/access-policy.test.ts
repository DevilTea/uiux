import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
	BUILT_IN_ACCESS_PRESETS,
	HUMAN_ONLY_PERMISSION_KEYS,
	isPermissionKeyName,
	keyRequirements,
	keysForRole,
	PERMISSION_KEYS,
	writeKeyForKind,
	type PermissionKey,
} from '../src/application/access/keys'
import { createLeaseManager, LOCKABLE_KINDS } from '../src/application/access/leases'
import {
	ACCESS_OPERATIONS,
	adapterChangeKeys,
	authorizeLeaseAcquire,
	authorizeOperation,
	authorizeRestore,
	effectiveKeys,
	manifestAdapterChangeKeys,
	type AccessOperation,
	type ScopeDenied,
} from '../src/application/access/policy'
import { ACCESS_ROLES, MEMBER_KINDS, principalActor, type AccessRole, type MemberPrincipal, type Principal, type SystemPrincipal } from '../src/application/access/principal'
import { resolutionRefusal } from '../src/application/access/scoped-session'
import { RESTORABLE_RESOURCE_KINDS } from '../src/domain/history/constants'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { FileNativePersistence } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { appendReviewMessageForHttp, createViewForHttp, resolveReviewThreadForHttp, submitReadyForReviewForHttp, updateViewSpecForHttp } from '../src/server/authoring-http'
import { connectMcp, scoped, testMember } from './support/access'
import { manifestPath as workspaceManifestPath } from './support/workspace-layout'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const NEW_VIEW_ID = '22222222-2222-4222-8222-222222222222'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function spec(intent: string): ViewSpecContent {
	return { intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-access-policy-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	const app = createWorkspaceApplicationSession(persistence)
	const view = await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })
	const review = await app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
	if (view.status !== 'created' || review.status !== 'created') throw new Error('fixture')
	return { root, persistence, app, viewRevision: view.revision, reviewRevision: review.revision }
}

const CAPTURE: SystemPrincipal = { type: 'system', id: 'system:capture', credential: 'system' }

/** Every role, member kind and credential, as the live server derives their keys, plus the system credential. */
const PRINCIPALS: readonly Principal[] = [
	...ACCESS_ROLES.flatMap(role => MEMBER_KINDS.flatMap(kind => (['session', 'token'] as const).map(credential =>
		testMember({ nickname: `${kind}-${role}-${credential}`, role, kind, credential })))),
	CAPTURE,
]

function describePrincipal(principal: Principal): string {
	return principal.type === 'system' ? principal.id : principal.nickname
}

/**
 * The role matrix in force before permission keys (code@6a96641 `src/application/access/policy.ts`),
 * frozen here as the parity baseline: roles are cumulative, Agents are capped at Editor, `H` is
 * human only, `S` cookie session only, and `system` the system credential allowlist.
 */
const ROLE_MATRIX: Readonly<Record<AccessOperation, Readonly<{ min: AccessRole; H?: true; S?: true; system?: true }>>> = {
	readPointResource: { min: 'viewer', system: true },
	listPointResources: { min: 'viewer', system: true },
	searchPointResources: { min: 'viewer', system: true },
	listEvidence: { min: 'viewer', system: true },
	readArtifact: { min: 'viewer', system: true },
	readAssetContent: { min: 'viewer', system: true },
	readPreview: { min: 'viewer', system: true },
	assessHandoffReadiness: { min: 'viewer' },
	listLeases: { min: 'viewer' },
	diffVersions: { min: 'viewer' },
	listVersions: { min: 'viewer' },
	readVersion: { min: 'viewer' },
	readVersionForPreview: { min: 'viewer' },
	readSession: { min: 'viewer', S: true },
	endSession: { min: 'viewer', S: true },
	createReviewThread: { min: 'reviewer' },
	appendReviewMessage: { min: 'reviewer' },
	reanchorReviewThread: { min: 'reviewer' },
	submitReadyForReview: { min: 'reviewer' },
	reopenReviewThread: { min: 'reviewer' },
	setReviewDisplayHint: { min: 'reviewer' },
	promoteReviewToDecision: { min: 'reviewer' },
	editReviewMessage: { min: 'reviewer' },
	retractReviewThread: { min: 'reviewer' },
	resolveReviewThread: { min: 'reviewer', H: true, S: true },
	createCheckpoint: { min: 'reviewer' },
	createView: { min: 'editor' },
	updateViewSpec: { min: 'editor' },
	updateViewStructure: { min: 'editor' },
	updateWorkspaceSettings: { min: 'editor' },
	createLocale: { min: 'editor' },
	updateLocale: { min: 'editor' },
	createFlow: { min: 'editor' },
	updateFlow: { min: 'editor' },
	createAsset: { min: 'editor' },
	replaceAsset: { min: 'editor' },
	captureFormalEvidence: { min: 'editor' },
	exportHandoff: { min: 'editor' },
	restoreResourceVersion: { min: 'editor' },
	acquireLeases: { min: 'editor' },
	releaseLeases: { min: 'editor' },
	forceReleaseLease: { min: 'owner', H: true, S: true },
	deleteCheckpoint: { min: 'owner', H: true, S: true },
	administerAccess: { min: 'owner', H: true, S: true },
}

function roleMatrixAllows(principal: Principal, operation: AccessOperation): boolean {
	const rule = ROLE_MATRIX[operation]
	if (principal.type === 'system') return rule.system === true
	const effective = principal.kind === 'agent' && principal.role === 'owner' ? 'editor' : principal.role
	return ACCESS_ROLES.indexOf(effective) >= ACCESS_ROLES.indexOf(rule.min) && (!rule.H || principal.kind === 'human') && (!rule.S || principal.credential === 'session')
}

/**
 * One authorization request: the operation, whose role-matrix decision is the baseline (a restore
 * was also checked against the authoring operation of the restored kind, which needed Editor too),
 * and the key decision.
 */
type ParityCase = Readonly<{ label: string; operation: AccessOperation; decide: (principal: Principal) => ScopeDenied | undefined }>

const RESTORABLE_KINDS = ['view', 'flow', 'locale', 'asset', 'workspace'] as const

const PARITY_CASES: readonly ParityCase[] = [
	// An acquire always names at least one resource, so it is decided per requested kind below.
	...(Object.keys(ACCESS_OPERATIONS) as AccessOperation[]).filter(operation => operation !== 'acquireLeases').map(operation => ({ label: operation, operation, decide: (principal: Principal) => authorizeOperation(principal, operation) })),
	...LOCKABLE_KINDS.map(kind => ({ label: `acquireLeases(${kind})`, operation: 'acquireLeases' as const, decide: (principal: Principal) => authorizeLeaseAcquire(principal, [kind]) })),
	{ label: 'acquireLeases(every kind)', operation: 'acquireLeases', decide: principal => authorizeLeaseAcquire(principal, LOCKABLE_KINDS) },
	...RESTORABLE_KINDS.map(kind => ({ label: `restoreResourceVersion(${kind})`, operation: 'restoreResourceVersion' as const, decide: (principal: Principal) => authorizeRestore(principal, kind) })),
	{ label: 'restoreResourceVersion(workspace, adapters changed)', operation: 'restoreResourceVersion', decide: principal => authorizeRestore(principal, 'workspace', adapterChangeKeys(4, [], [{ moduleSpecifier: '@acme/adapter' }])) },
	{ label: 'updateWorkspaceSettings(adapters changed)', operation: 'updateWorkspaceSettings', decide: principal => authorizeOperation(principal, 'updateWorkspaceSettings', adapterChangeKeys(4, [], [{ moduleSpecifier: '@acme/adapter' }])) },
]

/**
 * The decisions the specification changes on purpose. Rule 01a11c09-c125-752e-aa98-b4c063b2b7fb:
 * releasing one's own leases needs no key, where the role matrix asked for Editor.
 */
const INTENDED_CHANGES: readonly string[] = (['viewer', 'reviewer'] as const).flatMap(role => MEMBER_KINDS.flatMap(kind =>
	(['session', 'token'] as const).map(credential => `releaseLeases as ${kind}-${role}-${credential}: refused → allowed`)))

describe('parity: role-derived keys decide as the role matrix did', () => {
	it('enumerates every operation in the policy data', () => {
		expect(Object.keys(ACCESS_OPERATIONS).sort()).toEqual(Object.keys(ROLE_MATRIX).sort())
	})

	it('gives every role, kind and credential the same decision on every operation, except the changes the specification names', () => {
		const changed: string[] = []
		let compared = 0
		for (const { label, operation, decide } of PARITY_CASES) {
			for (const principal of PRINCIPALS) {
				compared += 1
				const before = roleMatrixAllows(principal, operation)
				const denied = decide(principal)
				const id = `${label} as ${describePrincipal(principal)}`
				if (denied) expect(denied.code, id).toBe('auth.scope_denied')
				if ((denied === undefined) !== before) changed.push(`${id}: ${before ? 'allowed' : 'refused'} → ${denied ? 'refused' : 'allowed'}`)
			}
		}
		// 43 operations, 6 lease acquires, 6 restores and 1 settings adapters change, for 16 members and the system credential.
		expect(compared).toBe(56 * 17)
		expect(changed.sort()).toEqual([...INTENDED_CHANGES].sort())
	})

	it('keeps the HTTP resolve refusals: scope_denied without the key, resolve_requires_workbench for a bearer Token, resolve_requires_human for an Agent session', () => {
		const legacy = (principal: Principal): string | undefined => {
			if (principal.type === 'system') return 'auth.scope_denied'
			const effective = principal.kind === 'agent' && principal.role === 'owner' ? 'editor' : principal.role
			if (ACCESS_ROLES.indexOf(effective) < ACCESS_ROLES.indexOf('reviewer')) return 'auth.scope_denied'
			if (principal.credential !== 'session') return 'review.resolve_requires_workbench'
			if (principal.kind !== 'human') return 'review.resolve_requires_human'
			return undefined
		}
		for (const principal of PRINCIPALS) {
			const refused = resolutionRefusal(principal, 'http', REVIEW_ID, 'verified')
			expect(refused?.code, describePrincipal(principal)).toBe(legacy(principal))
			if (refused?.code === 'auth.scope_denied') expect(refused).toMatchObject({ requiredKeys: ['reviews.resolve'] })
		}
	})
})

/**
 * Clause 01a11c09-a930-7e31-bb0a-9e2bee79490c, transcribed independently of the key data: the
 * built-in Access presets in order, each with the keys it adds to the one before it.
 */
const PRESET_STEPS: readonly Readonly<{ id: AccessRole; name: string; adds: readonly string[] }>[] = [
	{ id: 'viewer', name: 'Viewer', adds: ['workspace.read', 'history.read', 'product-kit.source.read'] },
	{ id: 'reviewer', name: 'Reviewer', adds: ['reviews.write', 'reviews.submit', 'reviews.promote', 'reviews.resolve', 'checkpoints.create'] },
	{ id: 'editor', name: 'Editor', adds: ['views.write', 'flows.write', 'locales.write', 'assets.write', 'settings.write', 'product-kit.write', 'product-kit.compose', 'evidence.capture', 'handoff.export', 'history.restore'] },
	{ id: 'owner', name: 'Owner', adds: ['checkpoints.delete', 'locks.force-release', 'presets.manage', 'members.manage'] },
]

describe('the permission key catalog (Clauses 01a11c09-a26e, 01a11c09-a200, 01a11c09-a2db, 01a11c09-a930, 01a11c09-a42a)', () => {
	it('records the catalog in order, with its humanOnly keys', () => {
		expect(PERMISSION_KEYS).toEqual([
			'workspace.read',
			'history.read',
			'product-kit.source.read',
			'reviews.write',
			'reviews.submit',
			'reviews.promote',
			'reviews.resolve',
			'views.write',
			'flows.write',
			'locales.write',
			'assets.write',
			'settings.write',
			'product-kit.write',
			'product-kit.compose',
			'evidence.capture',
			'handoff.export',
			'checkpoints.create',
			'history.restore',
			'checkpoints.delete',
			'locks.force-release',
			'presets.manage',
			'members.manage',
		])
		expect(HUMAN_ONLY_PERMISSION_KEYS).toEqual(['reviews.resolve', 'checkpoints.delete', 'locks.force-release', 'presets.manage', 'members.manage'])
	})

	it('accepts only `<domain>.<capability>` key names, every segment starting with a lowercase letter', () => {
		for (const key of PERMISSION_KEYS) expect(isPermissionKeyName(key), key).toBe(true)
		for (const name of ['oauth2.read', 'product-kit.source.read', 'a.b', 'kit-v2.read-all'])
			expect(isPermissionKeyName(name), name).toBe(true)
		for (const name of ['views', 'Views.write', 'views.2', '2fa.read', 'views..write', '.views.write', 'views.write.', 'a-.b', 'a--b.c', '-a.b', 'a.-b', 'views_write.x', 'views.write ', 7, null])
			expect(isPermissionKeyName(name), String(name)).toBe(false)
	})

	it('records each key\'s requirements', () => {
		const requirements = Object.fromEntries(PERMISSION_KEYS.map(key => [key, keyRequirements(key)]))
		expect(requirements).toEqual({
			'workspace.read': [],
			'history.read': ['workspace.read'],
			'product-kit.source.read': ['workspace.read'],
			'reviews.write': ['workspace.read'],
			'reviews.submit': ['reviews.write'],
			'reviews.promote': ['reviews.write'],
			'reviews.resolve': ['reviews.write'],
			'views.write': ['workspace.read'],
			'flows.write': ['workspace.read'],
			'locales.write': ['workspace.read'],
			'assets.write': ['workspace.read'],
			'settings.write': ['workspace.read'],
			'product-kit.write': ['product-kit.source.read'],
			'product-kit.compose': ['product-kit.write'],
			'evidence.capture': ['workspace.read'],
			'handoff.export': ['workspace.read'],
			'checkpoints.create': ['history.read'],
			'history.restore': ['history.read'],
			'checkpoints.delete': ['history.read'],
			'locks.force-release': ['workspace.read'],
			'presets.manage': ['workspace.read'],
			'members.manage': ['workspace.read'],
		})
	})

	it('records the built-in presets, each holding every requirement of its keys, and maps a role to the preset with that id', () => {
		let accumulated: string[] = []
		expect(BUILT_IN_ACCESS_PRESETS.map(preset => [preset.id, preset.name])).toEqual(PRESET_STEPS.map(step => [step.id, step.name]))
		for (const [index, step] of PRESET_STEPS.entries()) {
			accumulated = [...accumulated, ...step.adds]
			const preset = BUILT_IN_ACCESS_PRESETS[index]!
			expect(preset.keys).toEqual(PERMISSION_KEYS.filter(key => accumulated.includes(key)))
			for (const key of preset.keys) for (const required of keyRequirements(key)) expect(preset.keys, `${preset.id}: ${key}`).toContain(required)
			expect(keysForRole('human', step.id)).toEqual(preset.keys)
			// Agents never hold a humanOnly key.
			expect(keysForRole('agent', step.id)).toEqual(preset.keys.filter(key => !HUMAN_ONLY_PERMISSION_KEYS.includes(key)))
		}
		expect(PRESET_STEPS.flatMap(step => step.adds).sort()).toEqual([...PERMISSION_KEYS].sort())
		// The Agent cap: an Agent recorded as Owner holds exactly the Editor keys.
		expect(keysForRole('agent', 'owner')).toEqual(keysForRole('agent', 'editor'))
	})

	it('maps each resource kind to its write key', () => {
		expect(['view', 'flow', 'locale', 'asset', 'workspace', 'product-kit', 'access-presets'].map(writeKeyForKind))
			.toEqual(['views.write', 'flows.write', 'locales.write', 'assets.write', 'settings.write', 'product-kit.write', 'presets.manage'])
		for (const kind of ['review', 'toString', '__proto__', '']) expect(writeKeyForKind(kind), kind).toBeUndefined()
	})
})

describe('authorization by permission keys', () => {
	const ALL = PERMISSION_KEYS
	const member = (keys: readonly PermissionKey[], overrides: Partial<Omit<MemberPrincipal, 'type' | 'keys'>> = {}) =>
		testMember({ nickname: 'pat', kind: 'human', credential: 'session', ...overrides, keys })

	it('allows each operation with exactly its keys and refuses it without any one of them, naming that key (Rule 01a11485-eaac)', () => {
		for (const [operation, rule] of Object.entries(ACCESS_OPERATIONS) as [AccessOperation, typeof ACCESS_OPERATIONS[AccessOperation]][]) {
			// A per-resource operation is authorized with the keys of its resources (see the fail-closed test).
			if ('perResourceKeys' in rule) continue
			expect(authorizeOperation(member(rule.requiredKeys), operation), operation).toBeUndefined()
			for (const key of rule.requiredKeys) {
				const denied = authorizeOperation(member(ALL.filter(held => held !== key)), operation)
				expect(denied, `${operation} without ${key}`).toMatchObject({ code: 'auth.scope_denied', requiredKeys: [key] })
				expect(denied!.message).toContain(`\`${key}\``)
			}
		}
	})

	it('fails closed on an unknown operation, a per-resource operation named alone, and a kind with no write key', () => {
		const owner = member(ALL)
		expect(authorizeOperation(owner, 'dropDatabase' as AccessOperation)).toMatchObject({ code: 'auth.scope_denied', requiredKeys: [] })
		expect(authorizeOperation(owner, 'toString' as AccessOperation)).toMatchObject({ code: 'auth.scope_denied', requiredKeys: [] })
		expect(authorizeOperation(owner, 'acquireLeases')).toMatchObject({ code: 'auth.scope_denied', requiredKeys: [] })
		expect(authorizeLeaseAcquire(owner, [])).toMatchObject({ code: 'auth.scope_denied', requiredKeys: [] })
		expect(authorizeLeaseAcquire(owner, ['view', 'review'])).toMatchObject({ code: 'auth.scope_denied', requiredKeys: [] })
		expect(authorizeLeaseAcquire(owner, ['view'])).toBeUndefined()
		for (const kind of ['review', '', '__proto__']) expect(authorizeRestore(owner, kind), kind).toMatchObject({ code: 'auth.scope_denied', requiredKeys: [] })
		// Every kind a restore can write has a write key.
		for (const kind of RESTORABLE_RESOURCE_KINDS) expect(writeKeyForKind(kind), kind).toBeDefined()
	})

	it('checks only the operation\'s own keys: no key implies another', () => {
		// Every key but `views.write` grants no View write; `views.write` alone grants it, without even `workspace.read`.
		expect(authorizeOperation(member(ALL.filter(key => key !== 'views.write')), 'updateViewSpec')).toMatchObject({ requiredKeys: ['views.write'] })
		expect(authorizeOperation(member(['views.write']), 'updateViewSpec')).toBeUndefined()
		expect(authorizeOperation(member(['views.write']), 'readPointResource')).toMatchObject({ requiredKeys: ['workspace.read'] })
		expect(authorizeOperation(member(['workspace.read', 'members.manage']), 'createView')).toMatchObject({ requiredKeys: ['views.write'] })
	})

	it('names every missing key in catalog order', () => {
		expect(authorizeRestore(member(['workspace.read']), 'view')).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['views.write', 'history.restore'] })
		expect(authorizeLeaseAcquire(member(['locales.write']), ['view', 'locale', 'flow', 'view'])).toMatchObject({ requiredKeys: ['views.write', 'flows.write'] })
	})

	it('honors a humanOnly key only on a human member\'s cookie session (Rule 01a11c09-bec8)', () => {
		for (const key of HUMAN_ONLY_PERMISSION_KEYS) {
			const operations = (Object.keys(ACCESS_OPERATIONS) as AccessOperation[]).filter(operation => (ACCESS_OPERATIONS[operation].requiredKeys as readonly string[]).includes(key))
			for (const operation of operations) {
				expect(authorizeOperation(member(ALL), operation), `${operation} on a session`).toBeUndefined()
				const token = authorizeOperation(member(ALL, { credential: 'token' }), operation)
				expect(token, `${operation} with a Token`).toMatchObject({ code: 'auth.scope_denied', requiredKeys: [key] })
				expect(token!.message).toContain('signed-in Workbench session')
				// A hand-written Agent record holding the key still never uses it.
				const agent = authorizeOperation(member(ALL, { kind: 'agent' }), operation)
				expect(agent, `${operation} by an Agent`).toMatchObject({ code: 'auth.scope_denied', requiredKeys: [key] })
				expect(agent!.message).toContain('an Agent never holds')
			}
		}
		expect(effectiveKeys(member(ALL))).toEqual(ALL)
		expect(effectiveKeys(member(ALL, { credential: 'token' }))).toEqual(ALL.filter(key => !HUMAN_ONLY_PERMISSION_KEYS.includes(key)))
		expect(effectiveKeys(member(ALL, { kind: 'agent', credential: 'session' }))).toEqual(ALL.filter(key => !HUMAN_ONLY_PERMISSION_KEYS.includes(key)))
	})

	it('serves the session routes to any cookie session with no key, and refuses them to bearer Tokens', () => {
		for (const operation of ['readSession', 'endSession'] as const) {
			expect(authorizeOperation(member([]), operation)).toBeUndefined()
			expect(authorizeOperation(member(ALL, { credential: 'token' }), operation)).toMatchObject({ code: 'auth.scope_denied', requiredKeys: [] })
		}
	})

	it('gives the system credential no key and only its allowlist (Clauses 01a114ec-ea96, 01a11c09-a3bb, 01a11485-f978)', () => {
		expect(effectiveKeys(CAPTURE)).toEqual([])
		const allowed = (Object.keys(ACCESS_OPERATIONS) as AccessOperation[]).filter(operation => authorizeOperation(CAPTURE, operation) === undefined)
		expect(allowed.sort()).toEqual(['listEvidence', 'listPointResources', 'readArtifact', 'readAssetContent', 'readPointResource', 'readPreview', 'searchPointResources'])
		for (const operation of ['diffVersions', 'listVersions', 'readVersion', 'readVersionForPreview', 'createCheckpoint', 'deleteCheckpoint'] as const)
			expect(authorizeOperation(CAPTURE, operation), operation).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ACCESS_OPERATIONS[operation].requiredKeys })
		expect(authorizeRestore(CAPTURE, 'view')).toMatchObject({ code: 'auth.scope_denied' })
		expect(authorizeLeaseAcquire(CAPTURE, ['view'])).toMatchObject({ code: 'auth.scope_denied' })
	})

	it('needs product-kit.compose for an adapters change below schemaVersion 5 (Clause 01a11bb1-b35a)', () => {
		const a = { moduleSpecifier: '@acme/a', config: { dense: true } }
		const b = { moduleSpecifier: './adapters/b.ts' }
		expect(adapterChangeKeys(4, [a, b], [a, b])).toEqual([])
		const reconfigured = { ...a, config: { dense: false } }
		expect(adapterChangeKeys(4, [a, b], [reconfigured, b])).toEqual([])
		expect(adapterChangeKeys(4, [a], [a, b])).toEqual(['product-kit.compose'])
		expect(adapterChangeKeys(4, [a, b], [a])).toEqual(['product-kit.compose'])
		expect(adapterChangeKeys(4, [a, b], [b, a])).toEqual(['product-kit.compose'])
		expect(adapterChangeKeys(4, [a], [{ moduleSpecifier: '@acme/c' }])).toEqual(['product-kit.compose'])
		expect(adapterChangeKeys(5, [a], [b])).toEqual([])
	})

	it('treats a missing or non-numeric manifest schemaVersion as below 5, so an adapters change needs product-kit.compose', () => {
		const before = { adapters: [{ moduleSpecifier: '@acme/a' }] }
		const after = { adapters: [{ moduleSpecifier: '@acme/b' }] }
		for (const schemaVersion of [undefined, null, '5', '6', 5.5, Number.NaN, true, {}, [5]]) {
			const label = String(JSON.stringify(schemaVersion))
			expect(manifestAdapterChangeKeys({ ...before, schemaVersion }, { ...after, schemaVersion }), label).toEqual(['product-kit.compose'])
		}
		expect(manifestAdapterChangeKeys(before, after)).toEqual(['product-kit.compose'])
		expect(manifestAdapterChangeKeys(undefined, after)).toEqual(['product-kit.compose'])
		// The written manifest's version decides; the replaced one's stands in only when it has none.
		expect(manifestAdapterChangeKeys({ ...before, schemaVersion: 5 }, { ...after, schemaVersion: '5' })).toEqual(['product-kit.compose'])
		expect(manifestAdapterChangeKeys({ ...before, schemaVersion: 4 }, { ...after, schemaVersion: 5 })).toEqual([])
		expect(manifestAdapterChangeKeys({ ...before, schemaVersion: 5 }, after)).toEqual([])
		// A non-array adapters list is empty, so adding a first entry is a change.
		expect(manifestAdapterChangeKeys({ adapters: 'none' }, after)).toEqual(['product-kit.compose'])
		expect(manifestAdapterChangeKeys({ ...before, schemaVersion: 4 }, { ...before, schemaVersion: 4 })).toEqual([])
	})
})

describe('authorization in the shared application layer', () => {
	it('refuses every write without its key before touching the Workspace', async () => {
		const ctx = await fixture()
		const viewer = scoped(ctx.app, testMember({ nickname: 'vera', role: 'viewer' }))
		const reviewer = scoped(ctx.app, testMember({ nickname: 'rui', role: 'reviewer' }))
		const before = await readdir(join(ctx.root, 'views'))

		const create = await createViewForHttp(reviewer, { id: NEW_VIEW_ID, name: 'Nope', spec: spec('x') })
		expect(create.status).toBe(403)
		expect(create.body).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['views.write'] })
		const append = await appendReviewMessageForHttp(viewer, REVIEW_ID, { expectedRevision: ctx.reviewRevision, body: 'hi' })
		expect(append.status).toBe(403)
		expect(append.body).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['reviews.write'] })
		expect(await viewer.captureFormalEvidence({ contexts: [] })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['evidence.capture'] })
		expect(await reviewer.exportHandoff({ roots: [{ type: 'workspace' }] })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['handoff.export'] })
		expect(viewer.acquireLeases({ resources: [{ kind: 'view', key: VIEW_ID }] })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['views.write'] })
		expect(scoped(ctx.app, testMember({ role: 'editor' })).forceReleaseLease({ kind: 'view', key: VIEW_ID })).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['locks.force-release'] })
		// Reads need only `workspace.read`, which every role holds.
		expect((await viewer.readPointResource('view', VIEW_ID))?.kind).toBe('view')
		expect(await readdir(join(ctx.root, 'views'))).toEqual(before)
	})

	it('keeps every tool listed whatever the keys and refuses one the keys do not allow, naming the missing key (Scenario 01a118a1-cecf)', async () => {
		const ctx = await fixture()
		const before = await readdir(join(ctx.root, 'views'))
		const full = await connectMcp(ctx.app, testMember({ nickname: 'full', kind: 'agent', role: 'editor', credential: 'token' }))
		const everyTool = await (async () => {
			try { return (await full.client.listTools()).tools.map(tool => tool.name) }
			finally { await full.close() }
		})()
		const mcp = await connectMcp(ctx.app, testMember({ nickname: 'watcher', kind: 'agent', credential: 'token', keys: ['workspace.read'] }))
		try {
			const names = (await mcp.client.listTools()).tools.map(tool => tool.name)
			expect(names).toEqual(everyTool)
			expect(names).toEqual(expect.arrayContaining(['create_view', 'acquire_lock', 'resolve_review_thread']))
			const denied = await mcp.client.callTool({ name: 'create_view', arguments: { id: NEW_VIEW_ID, name: 'Nope', spec: spec('x') } })
			expect(denied.isError).toBe(true)
			expect(denied.structuredContent).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['views.write'] })
			const reply = await mcp.client.callTool({ name: 'append_review_message', arguments: { reviewId: REVIEW_ID, expectedRevision: ctx.reviewRevision, body: 'x' } })
			expect(reply.structuredContent).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['reviews.write'] })
			const listed = await mcp.client.callTool({ name: 'list_resources', arguments: { kinds: ['view'], limit: 5 } })
			expect(listed.isError).not.toBe(true)
		}
		finally { await mcp.close() }
		expect(await readdir(join(ctx.root, 'views'))).toEqual(before)
	})

	it('lets a translator update a Locale but refuses a View Spec, naming views.write (Scenario 01a11c09-d5ab)', async () => {
		const ctx = await fixture()
		const locale = await ctx.app.createLocale({ locale: 'en-US', messages: { title: 'Pay' } })
		if (locale.status !== 'created') throw new Error('locale')
		const translator = scoped(ctx.app, testMember({ nickname: 'tran', kind: 'human', credential: 'session', keys: ['workspace.read', 'reviews.write', 'locales.write'] }))
		expect(await translator.updateLocale({ locale: 'en-US', expectedRevision: locale.revision, messages: { title: 'Bezahlen' } })).toMatchObject({ status: 'updated' })
		const view = await updateViewSpecForHttp(translator, VIEW_ID, { expectedRevision: ctx.viewRevision, spec: spec('Changed') })
		expect(view.status).toBe(403)
		expect(view.body).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['views.write'] })
		expect((await ctx.app.readPointResource('view', VIEW_ID))?.revision).toBe(ctx.viewRevision)
	})

	it('needs product-kit.compose besides settings.write to change the adapters list, but not for other settings (Clause 01a11bb1-b35a)', async () => {
		const ctx = await fixture()
		const manifestPath = workspaceManifestPath(ctx.root)
		const settingsOnly = scoped(ctx.app, testMember({ nickname: 'sam', kind: 'human', credential: 'session', keys: ['workspace.read', 'settings.write'] }))
		const read = async () => {
			const current = await ctx.app.readPointResource('workspace', 'workspace')
			if (current?.kind !== 'workspace') throw new Error('workspace')
			return current
		}
		const first = await read()
		const resized = await settingsOnly.updateWorkspaceSettings({ expectedRevision: first.revision, settings: { ...first.resource, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } } } })
		expect(resized).toMatchObject({ status: 'updated' })

		const second = await read()
		const bytes = await readFile(manifestPath, 'utf8')
		const withAdapter = { ...second.resource, adapters: [{ moduleSpecifier: '@acme/adapter' }] }
		expect(await settingsOnly.updateWorkspaceSettings({ expectedRevision: second.revision, settings: withAdapter })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['product-kit.compose'] })
		expect(await readFile(manifestPath, 'utf8')).toBe(bytes)
		// A stale revision is a conflict, whatever the adapters say.
		expect(await settingsOnly.updateWorkspaceSettings({ expectedRevision: first.revision, settings: withAdapter })).toMatchObject({ status: 'conflict' })

		const composer = scoped(ctx.app, testMember({ nickname: 'cara', kind: 'human', credential: 'session', keys: ['workspace.read', 'settings.write', 'product-kit.source.read', 'product-kit.write', 'product-kit.compose'] }))
		expect(await composer.updateWorkspaceSettings({ expectedRevision: second.revision, settings: withAdapter })).toMatchObject({ status: 'updated' })
		// A config change of the same entries is a settings change only.
		const third = await read()
		expect(await settingsOnly.updateWorkspaceSettings({ expectedRevision: third.revision, settings: { ...third.resource, adapters: [{ moduleSpecifier: '@acme/adapter', config: { dense: true } }] } })).toMatchObject({ status: 'updated' })
	})

	it('decides the compose check on the manifest the write replaces, even when another write lands between authorization and the write', async () => {
		const ctx = await fixture()
		const read = async () => {
			const current = await ctx.app.readPointResource('workspace', 'workspace')
			if (current?.kind !== 'workspace') throw new Error('workspace')
			return current
		}
		const original = await read()
		const resized = { ...original.resource, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } } }
		// The revision a concurrent viewport edit produces, found by making that edit and undoing it.
		const edited = await ctx.app.updateWorkspaceSettings({ expectedRevision: original.revision, settings: resized })
		if (edited.status !== 'updated') throw new Error('edit')
		expect(await ctx.app.updateWorkspaceSettings({ expectedRevision: edited.revision, settings: original.resource })).toMatchObject({ status: 'updated', revision: original.revision })

		// The concurrent edit lands after the scoped session authorized the request and before the service reads the manifest.
		const racing: WorkspaceApplicationSession = {
			...ctx.app,
			updateWorkspaceSettings: (async (command, guard) => {
				expect(await ctx.app.updateWorkspaceSettings({ expectedRevision: original.revision, settings: resized })).toMatchObject({ status: 'updated', revision: edited.revision })
				return ctx.app.updateWorkspaceSettings(command, guard)
			}) as WorkspaceApplicationSession['updateWorkspaceSettings'],
		}
		const settingsOnly = scoped(racing, testMember({ nickname: 'sam', kind: 'human', credential: 'session', keys: ['workspace.read', 'settings.write'] }))
		const outcome = await settingsOnly.updateWorkspaceSettings({ expectedRevision: edited.revision, settings: { ...resized, adapters: [{ moduleSpecifier: '@acme/adapter' }] } })
		expect(outcome).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['product-kit.compose'] })
		const after = await read()
		expect(after.revision).toBe(edited.revision)
		expect(after.resource.adapters).toEqual([])
	})

	it('tells the agent its identity and role in the per-request instructions', async () => {
		const ctx = await fixture()
		const mcp = await connectMcp(ctx.app, testMember({ nickname: 'claude-wt-a', kind: 'agent', role: 'editor', credential: 'token' }))
		try {
			const instructions = mcp.client.getInstructions() ?? ''
			expect(instructions.startsWith('Authenticated as claude-wt-a (agent, editor).')).toBe(true)
			expect(instructions).toContain('requiredKeys')
			expect(instructions).toContain('acquire_lock')
			expect(instructions).toContain('release_lock')
		}
		finally { await mcp.close() }
	})
})

describe('server-side actor and time stamping', () => {
	it('stamps actor and at from the principal on HTTP, ignoring a supplied actor with auth.actor_ignored and at with auth.time_ignored', async () => {
		const ctx = await fixture()
		const mei = testMember({ nickname: 'mei', role: 'reviewer' })
		const result = await appendReviewMessageForHttp(scoped(ctx.app, mei), REVIEW_ID, {
			expectedRevision: ctx.reviewRevision,
			actor: { type: 'human', id: 'member:spoof', displayName: 'Somebody Else' },
			at: '2001-01-01T00:00:00Z',
			body: 'Padding looks off.',
		})
		expect(result.status).toBe(200)
		const warnings = (result.body as { warnings: { code: string }[] }).warnings.map(item => item.code)
		expect(warnings).toEqual(['auth.actor_ignored', 'auth.time_ignored'])
		const read = await ctx.app.readPointResource('review', REVIEW_ID)
		if (read?.kind !== 'review') throw new Error('review')
		const message = read.resource.messages[0]!
		expect(message.actor).toEqual({ type: 'human', id: `member:${mei.memberId}`, displayName: 'mei' })
		expect(message.at).not.toBe('2001-01-01T00:00:00.000Z')
		expect(Math.abs(Date.parse(message.at) - Date.now())).toBeLessThan(60_000)

		// An omitted actor, or one equal to the stamp, yields no warning.
		const quiet = await appendReviewMessageForHttp(scoped(ctx.app, mei), REVIEW_ID, { expectedRevision: read.revision, actor: principalActor(mei), body: 'Follow-up.' })
		expect(quiet.status).toBe(200)
		expect(quiet.body).not.toHaveProperty('warnings')
	})

	it('stamps agents on /mcp too, so existing prompts that send actor keep working', async () => {
		const ctx = await fixture()
		const claude = testMember({ nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })
		const mcp = await connectMcp(ctx.app, claude)
		try {
			const result = await mcp.client.callTool({ name: 'append_review_message', arguments: { reviewId: REVIEW_ID, expectedRevision: ctx.reviewRevision, actor: { type: 'agent', id: 'agent:claude' }, body: 'On it.' } })
			expect(result.isError).not.toBe(true)
			expect((result.structuredContent as { warnings: { code: string }[] }).warnings.map(item => item.code)).toEqual(['auth.actor_ignored'])
			const read = await ctx.app.readPointResource('review', REVIEW_ID)
			expect(read?.kind === 'review' ? read.resource.messages[0]?.actor : undefined).toEqual({ type: 'agent', id: `member:${claude.memberId}`, displayName: 'claude' })
		}
		finally { await mcp.close() }
	})
})

describe('resolve requires reviews.resolve on a human member\'s Workbench cookie session', () => {
	it('refuses bearer tokens with review.resolve_requires_workbench and agent sessions with review.resolve_requires_human', async () => {
		const ctx = await fixture()
		const evidence = await ctx.persistence.artifacts.put(new TextEncoder().encode('evidence'))
		const ready = await submitReadyForReviewForHttp(scoped(ctx.app, testMember({ kind: 'agent', role: 'editor', credential: 'token' })), REVIEW_ID, {
			expectedRevision: ctx.reviewRevision,
			changeDomains: ['view-structure'],
			resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: ctx.viewRevision }],
			evidenceRefs: [{ kind: 'screenshot', evidence: evidence.identity }],
		})
		expect(ready.status).toBe(200)
		const revision = (ready.body as { revision: string }).revision
		const attempt = (principal: MemberPrincipal) => resolveReviewThreadForHttp(scoped(ctx.app, principal), REVIEW_ID, { expectedRevision: revision, actor: { type: 'human' } })

		expect((await attempt(testMember({ kind: 'human', role: 'owner', credential: 'token' }))).body).toMatchObject({ status: 'blocked', code: 'review.resolve_requires_workbench' })
		expect((await attempt(testMember({ kind: 'agent', role: 'editor', credential: 'token' }))).body).toMatchObject({ code: 'review.resolve_requires_workbench' })
		expect((await attempt(testMember({ kind: 'agent', role: 'editor', credential: 'session' }))).body).toMatchObject({ code: 'review.resolve_requires_human' })
		const viewer = await attempt(testMember({ kind: 'human', role: 'viewer', credential: 'session' }))
		expect(viewer.status).toBe(403)
		expect(viewer.body).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['reviews.resolve'] })
		// A human session holding every other Review key still needs `reviews.resolve` itself.
		const noResolve = await attempt(testMember({ kind: 'human', credential: 'session', keys: ['workspace.read', 'reviews.write', 'reviews.submit', 'reviews.promote'] }))
		expect(noResolve.status).toBe(403)
		expect(noResolve.body).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['reviews.resolve'] })
		expect((await ctx.app.readPointResource('review', REVIEW_ID))?.revision).toBe(revision)

		const lead = testMember({ nickname: 'lead', kind: 'human', credential: 'session', keys: ['reviews.write', 'reviews.resolve'] })
		const resolved = await attempt(lead)
		expect(resolved.status).toBe(200)
		const read = await ctx.app.readPointResource('review', REVIEW_ID)
		expect(read?.kind === 'review' ? read.resource.history.at(-1) : undefined).toMatchObject({ to: 'resolved', resolution: 'verified', actor: principalActor(lead) })
	})
})

describe('system principals', () => {
	it('may read but never write, and are never members or actors', async () => {
		const ctx = await fixture()
		const { createScopedWorkspaceSession } = await import('../src/application/access/scoped-session')
		const session = createScopedWorkspaceSession(ctx.app, CAPTURE, { transport: 'http', leases: createLeaseManager() })
		expect((await session.readPointResource('view', VIEW_ID))?.kind).toBe('view')
		expect((await session.listEvidence()).length).toBe(0)
		expect(await session.updateViewSpec({ key: VIEW_ID, expectedRevision: ctx.viewRevision, spec: spec('x') })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['views.write'] })
		expect(await session.appendReviewMessage({ reviewId: REVIEW_ID, expectedRevision: ctx.reviewRevision, body: 'x' })).toMatchObject({ code: 'auth.scope_denied' })
		expect(await session.resolveReviewThread({ reviewId: REVIEW_ID, expectedRevision: ctx.reviewRevision, resolution: 'answered' })).toMatchObject({ code: 'auth.scope_denied' })
		expect(await session.assessHandoffReadiness({ roots: [{ type: 'workspace' }] })).toMatchObject({ code: 'auth.scope_denied' })
		expect(session.acquireLeases({ resources: [{ kind: 'view', key: VIEW_ID }] })).toMatchObject({ code: 'auth.scope_denied' })
		expect(await session.releaseLeases({})).toMatchObject({ code: 'auth.scope_denied' })
		expect(session.listLeases).toThrow()
		expect((await updateViewSpecForHttp(session, VIEW_ID, { expectedRevision: ctx.viewRevision, spec: spec('x') })).status).toBe(403)
	})
})
