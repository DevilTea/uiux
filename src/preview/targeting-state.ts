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
	| Readonly<{ status: 'inactive' | 'suspended' | 'stale-generation' | 'stale-gesture' | 'touch-hover-ignored' | 'gesture-already-active' | 'no-gesture' }>

/**
 * Wire-independent targeting lifecycle coordinator.
 * Candidate identity/geometry remains opaque JSON because Part 3 specifies ownership and
 * lifecycle semantics but does not currently define an external targeting payload schema.
 * Event methods assume the bridge has already correlated the event to the active targeting
 * interaction; Part 3 does not yet provide a wire identity that can reject same-generation
 * delayed events from an older targeting-purpose interaction.
 * Event methods assume the bridge has already correlated the event to the active targeting
 * interaction; Part 3 does not yet provide a wire identity that can reject same-generation
 * delayed events from an older targeting-purpose interaction.
 */
export class PreviewTargetingState<Candidate extends JsonValue = JsonValue> {
	private purpose?: TargetingPurpose
	private runtimeGenerationId?: string
	private generationReady = false
	private candidatePreview?: Candidate
	private gesture?: TargetingGesture

	enterMode(purpose: TargetingPurpose): TargetingEventResult<Candidate> {
		if (this.purpose !== undefined && this.purpose !== purpose)
			this.clearTransient()
		this.purpose = purpose
		return { status: 'accepted' }
	}

	explicitCancel(): TargetingEventResult<Candidate> {
		if (!this.purpose) return { status: 'inactive' }
		const purpose = this.purpose
		this.exitMode()
		return { status: 'cancelled', purpose, reason: 'explicit' }
	}

	authoritativeModeTransition(nextPurpose?: TargetingPurpose): TargetingEventResult<Candidate> {
		if (!this.purpose) {
			if (nextPurpose) {
				this.purpose = nextPurpose
				return { status: 'accepted' }
			}
			return { status: 'inactive' }
		}
		const previous = this.purpose
		this.clearTransient()
		this.purpose = nextPurpose
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

	reportHoverCandidate(runtimeGenerationId: string, pointerType: TargetingPointerType, candidate: Candidate): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId)
		if (gate) return gate
		if (pointerType === 'touch') return { status: 'touch-hover-ignored' }
		if (this.gesture) return { status: 'gesture-already-active' }
		this.candidatePreview = cloneJson(candidate)
		return { status: 'candidate', candidate: cloneJson(candidate) }
	}

	clearHoverCandidate(runtimeGenerationId: string): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId)
		if (gate) return gate
		if (this.gesture) return { status: 'gesture-already-active' }
		this.candidatePreview = undefined
		return { status: 'accepted' }
	}

	beginGesture(runtimeGenerationId: string, pointerId: number, pointerType: TargetingPointerType): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId)
		if (gate) return gate
		assertPointerId(pointerId)
		if (this.gesture) return { status: 'gesture-already-active' }
		this.candidatePreview = undefined
		this.gesture = Object.freeze({ runtimeGenerationId, pointerId, pointerType })
		return { status: 'accepted' }
	}

	reportGestureCandidate(runtimeGenerationId: string, pointerId: number, candidate: Candidate): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId)
		if (gate) return gate
		if (!this.gesture) return { status: 'no-gesture' }
		if (this.gesture.pointerId !== pointerId) return { status: 'stale-gesture' }
		this.candidatePreview = cloneJson(candidate)
		return { status: 'candidate', candidate: cloneJson(candidate) }
	}

	commitFinalTarget(runtimeGenerationId: string, candidate: Candidate): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId)
		if (gate) return gate
		const purpose = this.purpose!
		const committed = cloneJson(candidate)
		this.exitMode()
		return { status: 'committed', purpose, candidate: committed }
	}

	onPointerCaptureLost(runtimeGenerationId: string, pointerId: number): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId)
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

	applyRuntimeEscapeIntent(runtimeGenerationId: string): TargetingEventResult<Candidate> {
		const gate = this.eventGate(runtimeGenerationId)
		if (gate) return gate
		const purpose = this.purpose!
		this.exitMode()
		return { status: 'cancelled', purpose, reason: 'escape-intent' }
	}

	snapshot(): TargetingStateSnapshot<Candidate> {
		return Object.freeze({
			...(this.purpose ? { purpose: this.purpose } : {}),
			input: this.purpose === undefined ? 'inactive' : this.generationReady ? 'ready' : 'suspended',
			...(this.runtimeGenerationId ? { runtimeGenerationId: this.runtimeGenerationId } : {}),
			...(this.candidatePreview !== undefined ? { candidatePreview: cloneJson(this.candidatePreview) } : {}),
			...(this.gesture ? { gesture: Object.freeze({ ...this.gesture }) } : {}),
		})
	}

	private eventGate(runtimeGenerationId: string): Extract<TargetingEventResult<Candidate>, { status: 'inactive' | 'suspended' | 'stale-generation' }> | undefined {
		assertOpaqueId(runtimeGenerationId, 'runtimeGenerationId')
		if (!this.purpose) return { status: 'inactive' }
		if (!this.generationReady || !this.runtimeGenerationId) return { status: 'suspended' }
		if (this.runtimeGenerationId !== runtimeGenerationId) return { status: 'stale-generation' }
		return undefined
	}

	private exitMode(): void {
		this.clearTransient()
		this.purpose = undefined
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
