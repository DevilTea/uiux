import {
	isRecord,
	jsonPointer,
	validateUuid,
	Validator,
	type ValidationResult,
} from '../../domain/validation'

/**
 * Widget Event reporting for the Prototype player (Part 2 implementation-recovery decision group
 * "Widget Event reporting", accepted 2026-10-05, decisions 3, 9 and 10).
 *
 * The Workbench arms the runtime with the current step's outgoing triggers (`widget.event.arm`),
 * and the runtime reports at most one armed occurrence per arm (`widget.event.occurrence`). Both
 * travel in the accepted `{ type, context, payload }` envelope on the protocol channel, through the
 * protocol bridges, so session, generation and capability-ACK gating are the bridge's. `armId` is
 * work-specific identity and sits in `payload`, like `sequence`; the `context` key set stays closed.
 */

/** Optional capability feature; `protocolVersion` stays 1 (decision 10). */
export const WIDGET_EVENTS_FEATURE = 'widget.events'
/** Upper bound of `widget.event.arm.payload.triggers` (decision 3, R5). */
export const MAX_ARMED_TRIGGERS = 256

export type WidgetEventArmContext = Readonly<{
	previewSessionId: string
	runtimeGenerationId: string
	viewId: string
	/** The Variant name, present exactly when the step targets a named Variant. */
	variantId?: string
}>

export type WidgetEventOccurrenceContext = WidgetEventArmContext & Readonly<{ widgetId: string }>

export type WidgetEventTrigger = Readonly<{ widgetId: string; event: string }>

/** Workbench → runtime: replaces the previous arm entirely; an empty `triggers` disarms. No ACK. */
export type WidgetEventArmMessage = Readonly<{
	type: 'widget.event.arm'
	context: WidgetEventArmContext
	payload: Readonly<{ armId: string; triggers: readonly WidgetEventTrigger[] }>
}>

/**
 * Runtime → Workbench: one armed occurrence. The payload is closed for senders: no arguments,
 * argument counts or types, hashes, DOM targets, coordinates, key codes, text or timestamps.
 */
export type WidgetEventOccurrenceMessage = Readonly<{
	type: 'widget.event.occurrence'
	context: WidgetEventOccurrenceContext
	payload: Readonly<{ armId: string; event: string }>
}>

export type WidgetEventMessage = WidgetEventArmMessage | WidgetEventOccurrenceMessage

export const WIDGET_EVENT_MESSAGE_TYPES = ['widget.event.arm', 'widget.event.occurrence'] as const

const ARM_CONTEXT_KEYS = ['previewSessionId', 'runtimeGenerationId', 'viewId', 'variantId'] as const
const OCCURRENCE_CONTEXT_KEYS = [...ARM_CONTEXT_KEYS, 'widgetId'] as const
/** Identities that never belong to Widget Event traffic (decision 3). */
const FORBIDDEN_CONTEXT_KEYS = ['navigationRequestId', 'geometryRevision'] as const
/** Work-specific identities that belong in a payload, never in shared context. */
const PAYLOAD_ONLY_IDENTITIES = ['armId', 'triggers', 'event', 'sequence', 'targetingInteractionId'] as const

export function isWidgetEventMessageType(type: unknown): type is WidgetEventMessage['type'] {
	return typeof type === 'string' && (WIDGET_EVENT_MESSAGE_TYPES as readonly string[]).includes(type)
}

/** The unordered identity of one trigger pair, for set membership. */
export function widgetEventTriggerKey(trigger: WidgetEventTrigger): string {
	return JSON.stringify([trigger.widgetId, trigger.event])
}

type Mode = 'receive' | 'send'

/**
 * Validates one Widget Event message and returns a normalized copy that carries the known members
 * only. On receive, unknown additive fields are ignored (the accepted envelope rule); on send
 * (`mode: 'send'`) they are invalid, because the occurrence payload is closed for senders.
 */
export function validateWidgetEventMessage(input: unknown, mode: Mode = 'receive'): ValidationResult<WidgetEventMessage> {
	const v = new Validator()
	const envelope = v.object(input, '')
	if (!envelope) return v.finish<WidgetEventMessage>(input)
	const type = v.string(envelope.type, '/type', true)
	const context = v.object(envelope.context, '/context')
	const payload = v.object(envelope.payload, '/payload')
	if (!type || !context || !payload) return v.finish<WidgetEventMessage>(input)
	if (!isWidgetEventMessageType(type)) {
		v.issue('protocol.unknown_message_type', '/type', 'This decoder accepts only widget.event.arm and widget.event.occurrence.')
		return v.finish<WidgetEventMessage>(input)
	}
	const occurrence = type === 'widget.event.occurrence'
	const strict = mode === 'send'
	if (strict) rejectExtra(envelope, ['type', 'context', 'payload'], '', v)

	// Context: session, generation and View are mandatory; widgetId is required on an occurrence
	// and forbidden on an arm, which is about a set of Widgets.
	for (const key of ['previewSessionId', 'runtimeGenerationId', 'viewId'] as const) {
		if (!Object.hasOwn(context, key)) v.issue('protocol.missing_context_identity', `/context/${key}`, `Widget Event messages require context.${key}.`)
		else v.string(context[key], `/context/${key}`, true)
	}
	if (Object.hasOwn(context, 'viewId')) validateUuid(context.viewId, '/context/viewId', v, 'View identity')
	if (Object.hasOwn(context, 'variantId')) v.string(context.variantId, '/context/variantId', true)
	if (occurrence) {
		if (!Object.hasOwn(context, 'widgetId')) v.issue('protocol.missing_context_identity', '/context/widgetId', 'widget.event.occurrence names its Widget in context.widgetId.')
		else v.string(context.widgetId, '/context/widgetId', true)
	}
	else if (Object.hasOwn(context, 'widgetId')) {
		v.issue('protocol.inapplicable_context_identity', '/context/widgetId', 'widget.event.arm is about a set of Widgets and carries no context.widgetId.')
	}
	for (const key of FORBIDDEN_CONTEXT_KEYS) {
		if (Object.hasOwn(context, key))
			v.issue('protocol.inapplicable_context_identity', `/context/${key}`, `Widget Event messages carry no ${key}.`)
	}
	for (const key of PAYLOAD_ONLY_IDENTITIES) {
		if (Object.hasOwn(context, key))
			v.issue('protocol.identity_in_wrong_envelope', `/context/${key}`, `${key} belongs in the message payload, not in shared context.`)
	}
	for (const [key, value] of Object.entries(context)) {
		if (value === null) v.issue('protocol.null_optional_field', `/context/${key}`, 'Optional protocol fields are omitted instead of encoded as null.')
	}
	if (strict) rejectExtra(context, occurrence ? OCCURRENCE_CONTEXT_KEYS : ARM_CONTEXT_KEYS, '/context', v)

	// Payload.
	if (!Object.hasOwn(payload, 'armId')) v.issue('protocol.missing_arm_identity', '/payload/armId', 'Widget Event messages carry payload.armId.')
	else v.string(payload.armId, '/payload/armId', true)
	const triggers: WidgetEventTrigger[] = []
	if (occurrence) {
		if (!Object.hasOwn(payload, 'event')) v.issue('protocol.missing_event_name', '/payload/event', 'widget.event.occurrence names the declared Event in payload.event.')
		else v.string(payload.event, '/payload/event', true)
		if (strict) rejectExtra(payload, ['armId', 'event'], '/payload', v)
	}
	else {
		const list = v.array(payload.triggers, '/payload/triggers')
		if (list && list.length > MAX_ARMED_TRIGGERS)
			v.issue('protocol.too_many_armed_triggers', '/payload/triggers', `An arm holds at most ${MAX_ARMED_TRIGGERS} triggers.`)
		const seen = new Set<string>()
		list?.forEach((item, index) => {
			const path = jsonPointer('/payload/triggers', index)
			const trigger = v.object(item, path)
			if (!trigger) return
			if (strict) rejectExtra(trigger, ['widgetId', 'event'], path, v)
			const widgetId = v.string(trigger.widgetId, `${path}/widgetId`, true)
			const event = v.string(trigger.event, `${path}/event`, true)
			if (!widgetId || !event) return
			const key = widgetEventTriggerKey({ widgetId, event })
			if (seen.has(key)) v.issue('protocol.duplicate_armed_trigger', path, 'An arm names each { widgetId, event } pair at most once.')
			seen.add(key)
			triggers.push(Object.freeze({ widgetId, event }))
		})
		if (strict) rejectExtra(payload, ['armId', 'triggers'], '/payload', v)
	}
	if (v.diagnostics.length) return v.finish<WidgetEventMessage>(input)

	const baseContext = {
		previewSessionId: context.previewSessionId as string,
		runtimeGenerationId: context.runtimeGenerationId as string,
		viewId: context.viewId as string,
		...(typeof context.variantId === 'string' ? { variantId: context.variantId } : {}),
	}
	const normalized: WidgetEventMessage = occurrence
		? Object.freeze({
				type: 'widget.event.occurrence',
				context: Object.freeze({ ...baseContext, widgetId: context.widgetId as string }),
				payload: Object.freeze({ armId: payload.armId as string, event: payload.event as string }),
			})
		: Object.freeze({
				type: 'widget.event.arm',
				context: Object.freeze(baseContext),
				payload: Object.freeze({ armId: payload.armId as string, triggers: Object.freeze(triggers) }),
			})
	return v.finish<WidgetEventMessage>(normalized)
}

function rejectExtra(object: Record<string, unknown>, allowed: readonly string[], path: string, v: Validator): void {
	if (!isRecord(object)) return
	for (const key of Object.keys(object)) {
		if (!allowed.includes(key))
			v.issue('protocol.closed_payload_member', jsonPointer(path, key), 'Widget Event senders send the specified members only.')
	}
}
