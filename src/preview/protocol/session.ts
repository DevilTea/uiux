import type { CapabilityDeclareMessage } from './schema'

export type CapabilityFailureReason = `capability.${string}`
export type GenerationAdmissionCause = 'initial' | 'reload' | 'restart' | 'automatic-recovery' | 'explicit-retry'
export type GenerationPhase = 'bootstrap' | 'awaiting-ack' | 'open'

export type CapabilityCompatibility =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; reason: CapabilityFailureReason }>

export type GenerationAdmissionResult =
	| Readonly<{ status: 'admitted'; generationId: string; cause: GenerationAdmissionCause }>
	| Readonly<{ status: 'identity_reuse'; generationId: string }>
	| Readonly<{ status: 'unauthorized'; generationId: string }>
	| Readonly<{ status: 'invalid_state'; generationId: string }>

export type CapabilityDeclarationResult =
	| Readonly<{ status: 'ack-required'; generationId: string }>
	| Readonly<{ status: 'capability-failure'; generationId: string; reason: CapabilityFailureReason }>
	| Readonly<{ status: 'capability-conflict'; generationId: string }>
	| Readonly<{ status: 'stale'; generationId: string }>

export type CapabilityAcknowledgementResult =
	| Readonly<{ status: 'opened'; generationId: string }>
	| Readonly<{ status: 'already-open'; generationId: string }>
	| Readonly<{ status: 'protocol-invalid'; generationId: string }>
	| Readonly<{ status: 'stale'; generationId: string }>

export type RetryAuthorizationResult = 'authorized' | 'coalesced' | 'ignored-active-bootstrap' | 'not-eligible'
export type RetryRevocationResult = 'revoked' | 'none'
export type AutomaticRecoveryResult = 'started' | 'not-eligible'
export type TrafficGateResult = 'open' | 'gated' | 'stale-session' | 'stale-generation'

export type PreviewProtocolSessionSnapshot = Readonly<{
	previewSessionId: string
	currentGenerationId?: string
	currentGenerationPhase?: GenerationPhase
	retiredGenerationIds: readonly string[]
	automaticRecoveryUsed: boolean
	recoveryNeeded: boolean
	recoveryExhausted: boolean
	/** The Workbench started the automatic recovery attempt and no generation of it is admitted yet. */
	automaticRecoveryPending: boolean
	retryAuthorizationPending: boolean
}>

type RecoveryAttempt = 'none' | 'automatic' | 'explicit'

type ActiveGeneration = {
	id: string
	cause: GenerationAdmissionCause
	recoveryAttempt: RecoveryAttempt
	phase: GenerationPhase
	declaration?: CapabilityDeclareMessage['payload']
}

/**
 * Preview session/runtime-generation state machine bound to the canonical capability payload.
 * The bridge validates capability.declare / capability.ack envelopes before applying lifecycle transitions here.
 */
export class PreviewProtocolSession {
	readonly previewSessionId: string
	private readonly retiredGenerationIds = new Set<string>()
	private current?: ActiveGeneration
	private automaticRecoveryUsed = false
	private recoveryNeeded = false
	private recoveryExhausted = false
	private automaticRecoveryPending = false
	private retryAuthorizationPending = false

	constructor(previewSessionId: string) {
		if (!previewSessionId) throw new TypeError('Preview session identity must be a non-empty opaque token.')
		this.previewSessionId = previewSessionId
	}

	beginGeneration(generationId: string, cause: GenerationAdmissionCause): GenerationAdmissionResult {
		if (!generationId) return { status: 'invalid_state', generationId }
		if (this.current?.id === generationId || this.retiredGenerationIds.has(generationId))
			return { status: 'identity_reuse', generationId }
		if (this.current) return { status: 'invalid_state', generationId }

		if (this.recoveryExhausted) {
			if (cause !== 'explicit-retry' || !this.retryAuthorizationPending) {
				this.retiredGenerationIds.add(generationId)
				return { status: 'unauthorized', generationId }
			}
		}

		let recoveryAttempt: RecoveryAttempt = 'none'
		if (cause === 'initial') {
			if (this.retiredGenerationIds.size > 0 || this.recoveryNeeded || this.automaticRecoveryUsed)
				return { status: 'invalid_state', generationId }
		}
		else if (cause === 'automatic-recovery') {
			// The attempt the Workbench started already spent the allowance.
			if (this.automaticRecoveryPending) this.automaticRecoveryPending = false
			else {
				if (!this.recoveryNeeded || this.automaticRecoveryUsed || this.recoveryExhausted)
					return { status: 'invalid_state', generationId }
				this.automaticRecoveryUsed = true
				this.recoveryNeeded = false
			}
			recoveryAttempt = 'automatic'
		}
		else if (cause === 'explicit-retry') {
			if (!this.recoveryExhausted || !this.retryAuthorizationPending) {
				this.retiredGenerationIds.add(generationId)
				return { status: 'unauthorized', generationId }
			}
			this.retryAuthorizationPending = false
			this.recoveryNeeded = false
			recoveryAttempt = 'explicit'
		}
		else if (this.automaticRecoveryPending) {
			this.automaticRecoveryPending = false
			recoveryAttempt = 'automatic'
		}
		else if (this.recoveryNeeded) {
			if (this.automaticRecoveryUsed) {
				this.recoveryExhausted = true
				this.recoveryNeeded = false
				this.retiredGenerationIds.add(generationId)
				return { status: 'unauthorized', generationId }
			}
			this.automaticRecoveryUsed = true
			this.recoveryNeeded = false
			recoveryAttempt = 'automatic'
		}

		this.current = { id: generationId, cause, recoveryAttempt, phase: 'bootstrap' }
		return { status: 'admitted', generationId, cause }
	}

	replaceGenerationForLifecycle(generationId: string, cause: 'reload' | 'restart'): GenerationAdmissionResult {
		if (this.current) this.retireCurrentForLifecycleReplacement()
		return this.beginGeneration(generationId, cause)
	}

	/** Whether `generationId` is the current generation, a retired one, or one this session never saw. */
	classifyGeneration(generationId: string): 'current' | 'retired' | 'unseen' {
		if (this.current?.id === generationId) return 'current'
		return this.retiredGenerationIds.has(generationId) ? 'retired' : 'unseen'
	}

	/**
	 * Admits the generation that a declaration with an unseen ID names: the runtime minted it for a
	 * new Preview document or a restarted runtime, so it replaces any current generation as a
	 * reload, subject to the recovery rules (Clauses 01a1161c-4119-712d-8785-7d8155c0ceee and
	 * 01a1161c-4339-7614-ba65-6f21e37cd1a0). The first generation of the session is `initial`.
	 * While no generation is current and an explicit retry is authorized, the next declared
	 * generation is that retry and spends the authorization (Rules 01a1161c-3cf8-7859-9de8-2b99d22ce8aa
	 * and 01a1161c-3d31-7a69-9d64-cad14a8071bb). While the automatic recovery attempt the Workbench
	 * started is pending, the next declared generation is that attempt (Rule 01a1161c-3bd4-7a91-b50e-d01a857521e5).
	 */
	admitDeclaredGeneration(generationId: string): GenerationAdmissionResult {
		if (this.classifyGeneration(generationId) !== 'unseen') return { status: 'identity_reuse', generationId }
		if (!this.current && this.automaticRecoveryPending) return this.beginGeneration(generationId, 'automatic-recovery')
		if (!this.current && this.retiredGenerationIds.size === 0) return this.beginGeneration(generationId, 'initial')
		if (!this.current && this.retryAuthorizationPending) return this.beginGeneration(generationId, 'explicit-retry')
		return this.replaceGenerationForLifecycle(generationId, 'reload')
	}

	/**
	 * The Workbench ends the current generation because it replaces the Preview document: the ID is
	 * retired, and the next declaration names the new generation.
	 */
	retireCurrentGeneration(): void {
		this.retireCurrentForLifecycleReplacement()
	}

	receiveCapabilityDeclaration(
		generationId: string,
		declaration: CapabilityDeclareMessage['payload'],
		compatibility: CapabilityCompatibility,
	): CapabilityDeclarationResult {
		const current = this.current
		if (!current || current.id !== generationId) return { status: 'stale', generationId }

		if (current.declaration !== undefined) {
			if (!declarationEqual(current.declaration, declaration)) {
				this.failCurrentGeneration('protocol-invalid')
				return { status: 'capability-conflict', generationId }
			}
			return { status: 'ack-required', generationId }
		}

		current.declaration = cloneDeclaration(declaration)
		if (!compatibility.ok) {
			this.failCurrentGeneration('capability-unavailable')
			return { status: 'capability-failure', generationId, reason: compatibility.reason }
		}
		current.phase = 'awaiting-ack'
		return { status: 'ack-required', generationId }
	}

	observeCapabilityAcknowledgement(generationId: string): CapabilityAcknowledgementResult {
		const current = this.current
		if (!current || current.id !== generationId) return { status: 'stale', generationId }
		if (current.phase === 'open') return { status: 'already-open', generationId }
		if (current.phase !== 'awaiting-ack' || current.declaration === undefined) {
			this.failCurrentGeneration('protocol-invalid')
			return { status: 'protocol-invalid', generationId }
		}
		current.phase = 'open'
		current.recoveryAttempt = 'none'
		this.automaticRecoveryUsed = false
		this.recoveryNeeded = false
		this.recoveryExhausted = false
		this.retryAuthorizationPending = false
		return { status: 'opened', generationId }
	}

	classifyGeometryTraffic(previewSessionId: string, generationId: string): TrafficGateResult {
		if (previewSessionId !== this.previewSessionId) return 'stale-session'
		if (!this.current || generationId !== this.current.id) return 'stale-generation'
		return this.current.phase === 'open' ? 'open' : 'gated'
	}

	/**
	 * The Workbench starts the one automatic recovery attempt after a protocol-invalid generation
	 * (Rules 01a1161c-3bd4-7a91-b50e-d01a857521e5 and 01a1161c-3c0e-7274-8112-db507455e0f4). Starting
	 * it spends the allowance, so a fresh document that fails before any generation of it is admitted
	 * exhausts recovery as well; the next declared generation is the attempt.
	 */
	beginAutomaticRecovery(): AutomaticRecoveryResult {
		if (this.current || !this.recoveryNeeded || this.automaticRecoveryUsed || this.recoveryExhausted || this.automaticRecoveryPending)
			return 'not-eligible'
		this.automaticRecoveryUsed = true
		this.recoveryNeeded = false
		this.automaticRecoveryPending = true
		return 'started'
	}

	/** Whether `generationId` is the current generation and its declaration named `feature`. */
	currentGenerationDeclares(generationId: string, feature: string): boolean {
		return this.current?.id === generationId && (this.current.declaration?.features.includes(feature) ?? false)
	}

	/**
	 * The current generation reported its own failure (a generation-scoped `failure.report`): it
	 * ends and its ID is retired. A `protocol` report makes it protocol-invalid, which leaves the
	 * automatic recovery allowance to use (Clause 01a11a59-def9-797a-8d08-5e4b02ecd900); a
	 * `runtime` report exhausts recovery at once, so only an explicit retry starts the next
	 * generation (Rule 01a11a59-eecb-7aff-983b-972148c714e1).
	 */
	failGenerationFromReport(generationId: string, category: 'protocol' | 'runtime'): boolean {
		if (this.current?.id !== generationId) return false
		this.failCurrentGeneration(category === 'protocol' ? 'protocol-invalid' : 'runtime-failure')
		return true
	}

	/**
	 * The Workbench found the Preview document it requested protocol-invalid without the session
	 * having judged it (an undecodable message before the handshake opened, or a declaration reusing a
	 * retired generation ID). The current generation, if any, fails as protocol-invalid; when none is
	 * admitted the failure still counts against the document's runtime, and during the pending
	 * automatic attempt it exhausts recovery.
	 */
	failRequestedDocument(): void {
		if (this.current) {
			this.failCurrentGeneration('protocol-invalid')
			return
		}
		if (this.recoveryExhausted) return
		if (this.automaticRecoveryPending) {
			this.automaticRecoveryPending = false
			this.recoveryExhausted = true
			return
		}
		this.recoveryNeeded = true
	}

	/**
	 * An explicit retry trigger. While the automatic attempt is pending with no generation of it
	 * admitted (its document stalled), the trigger abandons that attempt, which exhausts recovery, and
	 * authorizes an explicit retry instead, so activating Retry Preview is always an explicit retry
	 * (Rule 01a11687-386c-764f-98fd-cf19dc3d0013).
	 */
	authorizeRetry(): RetryAuthorizationResult {
		if (this.current && this.current.phase !== 'open') return 'ignored-active-bootstrap'
		if (!this.current && this.automaticRecoveryPending) {
			this.automaticRecoveryPending = false
			this.recoveryExhausted = true
		}
		if (!this.recoveryExhausted || this.current) return 'not-eligible'
		if (this.retryAuthorizationPending) return 'coalesced'
		this.retryAuthorizationPending = true
		return 'authorized'
	}

	revokeRetry(): RetryRevocationResult {
		if (!this.retryAuthorizationPending) return 'none'
		this.retryAuthorizationPending = false
		return 'revoked'
	}

	onPureTransportReconnect(): void {
		// Reconnect deliberately adds no identity and preserves current handshake/traffic state.
	}

	snapshot(): PreviewProtocolSessionSnapshot {
		return Object.freeze({
			previewSessionId: this.previewSessionId,
			...(this.current ? {
				currentGenerationId: this.current.id,
				currentGenerationPhase: this.current.phase,
			} : {}),
			retiredGenerationIds: Object.freeze([...this.retiredGenerationIds]),
			automaticRecoveryUsed: this.automaticRecoveryUsed,
			recoveryNeeded: this.recoveryNeeded,
			recoveryExhausted: this.recoveryExhausted,
			automaticRecoveryPending: this.automaticRecoveryPending,
			retryAuthorizationPending: this.retryAuthorizationPending,
		})
	}

	private retireCurrentForLifecycleReplacement(): void {
		if (!this.current) return
		const retired = this.current
		this.retiredGenerationIds.add(retired.id)
		this.current = undefined
		if (retired.recoveryAttempt !== 'none') {
			this.recoveryNeeded = false
			this.recoveryExhausted = true
			this.retryAuthorizationPending = false
		}
	}

	private failCurrentGeneration(disposition: 'protocol-invalid' | 'capability-unavailable' | 'runtime-failure'): void {
		const failed = this.current
		if (!failed) return
		this.retiredGenerationIds.add(failed.id)
		this.current = undefined
		this.retryAuthorizationPending = false
		if (failed.recoveryAttempt !== 'none' || disposition !== 'protocol-invalid') {
			this.recoveryNeeded = false
			this.recoveryExhausted = true
			return
		}
		this.recoveryNeeded = true
	}
}

export type PreviewSessionOpenResult =
	| Readonly<{ status: 'opened'; session: PreviewProtocolSession }>
	| Readonly<{ status: 'identity_reuse'; previewSessionId: string }>

/** Process-local Preview-session identity registry; restart naturally clears retired IDs. */
export class PreviewSessionRegistry {
	private readonly active = new Map<string, PreviewProtocolSession>()
	private readonly retired = new Set<string>()

	open(previewSessionId: string): PreviewSessionOpenResult {
		if (!previewSessionId) throw new TypeError('Preview session identity must be a non-empty opaque token.')
		if (this.active.has(previewSessionId) || this.retired.has(previewSessionId))
			return { status: 'identity_reuse', previewSessionId }
		const session = new PreviewProtocolSession(previewSessionId)
		this.active.set(previewSessionId, session)
		return { status: 'opened', session }
	}

	get(previewSessionId: string): PreviewProtocolSession | undefined {
		return this.active.get(previewSessionId)
	}

	close(previewSessionId: string): void {
		if (!this.active.delete(previewSessionId)) return
		this.retired.add(previewSessionId)
	}

	/**
	 * Opens a Preview session under a fresh ID from `mint`: a candidate that is active or retired is
	 * never activated, it is discarded and another is minted before the session begins (Rule
	 * 01a1161c-3b15-7913-acfb-136f0bd365b6). A minter that keeps repeating itself is a Workbench bug.
	 */
	openFresh(mint: () => string): PreviewProtocolSession {
		for (let attempt = 0; attempt < MAX_SESSION_ID_ATTEMPTS; attempt++) {
			const opened = this.open(mint())
			if (opened.status === 'opened') return opened.session
		}
		throw new Error('Could not mint a Preview session ID that was never used in this Workbench.')
	}
}

const MAX_SESSION_ID_ATTEMPTS = 16

/**
 * The Preview session registry of this Workbench page. Cross-iframe protocol traffic only ever
 * flows between one Workbench page and its own Preview documents, so the page is the process whose
 * delayed traffic a reused session ID could be confused with (Discussion #1 c128, c129).
 */
export const workbenchPreviewSessions = new PreviewSessionRegistry()

function cloneDeclaration(value: CapabilityDeclareMessage['payload']): CapabilityDeclareMessage['payload'] {
	return Object.freeze({ protocolVersion: value.protocolVersion, features: Object.freeze([...value.features].sort()) })
}

function declarationEqual(left: CapabilityDeclareMessage['payload'], right: CapabilityDeclareMessage['payload']): boolean {
	if (left.protocolVersion !== right.protocolVersion || left.features.length !== right.features.length) return false
	const normalized = [...right.features].sort()
	return left.features.every((feature, index) => feature === normalized[index])
}
