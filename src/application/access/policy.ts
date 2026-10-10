import { inCatalogOrder, isHumanOnlyKey, writeKeyForKind, type PermissionKey } from './keys'
import type { AccessRole, MemberPrincipal, Principal } from './principal'

/**
 * The permission policy as data, shared by `/api/*` and `/mcp`: each operation declares the
 * permission keys it needs (Clauses 01a11485-fa00-72da-bc46-98302a3c106e,
 * 01a11485-fa21-7b77-8ae5-1d7d0618e8a3, 01a11485-fa44-7b6a-99f8-de4e1e8edcfc,
 * 01a11bb1-b35a-7e69-bba5-978e3f47c4fa and 01a11485-fa66-7cde-a10f-b8b796d01469). A member may do
 * exactly what its keys allow: no key implies another, and an operation checks only its own keys
 * (Rule 01a11485-eaac-7523-998b-26123d7618df).
 *
 * - `requiredKeys`: the keys the operation needs; an operation that needs none is open to every member.
 * - `sessionOnly`: a Workbench cookie session only; bearer Tokens are refused.
 * - `system`: on the system credential allowlist (Clause 01a11c09-a3bb-7ad4-a889-d50b124d3679).
 *
 * A `humanOnly` key (Clause 01a11c09-a26e-73bb-9a29-eed40aae37bd) takes effect only on its human
 * holder's cookie session (Rule 01a11c09-bec8-7dee-971a-4c10eaf83eef), so an operation needing one
 * is human-only and session-only without a flag of its own.
 */
export type OperationRule = Readonly<{
	requiredKeys: readonly PermissionKey[]
	sessionOnly?: boolean
	system?: boolean
}>

export const ACCESS_OPERATIONS = {
	// `workspace.read`: reads, Preview, Evidence, artifacts, Handoff readiness, the lease list.
	readPointResource: { requiredKeys: ['workspace.read'], system: true },
	listPointResources: { requiredKeys: ['workspace.read'], system: true },
	searchPointResources: { requiredKeys: ['workspace.read'], system: true },
	listEvidence: { requiredKeys: ['workspace.read'], system: true },
	readArtifact: { requiredKeys: ['workspace.read'], system: true },
	readAssetContent: { requiredKeys: ['workspace.read'], system: true },
	readPreview: { requiredKeys: ['workspace.read'], system: true },
	assessHandoffReadiness: { requiredKeys: ['workspace.read'] },
	listLeases: { requiredKeys: ['workspace.read'] },
	// `history.read`: version history reads, which a system credential never gets (Clause 01a11485-f978-767a-b977-33028aee7ae7).
	diffVersions: { requiredKeys: ['history.read'] },
	listVersions: { requiredKeys: ['history.read'] },
	readVersion: { requiredKeys: ['history.read'] },
	// The version reads for Preview: a version's manifest, View and Locales, and its blobs by digest.
	readVersionForPreview: { requiredKeys: ['history.read'] },
	// The session routes need no key, for cookie sessions only (Clause 01a11485-faa9-74fe-8e0a-068cd770ff1c).
	readSession: { requiredKeys: [], sessionOnly: true },
	endSession: { requiredKeys: [], sessionOnly: true },
	// Review actions (actor stamped). Authorship (and, for retract, engagement) is checked in the
	// domain service, not here (Rule 01a11544-5a05-7750-9268-fd666980dd2f).
	createReviewThread: { requiredKeys: ['reviews.write'] },
	appendReviewMessage: { requiredKeys: ['reviews.write'] },
	reanchorReviewThread: { requiredKeys: ['reviews.write'] },
	setReviewDisplayHint: { requiredKeys: ['reviews.write'] },
	editReviewMessage: { requiredKeys: ['reviews.write'] },
	retractReviewThread: { requiredKeys: ['reviews.write'] },
	submitReadyForReview: { requiredKeys: ['reviews.submit'] },
	reopenReviewThread: { requiredKeys: ['reviews.submit'] },
	promoteReviewToDecision: { requiredKeys: ['reviews.promote'] },
	// Clause 01a11485-fa87-7cf8-8ec1-275793457228; the HTTP refusal order is `resolutionRefusal`.
	resolveReviewThread: { requiredKeys: ['reviews.resolve'] },
	// `checkpoints.create`: humans and Agents, no lease.
	createCheckpoint: { requiredKeys: ['checkpoints.create'] },
	// Authoring, capture and Handoff export.
	createView: { requiredKeys: ['views.write'] },
	updateViewSpec: { requiredKeys: ['views.write'] },
	updateViewStructure: { requiredKeys: ['views.write'] },
	// Below `schemaVersion` 5 a change to the `adapters` list also needs `product-kit.compose`: see `adapterChangeKeys`.
	updateWorkspaceSettings: { requiredKeys: ['settings.write'] },
	createLocale: { requiredKeys: ['locales.write'] },
	updateLocale: { requiredKeys: ['locales.write'] },
	createFlow: { requiredKeys: ['flows.write'] },
	updateFlow: { requiredKeys: ['flows.write'] },
	createAsset: { requiredKeys: ['assets.write'] },
	replaceAsset: { requiredKeys: ['assets.write'] },
	captureFormalEvidence: { requiredKeys: ['evidence.capture'] },
	exportHandoff: { requiredKeys: ['handoff.export'] },
	// A restore also needs the restored kind's write key (Rule 01a11c09-c648-71be-a550-2ecabf12f5d0): see `authorizeRestore`.
	restoreResourceVersion: { requiredKeys: ['history.restore'] },
	// Acquiring needs each requested kind's write key (Rule 01a11c09-c125-752e-aa98-b4c063b2b7fb): see
	// `authorizeLeaseAcquire`. Releasing one's own leases needs no key.
	acquireLeases: { requiredKeys: [] },
	releaseLeases: { requiredKeys: [] },
	forceReleaseLease: { requiredKeys: ['locks.force-release'] },
	// Offered in the Workbench only.
	deleteCheckpoint: { requiredKeys: ['checkpoints.delete'] },
	// Served only on a loopback origin or an `https` configured origin (Rule 01a12500-b105-7773-822f-359d4dcbd1da);
	// the HTTP layer refuses every other origin before this rule runs (Clause 01a12500-a619-7fa5-b7f6-797adaf52f34).
	administerAccess: { requiredKeys: ['members.manage'] },
} as const satisfies Record<string, OperationRule>

export type AccessOperation = keyof typeof ACCESS_OPERATIONS

/**
 * Clause 01a11485-f9bd-78a3-a1d0-1b4f64e9883e: a permission refusal names the keys the request
 * lacks. A system credential lacks every key the operation needs; a refusal for the credential
 * type alone (a session-only operation over a bearer Token) lacks none.
 */
export type ScopeDenied = Readonly<{
	code: 'auth.scope_denied'
	requiredKeys: readonly PermissionKey[]
	message: string
}>

const ROLE_LABEL: Readonly<Record<AccessRole, string>> = { viewer: 'Viewer', reviewer: 'Reviewer', editor: 'Editor', owner: 'Owner' }

export function roleLabel(role: AccessRole): string {
	return ROLE_LABEL[role]
}

/**
 * The keys that take effect for this request: a system credential holds none (Clause
 * 01a114ec-ea96-764e-876b-464e3319b3db), and a `humanOnly` key counts only on a human member's
 * cookie session (Rule 01a11c09-bec8-7dee-971a-4c10eaf83eef).
 */
export function effectiveKeys(principal: Principal): readonly PermissionKey[] {
	if (principal.type === 'system') return []
	if (principal.kind === 'human' && principal.credential === 'session') return principal.keys
	return principal.keys.filter(key => !isHumanOnlyKey(key))
}

function list(keys: readonly string[]): string {
	return keys.map(key => `\`${key}\``).join(', ')
}

function missingKeysMessage(principal: MemberPrincipal, operation: string, missing: readonly PermissionKey[]): string {
	const plural = missing.length > 1
	const parts = [`${operation} requires the permission key${plural ? 's' : ''} ${list(missing)}; ${principal.nickname} lacks ${plural ? 'them' : 'it'}.`]
	const humanOnly = missing.filter(isHumanOnlyKey)
	if (humanOnly.length > 0) {
		if (principal.kind === 'agent')
			parts.push(`${list(humanOnly)} ${humanOnly.length > 1 ? 'are' : 'is'} humanOnly: an Agent never holds ${humanOnly.length > 1 ? 'them' : 'it'}.`)
		else if (principal.credential !== 'session' && humanOnly.some(key => principal.keys.includes(key)))
			parts.push(`${list(humanOnly)} ${humanOnly.length > 1 ? 'are' : 'is'} humanOnly and takes effect only on a signed-in Workbench session; a bearer Token acts without ${humanOnly.length > 1 ? 'them' : 'it'}.`)
	}
	return parts.join(' ')
}

/**
 * Returns `undefined` when the principal may perform the operation, otherwise the
 * `auth.scope_denied` refusal. `additionalKeys` are keys this request needs beyond the
 * operation's own, such as a restored kind's write key.
 */
export function authorizeOperation(principal: Principal, operation: AccessOperation, additionalKeys: readonly PermissionKey[] = []): ScopeDenied | undefined {
	const rule: OperationRule = ACCESS_OPERATIONS[operation]
	const needed = inCatalogOrder([...rule.requiredKeys, ...additionalKeys])
	if (principal.type === 'system') {
		return rule.system && additionalKeys.length === 0
			? undefined
			: { code: 'auth.scope_denied', requiredKeys: needed, message: `${operation} is not available to the internal ${principal.id} credential.` }
	}
	const held = new Set(effectiveKeys(principal))
	const missing = needed.filter(key => !held.has(key))
	if (missing.length > 0)
		return { code: 'auth.scope_denied', requiredKeys: missing, message: missingKeysMessage(principal, operation, missing) }
	if (rule.sessionOnly && principal.credential !== 'session')
		return { code: 'auth.scope_denied', requiredKeys: [], message: `${operation} requires a signed-in Workbench session; bearer tokens cannot perform it.` }
	return undefined
}

/**
 * Rule 01a11c09-c648-71be-a550-2ecabf12f5d0: a restore needs `history.restore` and the restored
 * kind's write key, so `history.restore` never stands in for a missing write key. A kind with no
 * write key adds none here; the service refuses it as not restorable.
 */
export function authorizeRestore(principal: Principal, kind: string): ScopeDenied | undefined {
	const writeKey = writeKeyForKind(kind)
	return authorizeOperation(principal, 'restoreResourceVersion', writeKey ? [writeKey] : [])
}

/** Rule 01a11c09-c125-752e-aa98-b4c063b2b7fb: acquiring needs the write key of each requested resource's kind. */
export function authorizeLeaseAcquire(principal: Principal, kinds: readonly string[]): ScopeDenied | undefined {
	return authorizeOperation(principal, 'acquireLeases', kinds.flatMap(kind => writeKeyForKind(kind) ?? []))
}

/** The `schemaVersion` from which the `adapters` list leaves the manifest for the Product Kit file. */
const PRODUCT_KIT_SCHEMA_VERSION = 5

/**
 * Clause 01a11bb1-b35a-7e69-bba5-978e3f47c4fa, below `schemaVersion` 5: an
 * `update_workspace_settings` that adds, removes, reorders or re-points an `adapters` entry also
 * needs `product-kit.compose`. A change to an entry's `config` alone is not one.
 */
export function adapterChangeKeys(
	schemaVersion: number,
	current: readonly Readonly<{ moduleSpecifier: string }>[],
	next: readonly Readonly<{ moduleSpecifier: string }>[],
): readonly PermissionKey[] {
	if (schemaVersion >= PRODUCT_KIT_SCHEMA_VERSION) return []
	const same = current.length === next.length && current.every((entry, index) => entry.moduleSpecifier === next[index]!.moduleSpecifier)
	return same ? [] : ['product-kit.compose']
}
