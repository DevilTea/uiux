import {
	WIDGET_EVENTS_FEATURE,
	widgetEventTriggerKey,
	type WidgetEventArmContext,
	type WidgetEventArmMessage,
	type WidgetEventOccurrenceMessage,
	type WidgetEventTrigger,
} from './protocol/widget-events'

/** A Widget Event occurrence that passed the Workbench gates 1–7 (Part 2 "Widget Event reporting", decision 5). */
export type WidgetEventOccurrence = Readonly<{
	runtimeGenerationId: string
	viewId: string
	variantId?: string
	widgetId: string
	event: string
	/** Gate 9, first half: the pair is in the armed set. */
	armed: boolean
}>

/**
 * The player's verdict on an occurrence: `followed` closed the entry, `closed` means the entry was
 * not open or not bound to this generation (gate 8), `unmatched` means gates 1–8 passed but no
 * transition resolved (gate 9), so the Workbench re-arms with a fresh `armId`.
 */
export type WidgetEventVerdict = 'followed' | 'closed' | 'unmatched'

/** What the arming state reads from, and sends through, the Workbench Preview session. */
export type WidgetEventArmingHost = Readonly<{
	/** The current runtime generation. */
	generation(): string
	/** The handshake of the current generation is open (its capability ACK was dispatched). */
	open(): boolean
	/** The features the current generation declared. */
	features(): readonly string[]
	/** A targeting interaction (comment-range or inspection) is active. */
	targetingActive(): boolean
	/** The mounted render context, or undefined when no View is mounted. */
	context(): WidgetEventArmContext | undefined
	/** Sends through the protocol bridge; true when it was sent. */
	send(message: WidgetEventArmMessage): boolean
	/** Mints a fresh `armId`, never reused within the session. */
	mintArmId(): string
}>

type DesiredArm = Readonly<{ runtimeGenerationId: string; triggers: readonly WidgetEventTrigger[]; key: string }>
type LiveArm = Readonly<{ armId: string; runtimeGenerationId: string; keys: ReadonlySet<string>; key: string }>

/**
 * The Workbench side of Widget Event arming (decisions 3, 5, 6 and 7).
 *
 * - The player binds a step entry's outgoing triggers to one runtime generation; the runtime is
 *   armed only after that generation's capability ACK, only when it declared `widget.events`, and
 *   only while no targeting interaction is active (one state for comment and inspection).
 * - Every arm is a full replacement with a fresh `armId`. Entering a targeting interaction sends a
 *   disarm first; an exit with no successor re-arms. Suppressed occurrences are never replayed.
 * - An occurrence passes gates 4–7 here (feature, render context, current `armId`, no targeting
 *   mode) and gates 8–9 in the player. Anything stale is dropped, never a protocol failure.
 */
export class WidgetEventArming {
	private desired?: DesiredArm
	private live?: LiveArm
	private handler?: (occurrence: WidgetEventOccurrence) => WidgetEventVerdict

	constructor(private readonly host: WidgetEventArmingHost) {}

	/** Arms `runtimeGenerationId` with a step entry's outgoing triggers (a changed set re-arms). */
	arm(triggers: readonly WidgetEventTrigger[], options: Readonly<{ runtimeGenerationId: string }>): void {
		const unique = new Map(triggers.map(trigger => [widgetEventTriggerKey(trigger), Object.freeze({ widgetId: trigger.widgetId, event: trigger.event })] as const))
		this.desired = Object.freeze({
			runtimeGenerationId: options.runtimeGenerationId,
			triggers: Object.freeze([...unique.values()]),
			key: [...unique.keys()].sort().join('|'),
		})
		this.sync()
	}

	/** Disarms explicitly; the runtime observes nothing until the next arm. */
	disarm(): void {
		this.desired = undefined
		this.sync()
	}

	/**
	 * A step entry closed: its `armId` is retired at once, without a message. The old generation
	 * is about to end, so its runtime is not explicitly disarmed (decision 7).
	 */
	retire(): void {
		this.desired = undefined
		this.live = undefined
	}

	/** A runtime generation boundary retires the arm; late occurrences fail the generation or arm gate. */
	onGenerationBoundary(): void {
		this.live = undefined
	}

	/** Registers the player's handler for occurrences that pass gates 1–7. */
	onOccurrence(handler: ((occurrence: WidgetEventOccurrence) => WidgetEventVerdict) | undefined): void {
		this.handler = handler
	}

	/** The current live `armId`, for tests and diagnostics. */
	currentArmId(): string | undefined {
		return this.live?.armId
	}

	/**
	 * Makes the runtime hold exactly what may move the player now: an arm when eligible, else a
	 * disarm replacing a live arm of this generation. `force` re-arms with a fresh `armId` even
	 * when the trigger set is unchanged. Call it on every ACK, mode change and set change.
	 */
	sync(force = false): void {
		const generation = this.host.generation()
		const desired = this.desired
		const eligible = !!desired && desired.triggers.length > 0
			&& desired.runtimeGenerationId === generation
			&& this.host.open()
			&& this.host.features().includes(WIDGET_EVENTS_FEATURE)
			&& !this.host.targetingActive()
		if (eligible) {
			if (!force && this.live?.runtimeGenerationId === generation && this.live.key === desired.key) return
			const armId = this.send(desired.triggers)
			this.live = armId
				? Object.freeze({ armId, runtimeGenerationId: generation, keys: new Set(desired.triggers.map(widgetEventTriggerKey)), key: desired.key })
				: undefined
			return
		}
		if (this.live && this.live.runtimeGenerationId === generation) this.send([])
		this.live = undefined
	}

	/**
	 * Gates 4–7 of decision 5 for an occurrence that passed the transport (origin and source) and
	 * the bridge (session, generation and capability ACK); then the player decides gates 8–9.
	 */
	receive(message: WidgetEventOccurrenceMessage): void {
		// 4. Feature: without `widget.events` this generation was never armed.
		if (!this.host.features().includes(WIDGET_EVENTS_FEATURE)) return
		// 5. Runtime context: the mounted View and Variant (both omitted for the base state).
		const context = this.host.context()
		if (!context || message.context.viewId !== context.viewId || (message.context.variantId ?? '') !== (context.variantId ?? '')) return
		// 6. Arm: only the live `armId` of this generation; a retired one is stale.
		const arm = this.live
		if (!arm || arm.armId !== message.payload.armId || arm.runtimeGenerationId !== message.context.runtimeGenerationId) return
		// 7. Mode: no comment or targeting interaction.
		if (this.host.targetingActive()) return
		// The runtime spent this arm (one occurrence per arm): retire it now.
		this.live = undefined
		const trigger = { widgetId: message.context.widgetId, event: message.payload.event }
		const verdict = this.handler?.(Object.freeze({
			runtimeGenerationId: message.context.runtimeGenerationId,
			viewId: message.context.viewId,
			...(message.context.variantId !== undefined ? { variantId: message.context.variantId } : {}),
			...trigger,
			armed: arm.keys.has(widgetEventTriggerKey(trigger)),
		})) ?? 'closed'
		// Gates 1–8 passed but no transition resolved: the entry is still open, so re-arm.
		if (verdict === 'unmatched') this.sync(true)
	}

	private send(triggers: readonly WidgetEventTrigger[]): string | undefined {
		const context = this.host.context()
		if (!context) return undefined
		const armId = this.host.mintArmId()
		return this.host.send({ type: 'widget.event.arm', context, payload: { armId, triggers } }) ? armId : undefined
	}
}
