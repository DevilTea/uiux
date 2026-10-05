import type { JsonValue } from '../domain/validation'

export type TargetingPurpose = 'inspection' | 'comment-range'
export type TargetingPointerType = 'mouse' | 'pen' | 'touch'
export type TargetingInputState = 'inactive' | 'suspended' | 'ready'

export type TargetingGesture = Readonly<{
	runtimeGenerationId: string
	pointerId: number
	pointerType: TargetingPointerType
}>

export type TargetingStateSnapshot<Candidate extends JsonValue = JsonValue> = Readonly<{
	purpose?: TargetingPurpose
	targetingInteractionId?: string
	input: TargetingInputState
	runtimeGenerationId?: string
	candidatePreview?: Candidate
	gesture?: TargetingGesture
}>

export type TargetingEventResult<Candidate extends JsonValue = JsonValue> =
	| Readonly<{ status: 'accepted' }>
	| Readonly<{ status: 'candidate'; candidate: Candidate }>
	| Readonly<{ status: 'committed'; purpose: TargetingPurpose; candidate: Candidate }>
	| Readonly<{ status: 'cancelled'; purpose: TargetingPurpose; reason: 'explicit' | 'escape-intent' | 'authoritative-transition' }>
	| Readonly<{ status: 'gesture-cancelled'; reason: 'pointer-capture-loss' }>
	| Readonly<{ status: 'transient-cancelled'; reason: 'focus-transfer' | 'generation-teardown' }>
	| Readonly<{ status: 'inactive' | 'suspended' | 'stale-generation' | 'stale-interaction' | 'stale-gesture' | 'touch-hover-ignored' | 'gesture-already-active' | 'no-gesture' }>

/**
 * Targeting lifecycle coordinator with Workbench-owned opaque interaction correlation.
 * Stable persisted Review identity remains { viewId, widgetId }; candidate/range geometry stays transient.
 * Every runtime-originated event must match both the active generation and targetingInteractionId so
 * delayed traffic from a replaced/re-entered interaction cannot mutate the current mode.
 */
export class PreviewTargetingState<Candidate extends JsonValue = JsonValue> {
	private purpose?: TargetingPurpose
	private targetingInteractionId?: string
	private readonly retiredTargetingInteractionIds = new Set<string>()
	private runtimeGenerationId?: string
	private generationReady = false
	private candidatePreview?: Candidate
	private gesture?: TargetingGesture

	enterMode(purpose: TargetingPurpose, targetingInteractionId: string): TargetingEventResult<Candidate> {
		assertOpaqueId(targetingInteractionId, 'targetingInteractionId')
		if (!this.purpose) {
			this.assertInteractionAvailable(targetingInteractionId)
			this.purpose = purpose
			this.targetingInteractionId = targetingInteractionId
			return { status: 'accepted' }
		}

		if (this.targetingInteractionId === targetingInteractionId) {
			if (this.purpose !== purpose)
				throw new TypeError('Replacing targeting purpose requires a fresh targetingInteractionId.')
			return { status: 'accepted' }
		}

		this.assertInteractionAvailable(targetingInteractionId)
		this.retireActiveInteraction()
		this.clearTransient()
		this.purpose = purpose
		this.targetingInteractionId = targetingInteractionId
		return { status: 'accepted' }
	}

	explicitCancel(): TargetingEventResult<Candidate> {
		if (!this.purpose) return { status: 'inactive' }
		const purpose = this.purpose
		this.exitMode()
		return { status: 'cancelled', purpose, reason: 'explicit' }
	}

	authoritativeModeTransition(nextPurpose?: TargetingPurpose, targetingInteractionId?: string): TargetingEventResult<Candidate> {
		if (!this.purpose) {
			if (!nextPurpose) return { status: 'inactive' }
			if (!targetingInteractionId) throw new TypeError('targetingInteractionId is required when entering targeting mode.')
			assertOpaqueId(targetingInteractionId, 'targetingInteractionId')
			this.assertInteractionAvailable(targetingInteractionId)
			this.purpose = nextPurpose
			this.targetingInteractionId = targetingInteractionId
			return { status: 'accepted' }
		}

		if (nextPurpose) {
			if (!targetingInteractionId) throw new TypeError('targetingInteractionId is required when replacing targeting mode.')
			assertOpaqueId(targetingInteractionId, 'targetingInteractionId')
			if (targetingInteractionId === this.targetingInteractionId)
				throw new TypeError('Authoritative targeting replacement requires a fresh targetingInteractionId.')
			this.assertInteractionAvailable(targetingInteractionId)
		}

		const previous = this.purpose
		this.retireActiveInteraction()
		this.clearTransient()
		this.purpose = nextPurpose
		this.targetingInteractionId = nextPurpose ? targetingInteractionId : undefined
		return { status: 'cancelled', purpose: previous, reason: 'authoritative-transition' }
	}

	markGenerationReady(runtimeGenerationId: string): TargetingEventResult<Candidate> {
		assertOpaqueId(runtimeGenerationId, 'runtimeGenerationId')
		if (this.runtimeGenerationId !== runtimeGenerationId) this.clearTransient()
		this.runtimeGenerationId = runtimeGenerationId
		this.generationReady = true
		return { status: 'accepted' }
	}

	onGenerationTeardown(runtimeGenerationId: string): TargetingEventResult<Candidate> {
		assertOpaqueId(runtimeGenerationId, 'runtimeGenerationId')
		if (this.runtimeGenerationId !== runtimeGenerationId) return { status: 'stale-generation' }
		const hadGestureOrCandidate = this.gesture !== undefined || this.candidatePreview !== undefined
		this.clearTransient()
		this.runtimeGenerationId = undefined
		this.generationReady = false
		if (hadGestureOrCandidate && this.purpose) return { status: 'transient-cancelled', reason: 'generation-teardown' }
		return { status: 'accepted' }
	}

	reportHoverCandidate(runtimeGenerationId: string, targetingInteractionId: string, pointerType: TargetingPointerType, candidate: Candidate): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId, targetingInteractionId)
		if (gate) return gate
		if (pointerType === 'touch') return { status: 'touch-hover-ignored' }
		if (this.gesture) return { status: 'gesture-already-active' }
		this.candidatePreview = cloneJson(candidate)
		return { status: 'candidate', candidate: cloneJson(candidate) }
	}

	clearHoverCandidate(runtimeGenerationId: string, targetingInteractionId: string): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId, targetingInteractionId)
		if (gate) return gate
		if (this.gesture) return { status: 'gesture-already-active' }
		this.candidatePreview = undefined
		return { status: 'accepted' }
	}

	beginGesture(runtimeGenerationId: string, targetingInteractionId: string, pointerId: number, pointerType: TargetingPointerType): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId, targetingInteractionId)
		if (gate) return gate
		assertPointerId(pointerId)
		if (this.gesture) return { status: 'gesture-already-active' }
		this.candidatePreview = undefined
		this.gesture = Object.freeze({ runtimeGenerationId, pointerId, pointerType })
		return { status: 'accepted' }
	}

	reportGestureCandidate(runtimeGenerationId: string, targetingInteractionId: string, pointerId: number, candidate: Candidate): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId, targetingInteractionId)
		if (gate) return gate
		if (!this.gesture) return { status: 'no-gesture' }
		if (this.gesture.pointerId !== pointerId) return { status: 'stale-gesture' }
		this.candidatePreview = cloneJson(candidate)
		return { status: 'candidate', candidate: cloneJson(candidate) }
	}

	commitFinalTarget(runtimeGenerationId: string, targetingInteractionId: string, candidate: Candidate): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId, targetingInteractionId)
		if (gate) return gate
		const purpose = this.purpose!
		const committed = cloneJson(candidate)
		this.exitMode()
		return { status: 'committed', purpose, candidate: committed }
	}

	onPointerCaptureLost(runtimeGenerationId: string, targetingInteractionId: string, pointerId: number): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId, targetingInteractionId)
		if (gate) return gate
		if (!this.gesture) return { status: 'no-gesture' }
		if (this.gesture.pointerId !== pointerId) return { status: 'stale-gesture' }
		this.clearTransient()
		return { status: 'gesture-cancelled', reason: 'pointer-capture-loss' }
	}

	onFocusTransferredToWorkbench(): TargetingEventResult<Candidate> {
		if (!this.purpose) return { status: 'inactive' }
		const hadTransient = this.gesture !== undefined || this.candidatePreview !== undefined
		this.clearTransient()
		return hadTransient
			? { status: 'transient-cancelled', reason: 'focus-transfer' }
			: { status: 'accepted' }
	}

	applyRuntimeEscapeIntent(runtimeGenerationId: string, targetingInteractionId: string): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId, targetingInteractionId)
		if (gate) return gate
		const purpose = this.purpose!
		this.exitMode()
		return { status: 'cancelled', purpose, reason: 'escape-intent' }
	}

	snapshot(): TargetingStateSnapshot<Candidate> {
		return Object.freeze({
			...(this.purpose ? { purpose: this.purpose } : {}),
			...(this.targetingInteractionId ? { targetingInteractionId: this.targetingInteractionId } : {}),
			input: this.purpose === undefined ? 'inactive' : this.generationReady ? 'ready' : 'suspended',
			...(this.runtimeGenerationId ? { runtimeGenerationId: this.runtimeGenerationId } : {}),
			...(this.candidatePreview !== undefined ? { candidatePreview: cloneJson(this.candidatePreview) } : {}),
			...(this.gesture ? { gesture: Object.freeze({ ...this.gesture }) } : {}),
		})
	}

	private eventGate(runtimeGenerationId: string, targetingInteractionId: string): Readonly<{ status: 'inactive' | 'suspended' | 'stale-generation' | 'stale-interaction' }> | undefined {
		assertOpaqueId(runtimeGenerationId, 'runtimeGenerationId')
		assertOpaqueId(targetingInteractionId, 'targetingInteractionId')
		if (!this.purpose) return { status: 'inactive' }
		if (!this.generationReady || !this.runtimeGenerationId) return { status: 'suspended' }
		if (this.runtimeGenerationId !== runtimeGenerationId) return { status: 'stale-generation' }
		if (this.targetingInteractionId !== targetingInteractionId) return { status: 'stale-interaction' }
		return undefined
	}

	private exitMode(): void {
		this.retireActiveInteraction()
		this.clearTransient()
		this.purpose = undefined
		this.targetingInteractionId = undefined
	}

	private assertInteractionAvailable(targetingInteractionId: string): void {
		if (this.retiredTargetingInteractionIds.has(targetingInteractionId))
			throw new TypeError('targetingInteractionId must be fresh and cannot reuse a retired interaction identity.')
	}

	private retireActiveInteraction(): void {
		if (this.targetingInteractionId) this.retiredTargetingInteractionIds.add(this.targetingInteractionId)
	}

	private clearTransient(): void {
		this.candidatePreview = undefined
		this.gesture = undefined
	}
}

function assertOpaqueId(value: string, name: string): void {
	if (!value) throw new TypeError(`${name} must be a non-empty opaque identity.`)
}

function assertPointerId(pointerId: number): void {
	if (!Number.isSafeInteger(pointerId) || pointerId < 0)
		throw new TypeError('pointerId must be a non-negative JSON safe integer.')
}

function cloneJson<T extends JsonValue>(value: T): T {
	if (value === null || typeof value !== 'object') return value
	if (Array.isArray(value)) return value.map(item => cloneJson(item)) as T
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)])) as T
}
