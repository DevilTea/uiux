import type { JsonValue } from '../../domain/validation'

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
export type TrafficGateResult = 'open' | 'gated' | 'stale-session' | 'stale-generation'

export type PreviewProtocolSessionSnapshot = Readonly<{
	previewSessionId: string
	currentGenerationId?: string
	currentGenerationPhase?: GenerationPhase
	retiredGenerationIds: readonly string[]
	automaticRecoveryUsed: boolean
	recoveryNeeded: boolean
	recoveryExhausted: boolean
	retryAuthorizationPending: boolean
}>

type RecoveryAttempt = 'none' | 'automatic' | 'explicit'

type ActiveGeneration = {
	id: string
	cause: GenerationAdmissionCause
	recoveryAttempt: RecoveryAttempt
	phase: GenerationPhase
	declaration?: JsonValue
}

/**
 * Wire-independent Preview session/runtime-generation state machine.
 *
 * Capability declaration/ACK message names and concrete payload fields are intentionally absent:
 * Part 2 fixes their lifecycle semantics but does not yet define those external wire schemas.
 */
export class PreviewProtocolSession {
	readonly previewSessionId: string
	private readonly retiredGenerationIds = new Set<string>()
	private current?: ActiveGeneration
	private automaticRecoveryUsed = false
	private recoveryNeeded = false
	private recoveryExhausted = false
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
			if (!this.recoveryNeeded || this.automaticRecoveryUsed || this.recoveryExhausted)
				return { status: 'invalid_state', generationId }
			this.automaticRecoveryUsed = true
			this.recoveryNeeded = false
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

	receiveCapabilityDeclaration(
		generationId: string,
		declaration: JsonValue,
		compatibility: CapabilityCompatibility,
	): CapabilityDeclarationResult {
		const current = this.current
		if (!current || current.id !== generationId) return { status: 'stale', generationId }

		if (current.declaration !== undefined) {
			if (!jsonEqual(current.declaration, declaration)) {
				this.failCurrentGeneration('protocol-invalid')
				return { status: 'capability-conflict', generationId }
			}
			return { status: 'ack-required', generationId }
		}

		current.declaration = cloneJson(declaration)
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

	authorizeRetry(): RetryAuthorizationResult {
		if (this.current && this.current.phase !== 'open') return 'ignored-active-bootstrap'
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

	private failCurrentGeneration(disposition: 'protocol-invalid' | 'capability-unavailable'): void {
		const failed = this.current
		if (!failed) return
		this.retiredGenerationIds.add(failed.id)
		this.current = undefined
		this.retryAuthorizationPending = false
		if (failed.recoveryAttempt !== 'none' || disposition === 'capability-unavailable') {
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
}

function cloneJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(cloneJson)
	if (value !== null && typeof value === 'object')
		return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, cloneJson(member)]))
	return value
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
	if (Object.is(left, right)) return true
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
		return left.every((member, index) => jsonEqual(member, right[index]!))
	}
	if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
	const leftKeys = Object.keys(left).sort()
	const rightKeys = Object.keys(right).sort()
	if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false
	return leftKeys.every(key => jsonEqual(left[key]!, right[key]!))
}
