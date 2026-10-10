import { randomUUID } from 'node:crypto'

import { HISTORY_WRITE_OPERATIONS, isRestorableResourceKind, type HistoryWriteOperation } from '../../domain/history/constants'
import { isFullUuid, type Diagnostic } from '../../domain/validation'
import { runWithDesignWriteContext, type DesignWriteContext } from '../../persistence/history/write-context'
import type { ReviewResolution } from '../../domain/reviews/schema'
import type { PointResourceKind } from '../dto/point-resources'
import type { ResourceDiscoveryOutcome } from '../dto/resource-discovery'
import type { AssetAuthoringResult, CreateAssetCommand, ReplaceAssetCommand } from '../services/asset-authoring'
import type { CreateFlowCommand, FlowAuthoringResult, UpdateFlowCommand } from '../services/flow-authoring'
import type { CaptureFormalEvidenceCommand, CaptureFormalEvidenceResult, FormalEvidenceItem } from '../services/formal-capture'
import type { AssessHandoffReadinessCommand, AssessHandoffReadinessResult, ExportHandoffCommand, ExportHandoffResult } from '../services/handoff-export'
import type { DiffVersionsCommand, VersionDiffOutcome } from '../services/history-diff'
import type { ReadVersionBlobOutcome, ReadVersionResourceOutcome } from '../services/history-preview'
import type { RestoreGuard, RestoreResourceVersionCommand, RestoreResourceVersionOutcome } from '../services/history-restore'
import type { CreateCheckpointOutcome, DeleteCheckpointOutcome, ListVersionsOutcome, ListVersionsQuery, ReadVersionOutcome } from '../services/history-service'
import type { CreateLocaleCommand, LocaleAuthoringResult, UpdateLocaleCommand } from '../services/locale-authoring'
import type {
	AppendReviewMessageCommand,
	CreateReviewThreadCommand,
	EditReviewMessageCommand,
	PromoteReviewToDecisionCommand,
	ReanchorReviewThreadCommand,
	ReopenReviewThreadCommand,
	ResolveReviewThreadCommand,
	RetractReviewThreadCommand,
	ReviewAuthoringResult,
	SetReviewDisplayHintCommand,
	SubmitReadyForReviewCommand,
} from '../services/review-authoring'
import type { CreateViewCommand, UpdateViewSpecCommand, UpdateViewStructureCommand, ViewAuthoringResult } from '../services/view-authoring'
import type { PointResourceRead, WorkspaceApplicationSession } from '../services/workspace-session'
import type { UpdateWorkspaceSettingsCommand, WorkspaceAuthoringResult } from '../services/workspace-authoring'
import { keyRequirements, writeKeyForKind, type PermissionKey } from './keys'
import {
	LOCKABLE_KINDS,
	MAX_ACQUIRE_RESOURCES,
	isValidLeaseAddress,
	publicLease,
	type LeaseAddress,
	type LeaseHolder,
	type LeaseManager,
	type LockableKind,
	type PublicLease,
} from './leases'
import {
	adapterChangeKeys,
	authorizeLeaseAcquire,
	authorizeOperation,
	authorizeRestore,
	effectiveKeys,
	type AccessOperation,
	type ScopeDenied,
} from './policy'
import { principalActor, type MemberPrincipal, type Principal, type StampedActor } from './principal'

/**
 * The principal-scoped facade over the selected-Workspace application session. Both transports
 * (`/api/*` and `/mcp`) build one per request from the authenticated principal; it authorizes
 * against the permission keys, stamps `actor` and `at` server-side, and checks or takes agent edit
 * leases before every domain write (accepted identity decisions 5, 6, 7 and 11). The domain
 * services underneath are unchanged and keep accepting in-process callers' own `actor` / `at`.
 */
export type AccessTransport = 'http' | 'mcp'

export type AccessRefusal = Readonly<{
	status: 'blocked'
	key: string
	code: 'auth.scope_denied'
	/** The permission keys the request lacks (Clause 01a11485-f9bd-78a3-a1d0-1b4f64e9883e). */
	requiredKeys: readonly PermissionKey[]
	message: string
	diagnostics: readonly Diagnostic[]
}>

export type LockedRefusal = Readonly<{
	status: 'locked'
	key: string
	code: 'resource.locked'
	message: string
	lock: PublicLease
}>

export type ResolveRefusal = Readonly<{
	status: 'blocked'
	key: string
	code: 'review.resolve_requires_workbench' | 'review.resolve_requires_human' | 'review.direct_resolve_requires_workbench'
	message: string
	diagnostics: readonly Diagnostic[]
}>

/** Non-fatal diagnostics such as `auth.actor_ignored` and `auth.time_ignored`. */
export type AccessWarnings = Readonly<{ warnings?: readonly Diagnostic[] }>

export type Scoped<R> = (R & AccessWarnings) | AccessRefusal | LockedRefusal

/** Request commands: `actor` (and `at`) are optional and ignored in favour of the server stamp. */
type Unstamped<C> = Omit<C, 'actor'> & Readonly<{ actor?: unknown }>

export type AcquireLeasesOutcome =
	| Readonly<{ status: 'acquired'; leases: readonly Readonly<{ kind: LockableKind; key: string; expiresAt: string }>[] }>
	| Readonly<{ status: 'locked'; code: 'resource.locked'; message: string; locks: readonly PublicLease[] }>
	| Readonly<{ status: 'invalid'; code: 'lease.invalid_resources'; message: string; diagnostics: readonly Diagnostic[] }>
	| AccessRefusal

export type ReleaseLeasesOutcome =
	| Readonly<{ status: 'released'; released: readonly Readonly<{ kind: LockableKind; key: string }>[] }>
	| Readonly<{ status: 'invalid'; code: 'lease.invalid_resources'; message: string; diagnostics: readonly Diagnostic[] }>
	| AccessRefusal

export type ForceReleaseOutcome =
	| Readonly<{ status: 'released'; lease: PublicLease }>
	| Readonly<{ status: 'not_found'; kind: string; key: string }>
	| Readonly<{ status: 'invalid'; code: 'lease.invalid_resources'; message: string; diagnostics: readonly Diagnostic[] }>
	| AccessRefusal

export interface ScopedWorkspaceSession {
	readonly principal: Principal
	readonly transport: AccessTransport
	/** Throws {@link AccessDeniedError} if the principal cannot perform the operation. */
	assert(operation: AccessOperation): void
	authorize(operation: AccessOperation): ScopeDenied | undefined
	readPointResource(kind: PointResourceKind, key: string): Promise<PointResourceRead | undefined>
	listPointResources(input: unknown): Promise<ResourceDiscoveryOutcome>
	searchPointResources(input: unknown): Promise<ResourceDiscoveryOutcome>
	listEvidence(viewId?: string): Promise<readonly FormalEvidenceItem[]>
	readArtifact(identity: string): Promise<Uint8Array | undefined>
	assessHandoffReadiness(command: AssessHandoffReadinessCommand): Promise<AssessHandoffReadinessResult | AccessRefusal>
	diffVersions(command: DiffVersionsCommand): Promise<VersionDiffOutcome | AccessRefusal>
	listVersions(query: ListVersionsQuery): Promise<ListVersionsOutcome | AccessRefusal>
	readVersion(id: string): Promise<ReadVersionOutcome | AccessRefusal>
	/** The version reads for Preview (`history.read`; never a system credential, Clause 01a11485-f978-767a-b977-33028aee7ae7). */
	readVersionResource(id: string, kind: string, key: string): Promise<ReadVersionResourceOutcome | AccessRefusal>
	readVersionBlob(digest: string): Promise<ReadVersionBlobOutcome | AccessRefusal>
	/** Stamps the member actor and the transport's source; needs no edit lease (Rule 01a11a5e-0a0c-7d65-8d09-9a71a730ec61). */
	createCheckpoint(command: Readonly<{ name: string; note?: string }>): Promise<CreateCheckpointOutcome | AccessRefusal>
	deleteCheckpoint(id: string): Promise<DeleteCheckpointOutcome | AccessRefusal>
	/**
	 * Needs `history.restore` and the restored kind's write key (Rule 01a11c09-c648-71be-a550-2ecabf12f5d0);
	 * checks (and for an Agent takes) the target's edit lease like any write of it (Rule
	 * 01a11a5e-1520-78ac-a711-6e51c54c2079), and records the write with `restoredFrom`.
	 */
	restoreResourceVersion(command: RestoreResourceVersionCommand): Promise<Scoped<RestoreResourceVersionOutcome>>
	createView(command: CreateViewCommand): Promise<Scoped<ViewAuthoringResult>>
	updateViewSpec(command: UpdateViewSpecCommand): Promise<Scoped<ViewAuthoringResult>>
	updateViewStructure(command: UpdateViewStructureCommand): Promise<Scoped<ViewAuthoringResult>>
	updateWorkspaceSettings(command: UpdateWorkspaceSettingsCommand): Promise<Scoped<WorkspaceAuthoringResult>>
	createLocale(command: CreateLocaleCommand): Promise<Scoped<LocaleAuthoringResult>>
	updateLocale(command: UpdateLocaleCommand): Promise<Scoped<LocaleAuthoringResult>>
	createFlow(command: CreateFlowCommand): Promise<Scoped<FlowAuthoringResult>>
	updateFlow(command: UpdateFlowCommand): Promise<Scoped<FlowAuthoringResult>>
	createAsset(command: CreateAssetCommand): Promise<Scoped<AssetAuthoringResult>>
	replaceAsset(command: ReplaceAssetCommand): Promise<Scoped<AssetAuthoringResult>>
	createReviewThread(command: CreateReviewThreadCommand): Promise<Scoped<ReviewAuthoringResult>>
	appendReviewMessage(command: Unstamped<AppendReviewMessageCommand>): Promise<Scoped<ReviewAuthoringResult>>
	reanchorReviewThread(command: Unstamped<ReanchorReviewThreadCommand>): Promise<Scoped<ReviewAuthoringResult>>
	submitReadyForReview(command: Unstamped<SubmitReadyForReviewCommand>): Promise<Scoped<ReviewAuthoringResult>>
	resolveReviewThread(command: Unstamped<ResolveReviewThreadCommand>): Promise<Scoped<ReviewAuthoringResult> | ResolveRefusal>
	reopenReviewThread(command: Unstamped<ReopenReviewThreadCommand>): Promise<Scoped<ReviewAuthoringResult>>
	setReviewDisplayHint(command: SetReviewDisplayHintCommand): Promise<Scoped<ReviewAuthoringResult>>
	promoteReviewToDecision(command: Unstamped<PromoteReviewToDecisionCommand>): Promise<Scoped<ReviewAuthoringResult>>
	editReviewMessage(command: Unstamped<EditReviewMessageCommand>): Promise<Scoped<ReviewAuthoringResult>>
	retractReviewThread(command: Unstamped<RetractReviewThreadCommand>): Promise<Scoped<ReviewAuthoringResult>>
	captureFormalEvidence(command: CaptureFormalEvidenceCommand): Promise<CaptureFormalEvidenceResult | AccessRefusal>
	exportHandoff(command: ExportHandoffCommand): Promise<ExportHandoffResult | AccessRefusal>
	acquireLeases(input: unknown): AcquireLeasesOutcome
	/** With no `resources`, an Agent's release also closes the autosave it wrote (Rule 01a11a5e-0068-7a4b-b4bc-3cb282b4ae5a). */
	releaseLeases(input: unknown): Promise<ReleaseLeasesOutcome>
	listLeases(): readonly PublicLease[]
	forceReleaseLease(address: unknown): ForceReleaseOutcome
}

export class AccessDeniedError extends Error {
	readonly refusal: ScopeDenied
	constructor(refusal: ScopeDenied) {
		super(refusal.message)
		this.name = 'AccessDeniedError'
		this.refusal = refusal
	}
}

export type ScopedSessionOptions = Readonly<{
	transport: AccessTransport
	leases: LeaseManager
	now?: () => Date
	/** The history recorder's `release_lock` boundary; absent where history is not recorded. */
	history?: Readonly<{ agentReleased(actor: StampedActor): Promise<void> }>
}>

const SUCCESS = new Set(['created', 'updated'])

export function lockedMessage(lease: PublicLease): string {
	return `${lease.kind} ${lease.key} is locked by ${lease.holder.nickname} until ${lease.expiresAt}.`
}

export function refusalFromScope(key: string, denied: ScopeDenied): AccessRefusal {
	return {
		status: 'blocked',
		key,
		code: 'auth.scope_denied',
		requiredKeys: denied.requiredKeys,
		message: denied.message,
		diagnostics: [{ code: 'auth.scope_denied', path: '/', message: denied.message }],
	}
}

function resolveRefusal(key: string, code: ResolveRefusal['code'], message: string, path: string): ResolveRefusal {
	return { status: 'blocked', key, code, message, diagnostics: [{ code, path, message }] }
}

/**
 * Resolution is human-only and Workbench-only. The refusal order is keyed on the principal
 * (decision 7): on `/mcp` a human gets `review.resolve_requires_workbench`, an agent asking for a
 * non-verified resolution `review.direct_resolve_requires_workbench`, any other agent
 * `review.resolve_requires_human`. On `/api/*` resolving needs `reviews.resolve` on a human
 * member's cookie session (Clause 01a11485-fa87-7cf8-8ec1-275793457228): a member that could not
 * resolve on any credential gets the permission refusal naming `reviews.resolve`, that is a human
 * without the key, or an Agent without `reviews.write`, the key `reviews.resolve` requires (an
 * Agent never holds the `humanOnly` key itself); otherwise a bearer token is refused with
 * `review.resolve_requires_workbench` and an agent's session with `review.resolve_requires_human`.
 */
export function resolutionRefusal(
	principal: Principal,
	transport: AccessTransport,
	reviewId: string,
	resolution: ReviewResolution | undefined,
): ResolveRefusal | AccessRefusal | undefined {
	if (transport === 'mcp') {
		if (principal.type === 'member' && principal.kind === 'human')
			return resolveRefusal(reviewId, 'review.resolve_requires_workbench', 'Resolution is performed by a human in the UIUX Workbench, not through MCP.', '/')
		if (resolution !== undefined && resolution !== 'verified')
			return resolveRefusal(reviewId, 'review.direct_resolve_requires_workbench', 'Closing a thread without a verified change is a human decision made in the UIUX Workbench. Reply on the thread instead.', '/resolution')
		return resolveRefusal(reviewId, 'review.resolve_requires_human', 'Only a human member may resolve a Review thread, in the UIUX Workbench. Submit the thread ready for review and a human will resolve it.', '/')
	}
	if (principal.type === 'system') return refusalFromScope(reviewId, authorizeOperation(principal, 'resolveReviewThread')!)
	const eligible = principal.kind === 'human'
		? principal.keys.includes('reviews.resolve')
		: keyRequirements('reviews.resolve').every(key => principal.keys.includes(key))
	if (!eligible) return refusalFromScope(reviewId, authorizeOperation(principal, 'resolveReviewThread')!)
	if (principal.credential !== 'session')
		return resolveRefusal(reviewId, 'review.resolve_requires_workbench', 'Resolution is performed by a signed-in human in the UIUX Workbench; bearer tokens cannot resolve.', '/')
	if (principal.kind !== 'human')
		return resolveRefusal(reviewId, 'review.resolve_requires_human', 'Only a human member may resolve a Review thread.', '/')
	return undefined
}

function sameActor(supplied: unknown, stamp: StampedActor): boolean {
	if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) return false
	const record = supplied as Record<string, unknown>
	return record.type === stamp.type && record.id === stamp.id && record.displayName === stamp.displayName
		&& Object.keys(record).every(name => name === 'type' || name === 'id' || name === 'displayName')
}

export function createScopedWorkspaceSession(
	app: WorkspaceApplicationSession,
	principal: Principal,
	options: ScopedSessionOptions,
): ScopedWorkspaceSession {
	const { transport, leases } = options
	const now = options.now ?? (() => new Date())
	const holder: LeaseHolder | undefined = principal.type === 'member'
		? { memberId: principal.memberId, nickname: principal.nickname, kind: principal.kind }
		: undefined

	function assert(operation: AccessOperation): void {
		const denied = authorizeOperation(principal, operation)
		if (denied) throw new AccessDeniedError(denied)
	}

	/** Authorization plus the server stamp for timeline-writing Review mutations. */
	function stamp<C extends Readonly<{ actor?: unknown; at?: unknown }>>(command: C, options: Readonly<{ at: boolean }>): { command: Omit<C, 'actor' | 'at'> & { actor: StampedActor; at?: string }; warnings: Diagnostic[] } {
		const member = principal as MemberPrincipal
		const actor = principalActor(member)
		const warnings: Diagnostic[] = []
		if (command.actor !== undefined && !sameActor(command.actor, actor)) {
			warnings.push({
				code: 'auth.actor_ignored',
				path: '/actor',
				message: `The supplied actor was ignored; the server stamped ${actor.id} (${actor.displayName}, ${actor.type}) from the authenticated member.`,
			})
		}
		if (options.at && command.at !== undefined) {
			warnings.push({ code: 'auth.time_ignored', path: '/at', message: 'The supplied at was ignored; the server stamped its own clock.' })
		}
		const { actor: _actor, at: _at, ...rest } = command
		void _actor
		void _at
		return {
			command: { ...rest, actor, ...(options.at ? { at: now().toISOString() } : {}) } as Omit<C, 'actor' | 'at'> & { actor: StampedActor; at?: string },
			warnings,
		}
	}

	/**
	 * The design-write context of one write (recorder seam 6): the server-stamped member actor, the
	 * transport's source (Clause 01a11a5e-221b-7a04-a6cb-66bc9608c11f: `/api/*` records `workbench`,
	 * bearer Tokens included, and `/mcp` records `mcp`) and the operation. Only the design
	 * operations of Clause 01a11a5e-216d-7587-8022-66a66f264eee get one, so Review activity is never
	 * recorded (Rule 01a11a5e-0873-7976-8a48-a9a1a00e4b6d), and system principals never create events.
	 */
	function designWriteContext(operation: AccessOperation, restoredFrom?: string): DesignWriteContext | undefined {
		if (principal.type !== 'member' || !(HISTORY_WRITE_OPERATIONS as readonly string[]).includes(operation)) return undefined
		return {
			actor: principalActor(principal),
			source: transport === 'mcp' ? 'mcp' : 'workbench',
			operation: operation as HistoryWriteOperation,
			// Clause 01a11a5e-20c6-7573-8530-e6fed6d8d4af: the version a restore copied. The recorder
			// closes the open autosave before and after such a write (Rule 01a11e0d-d911-7030-9565-7473aa0995e1).
			...(restoredFrom === undefined ? {} : { restoredFrom }),
		}
	}

	function withWarnings<R extends object>(result: R, warnings: readonly Diagnostic[]): R & AccessWarnings {
		return warnings.length > 0 ? { ...result, warnings } : result
	}

	/**
	 * Clause 01a11bb1-b35a-7e69-bba5-978e3f47c4fa: below `schemaVersion` 5 a settings change or a
	 * `workspace` restore that adds, removes, reorders or re-points an `adapters` entry also needs
	 * `product-kit.compose`. The services call this guard after their revision check, on the
	 * manifest the compare-and-swap replaces, so the keys are those of the change actually written.
	 */
	function adapterChangeRefusal(current: unknown, next: unknown, authorize: (keys: readonly PermissionKey[]) => ScopeDenied | undefined, key: string): AccessRefusal | undefined {
		const record = (value: unknown): Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
		const specifiers = (value: unknown) => Array.isArray(value)
			? value.map(entry => ({ moduleSpecifier: String(record(entry).moduleSpecifier) }))
			: []
		// An unknown schema version counts as below 5, so the check fails closed.
		const schemaVersion = record(next).schemaVersion ?? record(current).schemaVersion
		const denied = authorize(adapterChangeKeys(typeof schemaVersion === 'number' ? schemaVersion : 0, specifiers(record(current).adapters), specifiers(record(next).adapters)))
		return denied ? refusalFromScope(key, denied) : undefined
	}

	/** Authorize, check or reserve the lease, run the domain write, then keep or drop the reservation. */
	async function write<R extends { status: string; key: string }>(
		operation: AccessOperation,
		key: string,
		target: LeaseAddress | undefined,
		run: () => Promise<R>,
		warnings: readonly Diagnostic[] = [],
		options: Readonly<{ restoredFrom?: string }> = {},
	): Promise<Scoped<R>> {
		const denied = authorizeOperation(principal, operation)
		if (denied) return refusalFromScope(key, denied)
		let ticket: { commit(): void; abort(): void; rekey(key: string): void } | undefined
		if (target && holder) {
			// An Agent's write takes the lease only when the Agent holds the kind's write key: promoting a
			// Review without `views.write` only checks the View's lease (#140 owner ruling 2026-10-10, 2).
			const writeKey = writeKeyForKind(target.kind)
			const autoAcquire = holder.kind === 'agent' && writeKey !== undefined && effectiveKeys(principal).includes(writeKey)
			const begun = leases.beginWrite(target, holder, { autoAcquire })
			if (begun.status === 'locked') {
				const lock = publicLease(begun.lease)
				return { status: 'locked', key: target.key, code: 'resource.locked', message: lockedMessage(lock), lock }
			}
			ticket = begun.ticket
		}
		let result: R
		const context = designWriteContext(operation, options.restoredFrom)
		try {
			result = context ? await runWithDesignWriteContext(context, run) : await run()
		}
		catch (error) {
			ticket?.abort()
			throw error
		}
		if (SUCCESS.has(result.status)) {
			if (target && result.key !== target.key && target.kind !== 'workspace' && operation !== 'promoteReviewToDecision') ticket?.rekey(result.key)
			ticket?.commit()
		}
		else {
			ticket?.abort()
		}
		return withWarnings(result, warnings)
	}

	function reviewer<C extends Readonly<{ reviewId: string; actor?: unknown; at?: unknown }>, R extends { status: string; key: string }>(
		operation: AccessOperation,
		command: C,
		run: (stamped: Omit<C, 'actor' | 'at'> & { actor: StampedActor; at?: string }) => Promise<R>,
	): Promise<Scoped<R>> {
		const denied = authorizeOperation(principal, operation)
		if (denied || principal.type !== 'member') return Promise.resolve(refusalFromScope(command.reviewId, denied ?? authorizeOperation(principal, operation)!))
		const stamped = stamp(command, { at: true })
		return write(operation, command.reviewId, undefined, () => run(stamped.command), stamped.warnings)
	}

	function parseAddresses(input: unknown, required: boolean): { ok: true; addresses: LeaseAddress[] | undefined } | { ok: false; diagnostics: Diagnostic[] } {
		const resources = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).resources : undefined
		if (resources === undefined && !required) return { ok: true, addresses: undefined }
		if (!Array.isArray(resources) || resources.length < 1 || resources.length > MAX_ACQUIRE_RESOURCES)
			return { ok: false, diagnostics: [{ code: 'lease.invalid_resources', path: '/resources', message: `resources must list 1 to ${MAX_ACQUIRE_RESOURCES} { kind, key } entries.` }] }
		const diagnostics: Diagnostic[] = []
		resources.forEach((entry, index) => {
			if (!isValidLeaseAddress(entry))
				diagnostics.push({ code: 'lease.invalid_resources', path: `/resources/${index}`, message: 'Each resource must be { kind: view | flow | locale | asset | workspace, key }; the workspace key is "workspace". Review threads are never locked.' })
		})
		if (diagnostics.length > 0) return { ok: false, diagnostics }
		const seen = new Map<string, LeaseAddress>()
		for (const entry of resources as LeaseAddress[]) seen.set(`${entry.kind}\u0000${entry.key}`, { kind: entry.kind, key: entry.key })
		return { ok: true, addresses: [...seen.values()] }
	}

	const invalidLeases = (diagnostics: Diagnostic[]) => ({ status: 'invalid' as const, code: 'lease.invalid_resources' as const, message: 'The lease resources are invalid.', diagnostics })

	return {
		principal,
		transport,
		assert,
		authorize: operation => authorizeOperation(principal, operation),

		async readPointResource(kind, key) { assert('readPointResource'); return app.readPointResource(kind, key) },
		async listPointResources(input) { assert('listPointResources'); return app.listPointResources(input) },
		async searchPointResources(input) { assert('searchPointResources'); return app.searchPointResources(input) },
		async listEvidence(viewId) { assert('listEvidence'); return app.listEvidence(viewId) },
		async readArtifact(identity) { assert('readArtifact'); return app.readArtifact(identity) },
		async assessHandoffReadiness(command) {
			const denied = authorizeOperation(principal, 'assessHandoffReadiness')
			return denied ? refusalFromScope('handoff', denied) : app.assessHandoffReadiness(command)
		},
		async diffVersions(command) {
			const denied = authorizeOperation(principal, 'diffVersions')
			return denied ? refusalFromScope('history', denied) : app.diffVersions(command)
		},
		async listVersions(query) {
			const denied = authorizeOperation(principal, 'listVersions')
			return denied ? refusalFromScope('history', denied) : app.listVersions(query)
		},
		async readVersion(id) {
			const denied = authorizeOperation(principal, 'readVersion')
			return denied ? refusalFromScope(id, denied) : app.readVersion(id)
		},
		async readVersionResource(id, kind, key) {
			const denied = authorizeOperation(principal, 'readVersionForPreview')
			return denied ? refusalFromScope(id, denied) : app.readVersionResource(id, kind, key)
		},
		async readVersionBlob(digest) {
			const denied = authorizeOperation(principal, 'readVersionForPreview')
			return denied ? refusalFromScope(digest, denied) : app.readVersionBlob(digest)
		},
		async createCheckpoint(command) {
			const denied = authorizeOperation(principal, 'createCheckpoint')
			if (denied) return refusalFromScope('checkpoint', denied)
			// The policy refuses every system principal, so only a member gets here. Rule
			// 01a11a5e-025f-71d7-8d08-63948220de57 and Clause 01a11a5e-221b-7a04-a6cb-66bc9608c11f: the
			// server-stamped actor and the transport's source; the caller supplies neither.
			return app.createCheckpoint({
				name: command.name,
				...(command.note === undefined ? {} : { note: command.note }),
				actor: principalActor(principal as MemberPrincipal),
				source: transport === 'mcp' ? 'mcp' : 'workbench',
			})
		},
		async deleteCheckpoint(id) {
			const denied = authorizeOperation(principal, 'deleteCheckpoint')
			return denied ? refusalFromScope(id, denied) : app.deleteCheckpoint(id)
		},

		async restoreResourceVersion(command) {
			const resource = (command as Readonly<{ resource?: unknown }>).resource
			const kind = typeof resource === 'object' && resource !== null && typeof (resource as { kind?: unknown }).kind === 'string' ? (resource as { kind: string }).kind : ''
			const key = typeof resource === 'object' && resource !== null && typeof (resource as { key?: unknown }).key === 'string' ? (resource as { key: string }).key : ''
			// `history.restore` and the kind's write key. A kind this build cannot restore has no write
			// key; the service refuses it while parsing the command, before it reads or writes anything,
			// so only `history.restore` is checked for it here.
			const denied = isRestorableResourceKind(kind) ? authorizeRestore(principal, kind) : authorizeOperation(principal, 'restoreResourceVersion')
			if (denied) return refusalFromScope(key || 'history', denied)
			const target = isValidLeaseAddress({ kind, key }) ? { kind: kind as LockableKind, key } : undefined
			const versionId: unknown = command.versionId
			// #140 owner ruling 2026-10-10, 1: a `workspace` restore that changes `adapters` needs `product-kit.compose` too.
			const guard: RestoreGuard<AccessRefusal> = change => change.kind === 'workspace'
				? adapterChangeRefusal(change.current, change.next, keys => authorizeRestore(principal, change.kind, keys), key || 'history')
				: undefined
			return write('restoreResourceVersion', key || 'history', target, () => app.restoreResourceVersion(command, guard), [], isFullUuid(versionId) ? { restoredFrom: versionId } : {})
		},

		createView: command => write('createView', command.id, { kind: 'view', key: command.id }, () => app.createView(command)),
		updateViewSpec: command => write('updateViewSpec', command.key, { kind: 'view', key: command.key }, () => app.updateViewSpec(command)),
		updateViewStructure: command => write('updateViewStructure', command.key, { kind: 'view', key: command.key }, () => app.updateViewStructure(command)),
		updateWorkspaceSettings: command => write('updateWorkspaceSettings', 'workspace', { kind: 'workspace', key: 'workspace' }, () => app.updateWorkspaceSettings(command, change =>
			adapterChangeRefusal(change.current, change.next, keys => authorizeOperation(principal, 'updateWorkspaceSettings', keys), 'workspace'))),
		createLocale: command => write('createLocale', command.locale, { kind: 'locale', key: command.locale }, () => app.createLocale(command)),
		updateLocale: command => write('updateLocale', command.locale, { kind: 'locale', key: command.locale }, () => app.updateLocale(command)),
		createFlow: (command) => {
			const id = command.id ?? randomUUID()
			return write('createFlow', id, { kind: 'flow', key: id }, () => app.createFlow({ ...command, id }))
		},
		updateFlow: command => write('updateFlow', command.flowId, { kind: 'flow', key: command.flowId }, () => app.updateFlow(command)),
		createAsset: (command) => {
			const id = command.id ?? randomUUID()
			return write('createAsset', id, { kind: 'asset', key: id }, () => app.createAsset({ ...command, id }))
		},
		replaceAsset: command => write('replaceAsset', command.assetId, { kind: 'asset', key: command.assetId }, () => app.replaceAsset(command)),

		createReviewThread: command => write('createReviewThread', command.id ?? 'review', undefined, () => app.createReviewThread(command)),
		appendReviewMessage: command => reviewer('appendReviewMessage', command, stamped => app.appendReviewMessage(stamped)),
		reanchorReviewThread: command => reviewer('reanchorReviewThread', command, stamped => app.reanchorReviewThread(stamped)),
		submitReadyForReview: command => reviewer('submitReadyForReview', command, stamped => app.submitReadyForReview(stamped)),
		reopenReviewThread: command => reviewer('reopenReviewThread', command, stamped => app.reopenReviewThread(stamped)),
		setReviewDisplayHint: command => write('setReviewDisplayHint', command.reviewId, undefined, () => app.setReviewDisplayHint(command)),
		async resolveReviewThread(command) {
			const refused = resolutionRefusal(principal, transport, command.reviewId, command.resolution)
			if (refused) return refused
			const stamped = stamp(command, { at: true })
			return write('resolveReviewThread', command.reviewId, undefined, () => app.resolveReviewThread(stamped.command), stamped.warnings)
		},
		async promoteReviewToDecision(command) {
			const denied = authorizeOperation(principal, 'promoteReviewToDecision')
			if (denied || principal.type !== 'member') return refusalFromScope(command.reviewId, denied ?? authorizeOperation(principal, 'promoteReviewToDecision')!)
			const stamped = stamp(command, { at: false })
			// Promotion writes the View, so it checks (and for agents takes) the View's lease.
			return write('promoteReviewToDecision', command.reviewId, { kind: 'view', key: command.viewId }, () => app.promoteReviewToDecision(stamped.command), stamped.warnings)
		},

		// Author-only operations: the stamp is what the domain compares with the message author, so
		// they hold on both transports (agents may edit and retract their own words over /mcp).
		editReviewMessage: command => reviewer('editReviewMessage', command, stamped => app.editReviewMessage(stamped)),
		async retractReviewThread(command) {
			const denied = authorizeOperation(principal, 'retractReviewThread')
			if (denied || principal.type !== 'member') return refusalFromScope(command.reviewId, denied ?? authorizeOperation(principal, 'retractReviewThread')!)
			// The stamp is used only for the author check; nothing is recorded.
			const stamped = stamp(command, { at: false })
			return write('retractReviewThread', command.reviewId, undefined, () => app.retractReviewThread(stamped.command), stamped.warnings)
		},

		async captureFormalEvidence(command) {
			const denied = authorizeOperation(principal, 'captureFormalEvidence')
			return denied ? refusalFromScope('evidence', denied) : app.captureFormalEvidence(command)
		},
		async exportHandoff(command) {
			const denied = authorizeOperation(principal, 'exportHandoff')
			return denied ? refusalFromScope('handoff', denied) : app.exportHandoff(command)
		},

		acquireLeases(input) {
			if (!holder) return refusalFromScope('locks', authorizeLeaseAcquire(principal, LOCKABLE_KINDS)!)
			const parsed = parseAddresses(input, true)
			if (!parsed.ok) {
				// A member that may lease no kind at all is refused before its input is examined.
				if (LOCKABLE_KINDS.every(kind => authorizeLeaseAcquire(principal, [kind]) !== undefined))
					return refusalFromScope('locks', authorizeLeaseAcquire(principal, LOCKABLE_KINDS)!)
				return invalidLeases(parsed.diagnostics)
			}
			const denied = authorizeLeaseAcquire(principal, parsed.addresses!.map(address => address.kind))
			if (denied) return refusalFromScope('locks', denied)
			const outcome = leases.acquire(parsed.addresses!, holder)
			if (outcome.status === 'locked') {
				const locks = outcome.conflicts.map(publicLease)
				return { status: 'locked', code: 'resource.locked', message: locks.map(lockedMessage).join(' '), locks }
			}
			return { status: 'acquired', leases: outcome.leases.map(lease => ({ kind: lease.kind, key: lease.key, expiresAt: lease.expiresAt })) }
		},
		async releaseLeases(input) {
			const denied = authorizeOperation(principal, 'releaseLeases')
			if (denied || !holder) return refusalFromScope('locks', denied ?? authorizeOperation(principal, 'releaseLeases')!)
			const parsed = parseAddresses(input, false)
			if (!parsed.ok) return invalidLeases(parsed.diagnostics)
			const released = leases.release(holder, parsed.addresses)
			// The end of an Agent's task closes only its open autosave; no Checkpoint is created (Rule 01a11a5e-0ac6-79b2-b542-1e527e8b4fdf).
			if (parsed.addresses === undefined && principal.type === 'member' && principal.kind === 'agent')
				await options.history?.agentReleased(principalActor(principal)).catch(() => undefined)
			return { status: 'released', released: released.map(lease => ({ kind: lease.kind, key: lease.key })) }
		},
		listLeases() {
			assert('listLeases')
			return leases.list().map(publicLease)
		},
		forceReleaseLease(address) {
			const denied = authorizeOperation(principal, 'forceReleaseLease')
			if (denied) return refusalFromScope('locks', denied)
			if (!isValidLeaseAddress(address))
				return invalidLeases([{ code: 'lease.invalid_resources', path: '/', message: 'Lease address must be { kind: view | flow | locale | asset | workspace, key }.' }])
			const released = leases.forceRelease(address)
			return released ? { status: 'released', lease: publicLease(released) } : { status: 'not_found', kind: address.kind, key: address.key }
		},
	}
}
