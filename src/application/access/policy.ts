import { principalRole, roleAtLeast, type AccessRole, type Principal } from './principal'

/**
 * The permission matrix (accepted identity decision group, *Permission matrix*) as data, shared
 * by `/api/*` and `/mcp`. Roles are cumulative: Viewer ⊂ Reviewer ⊂ Editor ⊂ Owner.
 *
 * - `humanOnly` (H): members of kind `human` only.
 * - `sessionOnly` (S): a Workbench cookie session only; bearer tokens are refused.
 * - `loopbackOnly` (L): the loopback listener only (the only listener that ships).
 * - `system`: the in-memory system principals (`system:capture`, `system:publish`) may call it.
 * - `permissionKey`: the permission key the operation needs (Clause 01a11c09-a26e-73bb-9a29-eed40aae37bd),
 *   recorded ahead of permission keys (seam 5 of the version timeline). Until keys are built, a
 *   member is authorized by role (Clause 01a11c74-9c83-7d4e-83e4-840d420837a9), so `minRole` is the
 *   lowest built-in preset that holds the key (Clause 01a11c09-a930-7e31-bb0a-9e2bee79490c).
 */
export type OperationRule = Readonly<{
	minRole: AccessRole
	humanOnly?: boolean
	sessionOnly?: boolean
	loopbackOnly?: boolean
	system?: boolean
	permissionKey?: PermissionKey
}>

/** Clause 01a11c09-a26e-73bb-9a29-eed40aae37bd: the permission key catalog, in catalog order. */
export const PERMISSION_KEYS = Object.freeze([
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
] as const)
export type PermissionKey = typeof PERMISSION_KEYS[number]

/** The catalog's `humanOnly` keys (same Clause). */
export const HUMAN_ONLY_PERMISSION_KEYS: readonly PermissionKey[] = Object.freeze(['reviews.resolve', 'checkpoints.delete', 'locks.force-release', 'presets.manage', 'members.manage'])

export const ACCESS_OPERATIONS = {
	// Viewer: reads, Preview, evidence, artifacts, Handoff readiness.
	readPointResource: { minRole: 'viewer', system: true },
	listPointResources: { minRole: 'viewer', system: true },
	searchPointResources: { minRole: 'viewer', system: true },
	listEvidence: { minRole: 'viewer', system: true },
	readArtifact: { minRole: 'viewer', system: true },
	readAssetContent: { minRole: 'viewer', system: true },
	readPreview: { minRole: 'viewer', system: true },
	readPublicationSnapshot: { minRole: 'viewer', system: true },
	assessHandoffReadiness: { minRole: 'viewer' },
	listLeases: { minRole: 'viewer' },
	// Version history reads (`history.read`, Clause 01a11485-fa00-72da-bc46-98302a3c106e) are Viewer
	// reads that a system credential never gets (Clause 01a11485-f978-767a-b977-33028aee7ae7).
	diffVersions: { minRole: 'viewer', permissionKey: 'history.read' },
	listVersions: { minRole: 'viewer', permissionKey: 'history.read' },
	readVersion: { minRole: 'viewer', permissionKey: 'history.read' },
	readSession: { minRole: 'viewer', sessionOnly: true },
	endSession: { minRole: 'viewer', sessionOnly: true },
	// Reviewer: every Review action (actor stamped).
	createReviewThread: { minRole: 'reviewer' },
	appendReviewMessage: { minRole: 'reviewer' },
	reanchorReviewThread: { minRole: 'reviewer' },
	submitReadyForReview: { minRole: 'reviewer' },
	reopenReviewThread: { minRole: 'reviewer' },
	setReviewDisplayHint: { minRole: 'reviewer' },
	promoteReviewToDecision: { minRole: 'reviewer' },
	// Authorship (and, for retract, engagement) is checked in the domain service, not here.
	editReviewMessage: { minRole: 'reviewer' },
	retractReviewThread: { minRole: 'reviewer' },
	resolveReviewThread: { minRole: 'reviewer', humanOnly: true, sessionOnly: true },
	// `checkpoints.create` (Clause 01a11485-fa21-7b77-8ae5-1d7d0618e8a3): humans and Agents, no lease.
	createCheckpoint: { minRole: 'reviewer', permissionKey: 'checkpoints.create' },
	// Editor: authoring, capture, Handoff export, edit leases.
	createView: { minRole: 'editor' },
	updateViewSpec: { minRole: 'editor' },
	updateViewStructure: { minRole: 'editor' },
	updateWorkspaceSettings: { minRole: 'editor' },
	createLocale: { minRole: 'editor' },
	updateLocale: { minRole: 'editor' },
	createFlow: { minRole: 'editor' },
	updateFlow: { minRole: 'editor' },
	createAsset: { minRole: 'editor' },
	replaceAsset: { minRole: 'editor' },
	captureFormalEvidence: { minRole: 'editor' },
	exportHandoff: { minRole: 'editor' },
	acquireLeases: { minRole: 'editor' },
	releaseLeases: { minRole: 'editor' },
	// Owner.
	forceReleaseLease: { minRole: 'owner', humanOnly: true, sessionOnly: true },
	// `checkpoints.delete` (Clause 01a11485-fa66-7cde-a10f-b8b796d01469), a humanOnly key, offered in the Workbench only.
	deleteCheckpoint: { minRole: 'owner', humanOnly: true, sessionOnly: true, permissionKey: 'checkpoints.delete' },
	administerAccess: { minRole: 'owner', humanOnly: true, sessionOnly: true, loopbackOnly: true },
} as const satisfies Record<string, OperationRule>

export type AccessOperation = keyof typeof ACCESS_OPERATIONS

export type ScopeDenied = Readonly<{
	code: 'auth.scope_denied'
	requiredRole: AccessRole
	message: string
}>

const ROLE_LABEL: Readonly<Record<AccessRole, string>> = { viewer: 'Viewer', reviewer: 'Reviewer', editor: 'Editor', owner: 'Owner' }

export function roleLabel(role: AccessRole): string {
	return ROLE_LABEL[role]
}

/** Returns `undefined` when the principal may perform the operation, otherwise the `auth.scope_denied` refusal. */
export function authorizeOperation(principal: Principal, operation: AccessOperation): ScopeDenied | undefined {
	const rule: OperationRule = ACCESS_OPERATIONS[operation]
	const required = rule.minRole
	const deny = (message: string): ScopeDenied => ({ code: 'auth.scope_denied', requiredRole: required, message })
	if (principal.type === 'system') {
		return rule.system ? undefined : deny(`${operation} is not available to the internal ${principal.id} credential.`)
	}
	const role = principalRole(principal)
	if (!roleAtLeast(role, required))
		return deny(`${operation} requires the ${roleLabel(required)} role or above; ${principal.nickname} is ${roleLabel(role)}.`)
	if (rule.humanOnly && principal.kind !== 'human')
		return deny(`${operation} requires a human member; ${principal.nickname} is an agent.`)
	if (rule.sessionOnly && principal.credential !== 'session')
		return deny(`${operation} requires a signed-in Workbench session; bearer tokens cannot perform it.`)
	if (rule.loopbackOnly && principal.listener !== 'loopback')
		return deny(`${operation} is available on the loopback listener only.`)
	return undefined
}
