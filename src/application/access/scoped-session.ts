import { randomUUID } from 'node:crypto'

import { HISTORY_WRITE_OPERATIONS, type HistoryWriteOperation } from '../../domain/history/constants'
import type { Diagnostic } from '../../domain/validation'
import { runWithDesignWriteContext, type DesignWriteContext } from '../../persistence/history/write-context'
import type { ReviewResolution } from '../../domain/reviews/schema'
import type { PointResourceKind } from '../dto/point-resources'
import type { ResourceDiscoveryOutcome } from '../dto/resource-discovery'
import type { AssetAuthoringResult, CreateAssetCommand, ReplaceAssetCommand } from '../services/asset-authoring'
import type { CreateFlowCommand, FlowAuthoringResult, UpdateFlowCommand } from '../services/flow-authoring'
import type { CaptureFormalEvidenceCommand, CaptureFormalEvidenceResult, FormalEvidenceItem } from '../services/formal-capture'
import type { AssessHandoffReadinessCommand, AssessHandoffReadinessResult, ExportHandoffCommand, ExportHandoffResult } from '../services/handoff-export'
import type { DiffVersionsCommand, VersionDiffOutcome } from '../services/history-diff'
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
import {
	MAX_ACQUIRE_RESOURCES,
	isValidLeaseAddress,
	publicLease,
	type LeaseAddress,
	type LeaseHolder,
	type LeaseManager,
	type LockableKind,
	type PublicLease,
} from './leases'
import { authorizeOperation, type AccessOperation, type ScopeDenied } from './policy'
import { principalActor, type AccessRole, type MemberPrincipal, type Principal, type StampedActor } from './principal'

/**
 * The principal-scoped facade over the selected-Workspace application session. Both transports
 * (`/api/*` and `/mcp`) build one per request from the authenticated principal; it authorizes
 * against the role matrix, stamps `actor` and `at` server-side, and checks or takes agent edit
 * leases before every domain write (accepted identity decisions 5, 6, 7 and 11). The domain
 * services underneath are unchanged and keep accepting in-process callers' own `actor` / `at`.
 */
export type AccessTransport = 'http' | 'mcp'

export type AccessRefusal = Readonly<{
	status: 'blocked'
	key: string
	code: 'auth.scope_denied'
	requiredRole: AccessRole
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
		requiredRole: denied.requiredRole,
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
 * `review.resolve_requires_human`. On `/api/*` a bearer token is refused with
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
	const denied = authorizeOperation(principal, 'appendReviewMessage')
	if (denied) return refusalFromScope(reviewId, { ...denied, message: `resolveReviewThread requires the Reviewer role or above; ${principal.nickname} is ${principal.role}.` })
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
	function designWriteContext(operation: AccessOperation): DesignWriteContext | undefined {
		if (principal.type !== 'member' || !(HISTORY_WRITE_OPERATIONS as readonly string[]).includes(operation)) return undefined
		return { actor: principalActor(principal), source: transport === 'mcp' ? 'mcp' : 'workbench', operation: operation as HistoryWriteOperation }
	}

	function withWarnings<R extends object>(result: R, warnings: readonly Diagnostic[]): R & AccessWarnings {
		return warnings.length > 0 ? { ...result, warnings } : result
	}

	/** Authorize, check or reserve the lease, run the domain write, then keep or drop the reservation. */
	async function write<R extends { status: string; key: string }>(
		operation: AccessOperation,
		key: string,
		target: LeaseAddress | undefined,
		run: () => Promise<R>,
		warnings: readonly Diagnostic[] = [],
	): Promise<Scoped<R>> {
		const denied = authorizeOperation(principal, operation)
		if (denied) return refusalFromScope(key, denied)
		let ticket: { commit(): void; abort(): void; rekey(key: string): void } | undefined
		if (target && holder) {
			const begun = leases.beginWrite(target, holder, { autoAcquire: holder.kind === 'agent' })
			if (begun.status === 'locked') {
				const lock = publicLease(begun.lease)
				return { status: 'locked', key: target.key, code: 'resource.locked', message: lockedMessage(lock), lock }
			}
			ticket = begun.ticket
		}
		let result: R
		const context = designWriteContext(operation)
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

		createView: command => write('createView', command.id, { kind: 'view', key: command.id }, () => app.createView(command)),
		updateViewSpec: command => write('updateViewSpec', command.key, { kind: 'view', key: command.key }, () => app.updateViewSpec(command)),
		updateViewStructure: command => write('updateViewStructure', command.key, { kind: 'view', key: command.key }, () => app.updateViewStructure(command)),
		updateWorkspaceSettings: command => write('updateWorkspaceSettings', 'workspace', { kind: 'workspace', key: 'workspace' }, () => app.updateWorkspaceSettings(command)),
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
			const denied = authorizeOperation(principal, 'acquireLeases')
			if (denied || !holder) return refusalFromScope('locks', denied ?? authorizeOperation(principal, 'acquireLeases')!)
			const parsed = parseAddresses(input, true)
			if (!parsed.ok) return invalidLeases(parsed.diagnostics)
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
