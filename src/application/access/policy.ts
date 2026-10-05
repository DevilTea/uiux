import { principalRole, roleAtLeast, type AccessRole, type Principal } from './principal'

/**
 * The permission matrix (accepted identity decision group, *Permission matrix*) as data, shared
 * by `/api/*` and `/mcp`. Roles are cumulative: Viewer ⊂ Reviewer ⊂ Editor ⊂ Owner.
 *
 * - `humanOnly` (H): members of kind `human` only.
 * - `sessionOnly` (S): a Workbench cookie session only; bearer tokens are refused.
 * - `loopbackOnly` (L): the loopback listener only (the only listener that ships).
 * - `system`: the in-memory system principals (`system:capture`, `system:publish`) may call it.
 */
export type OperationRule = Readonly<{
	minRole: AccessRole
	humanOnly?: boolean
	sessionOnly?: boolean
	loopbackOnly?: boolean
	system?: boolean
}>

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
	resolveReviewThread: { minRole: 'reviewer', humanOnly: true, sessionOnly: true },
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
