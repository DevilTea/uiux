import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager } from '../src/application/access/leases'
import { ACCESS_OPERATIONS, authorizeOperation, HUMAN_ONLY_PERMISSION_KEYS, PERMISSION_KEYS, type AccessOperation } from '../src/application/access/policy'
import { ACCESS_ROLES, MEMBER_KINDS, principalActor, type AccessRole, type MemberPrincipal, type SystemPrincipal } from '../src/application/access/principal'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { FileNativePersistence } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { appendReviewMessageForHttp, createViewForHttp, resolveReviewThreadForHttp, submitReadyForReviewForHttp, updateViewSpecForHttp } from '../src/server/authoring-http'
import { connectMcp, scoped, testMember } from './support/access'

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

/**
 * The accepted permission matrix, written out independently of `ACCESS_OPERATIONS` so a change
 * to the policy data cannot silently pass. `H` human only, `S` cookie session only, `L` loopback.
 */
const MATRIX: Readonly<Record<AccessOperation, Readonly<{ min: AccessRole; H?: true; S?: true; L?: true; system?: true }>>> = {
	readPointResource: { min: 'viewer', system: true },
	listPointResources: { min: 'viewer', system: true },
	searchPointResources: { min: 'viewer', system: true },
	listEvidence: { min: 'viewer', system: true },
	readArtifact: { min: 'viewer', system: true },
	readAssetContent: { min: 'viewer', system: true },
	readPreview: { min: 'viewer', system: true },
	readPublicationSnapshot: { min: 'viewer', system: true },
	assessHandoffReadiness: { min: 'viewer' },
	listLeases: { min: 'viewer' },
	diffVersions: { min: 'viewer' },
	listVersions: { min: 'viewer' },
	readVersion: { min: 'viewer' },
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
	acquireLeases: { min: 'editor' },
	releaseLeases: { min: 'editor' },
	forceReleaseLease: { min: 'owner', H: true, S: true },
	deleteCheckpoint: { min: 'owner', H: true, S: true },
	administerAccess: { min: 'owner', H: true, S: true, L: true },
}

const rank = (role: AccessRole) => ACCESS_ROLES.indexOf(role)

describe('permission matrix (role × operation)', () => {
	it('covers every operation in the policy data', () => {
		expect(Object.keys(ACCESS_OPERATIONS).sort()).toEqual(Object.keys(MATRIX).sort())
	})

	const principals: MemberPrincipal[] = []
	for (const role of ACCESS_ROLES)
		for (const kind of MEMBER_KINDS)
			for (const credential of ['session', 'token'] as const)
				principals.push(testMember({ nickname: `${kind}-${role}-${credential}`, role, kind, credential }))

	for (const [operation, rule] of Object.entries(MATRIX) as [AccessOperation, typeof MATRIX[AccessOperation]][]) {
		it(`${operation}: ${rule.min}${rule.H ? ' + human' : ''}${rule.S ? ' + session' : ''}${rule.L ? ' + loopback' : ''}`, () => {
			for (const principal of principals) {
				// Agents are capped at Editor whatever the roster says.
				const effective = principal.kind === 'agent' && principal.role === 'owner' ? 'editor' : principal.role
				const allowed = rank(effective) >= rank(rule.min) && (!rule.H || principal.kind === 'human') && (!rule.S || principal.credential === 'session')
				const denied = authorizeOperation(principal, operation)
				expect(denied === undefined, `${operation} as ${principal.nickname}`).toBe(allowed)
				if (denied) expect(denied).toMatchObject({ code: 'auth.scope_denied', requiredRole: rule.min })
			}
			for (const id of ['system:capture', 'system:publish'] as const) {
				const system: SystemPrincipal = { type: 'system', id, role: 'viewer', credential: 'system' }
				expect(authorizeOperation(system, operation) === undefined, `${operation} as ${id}`).toBe(rule.system === true)
			}
		})
	}
})

/**
 * Clause 01a11c09-a930-7e31-bb0a-9e2bee79490c, transcribed independently of the policy data: the
 * built-in Access presets in order, each with the keys it adds to the one before it.
 */
const BUILT_IN_PRESETS: readonly Readonly<{ role: AccessRole; adds: readonly string[] }>[] = [
	{ role: 'viewer', adds: ['workspace.read', 'history.read', 'product-kit.source.read'] },
	{ role: 'reviewer', adds: ['reviews.write', 'reviews.submit', 'reviews.promote', 'reviews.resolve', 'checkpoints.create'] },
	{ role: 'editor', adds: ['views.write', 'flows.write', 'locales.write', 'assets.write', 'settings.write', 'product-kit.write', 'product-kit.compose', 'evidence.capture', 'handoff.export', 'history.restore'] },
	{ role: 'owner', adds: ['checkpoints.delete', 'locks.force-release', 'presets.manage', 'members.manage'] },
]

describe('permission-key annotations (seam 5; Clauses 01a11c09-a26e-73bb-9a29-eed40aae37bd and 01a11c09-a930-7e31-bb0a-9e2bee79490c)', () => {
	it('gives every annotated operation the lowest built-in preset that holds its key as its minimum role', () => {
		const annotated = Object.entries(ACCESS_OPERATIONS).flatMap(([operation, rule]) => 'permissionKey' in rule ? [[operation, rule] as const] : [])
		expect(annotated.map(([operation, rule]) => [operation, rule.permissionKey]).sort()).toEqual([
			['createCheckpoint', 'checkpoints.create'],
			['deleteCheckpoint', 'checkpoints.delete'],
			['diffVersions', 'history.read'],
			['listVersions', 'history.read'],
			['readVersion', 'history.read'],
		])
		for (const [operation, rule] of annotated) {
			const lowest = BUILT_IN_PRESETS.find(preset => preset.adds.includes(rule.permissionKey))
			expect(lowest, `${rule.permissionKey} is in a built-in preset`).toBeDefined()
			expect(rule.minRole, operation).toBe(lowest!.role)
			expect(PERMISSION_KEYS).toContain(rule.permissionKey)
			// A humanOnly key is human-only on the operation too.
			expect('humanOnly' in rule && rule.humanOnly === true, operation).toBe(HUMAN_ONLY_PERMISSION_KEYS.includes(rule.permissionKey))
		}
	})

	it('keeps the catalog and the presets consistent: every key is in exactly one preset step', () => {
		expect(BUILT_IN_PRESETS.flatMap(preset => preset.adds).sort()).toEqual([...PERMISSION_KEYS].sort())
	})

	it('refuses every history operation to the system credentials (Clause 01a11485-f978-767a-b977-33028aee7ae7)', () => {
		for (const operation of ['diffVersions', 'listVersions', 'readVersion', 'createCheckpoint', 'deleteCheckpoint'] as const) {
			for (const id of ['system:capture', 'system:publish'] as const)
				expect(authorizeOperation({ type: 'system', id, role: 'viewer', credential: 'system' }, operation), `${operation} as ${id}`).toMatchObject({ code: 'auth.scope_denied' })
		}
	})
})

describe('authorization in the shared application layer', () => {
	it('refuses every write below its role before touching the Workspace, on HTTP and on MCP', async () => {
		const ctx = await fixture()
		const viewer = scoped(ctx.app, testMember({ nickname: 'vera', role: 'viewer' }))
		const reviewer = scoped(ctx.app, testMember({ nickname: 'rui', role: 'reviewer' }))
		const before = await readdir(join(ctx.root, 'views'))

		const create = await createViewForHttp(reviewer, { id: NEW_VIEW_ID, name: 'Nope', spec: spec('x') })
		expect(create.status).toBe(403)
		expect(create.body).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredRole: 'editor' })
		const append = await appendReviewMessageForHttp(viewer, REVIEW_ID, { expectedRevision: ctx.reviewRevision, body: 'hi' })
		expect(append.status).toBe(403)
		expect(append.body).toMatchObject({ code: 'auth.scope_denied', requiredRole: 'reviewer' })
		expect(await viewer.captureFormalEvidence({ contexts: [] })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredRole: 'editor' })
		expect(await reviewer.exportHandoff({ roots: [{ type: 'workspace' }] })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied' })
		expect(viewer.acquireLeases({ resources: [{ kind: 'view', key: VIEW_ID }] })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredRole: 'editor' })
		expect(scoped(ctx.app, testMember({ role: 'editor' })).forceReleaseLease({ kind: 'view', key: VIEW_ID })).toMatchObject({ code: 'auth.scope_denied', requiredRole: 'owner' })
		// Reads are open to every role.
		expect((await viewer.readPointResource('view', VIEW_ID))?.kind).toBe('view')
		expect(await readdir(join(ctx.root, 'views'))).toEqual(before)

		// MCP: every tool stays registered; a role-denied call is an isError tool result.
		const mcp = await connectMcp(ctx.app, testMember({ nickname: 'watcher', kind: 'agent', role: 'viewer', credential: 'token' }))
		try {
			expect((await mcp.client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['create_view', 'acquire_lock', 'resolve_review_thread']))
			const denied = await mcp.client.callTool({ name: 'create_view', arguments: { id: NEW_VIEW_ID, name: 'Nope', spec: spec('x') } })
			expect(denied.isError).toBe(true)
			expect(denied.structuredContent).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredRole: 'editor' })
			const reply = await mcp.client.callTool({ name: 'append_review_message', arguments: { reviewId: REVIEW_ID, expectedRevision: ctx.reviewRevision, body: 'x' } })
			expect(reply.structuredContent).toMatchObject({ code: 'auth.scope_denied', requiredRole: 'reviewer' })
			const listed = await mcp.client.callTool({ name: 'list_resources', arguments: { kinds: ['view'], limit: 5 } })
			expect(listed.isError).not.toBe(true)
		}
		finally { await mcp.close() }
		expect(await readdir(join(ctx.root, 'views'))).toEqual(before)
	})

	it('tells the agent its identity and role in the per-request instructions', async () => {
		const ctx = await fixture()
		const mcp = await connectMcp(ctx.app, testMember({ nickname: 'claude-wt-a', kind: 'agent', role: 'editor', credential: 'token' }))
		try {
			const instructions = mcp.client.getInstructions() ?? ''
			expect(instructions.startsWith('Authenticated as claude-wt-a (agent, editor).')).toBe(true)
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

describe('resolve requires a human member on a Workbench cookie session', () => {
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
		expect(viewer.body).toMatchObject({ code: 'auth.scope_denied', requiredRole: 'reviewer' })
		expect((await ctx.app.readPointResource('review', REVIEW_ID))?.revision).toBe(revision)

		const lead = testMember({ nickname: 'lead', kind: 'human', role: 'reviewer', credential: 'session' })
		const resolved = await attempt(lead)
		expect(resolved.status).toBe(200)
		const read = await ctx.app.readPointResource('review', REVIEW_ID)
		expect(read?.kind === 'review' ? read.resource.history.at(-1) : undefined).toMatchObject({ to: 'resolved', resolution: 'verified', actor: principalActor(lead) })
	})
})

describe('system principals', () => {
	it('may read but never write, and are never members or actors', async () => {
		const ctx = await fixture()
		const capture: SystemPrincipal = { type: 'system', id: 'system:capture', role: 'viewer', credential: 'system' }
		const { createScopedWorkspaceSession } = await import('../src/application/access/scoped-session')
		const session = createScopedWorkspaceSession(ctx.app, capture, { transport: 'http', leases: createLeaseManager() })
		expect((await session.readPointResource('view', VIEW_ID))?.kind).toBe('view')
		expect((await session.listEvidence()).length).toBe(0)
		expect(await session.updateViewSpec({ key: VIEW_ID, expectedRevision: ctx.viewRevision, spec: spec('x') })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied' })
		expect(await session.appendReviewMessage({ reviewId: REVIEW_ID, expectedRevision: ctx.reviewRevision, body: 'x' })).toMatchObject({ code: 'auth.scope_denied' })
		expect(await session.resolveReviewThread({ reviewId: REVIEW_ID, expectedRevision: ctx.reviewRevision, resolution: 'answered' })).toMatchObject({ code: 'auth.scope_denied' })
		expect(await session.assessHandoffReadiness({ roots: [{ type: 'workspace' }] })).toMatchObject({ code: 'auth.scope_denied' })
		expect(session.listLeases).toThrow()
		expect((await updateViewSpecForHttp(session, VIEW_ID, { expectedRevision: ctx.viewRevision, spec: spec('x') })).status).toBe(403)
	})
})
