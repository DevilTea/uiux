import {
	rejectUnknownKeys,
	validateUuid,
	Validator,
	type ValidationResult,
} from '../../domain/validation'

/**
 * Targeting wire messages (Part 3 implementation-recovery group "Axis-aligned quad proof and
 * the targeting wire", item 2, accepted 2026-10-05). They travel in the accepted
 * `{ type, context, payload }` envelope on the protocol channel, through the protocol bridges,
 * so session, generation and capability-ACK gating are the bridge's. `targetingInteractionId` is
 * work-specific identity and sits in `payload`, like `sequence`; the `context` key set stays closed.
 * `navigationRequestId` and `geometryRevision` are forbidden on every targeting type.
 */

export type TargetingWirePurpose = 'inspection' | 'comment-range'

export type TargetingContext = Readonly<{
	previewSessionId: string
	runtimeGenerationId: string
	viewId: string
	variantId?: string
}>

export type TargetingWidgetContext = TargetingContext & Readonly<{ widgetId: string }>

/** Workbench → runtime: starts an interaction and supersedes the previous one at once. */
export type TargetingEnterMessage = Readonly<{
	type: 'targeting.enter'
	context: TargetingContext
	payload: Readonly<{ targetingInteractionId: string; purpose: TargetingWirePurpose }>
}>

/** Workbench → runtime: ends the active interaction. */
export type TargetingExitMessage = Readonly<{
	type: 'targeting.exit'
	context: TargetingContext
	payload: Readonly<Record<string, never>>
}>

/** Runtime → Workbench: the current candidate; no `widgetId` clears it. Never sent for touch. */
export type TargetingHoverMessage = Readonly<{
	type: 'targeting.hover'
	context: TargetingContext & Readonly<{ widgetId?: string }>
	payload: Readonly<{ targetingInteractionId: string; pointerType?: 'mouse' | 'pen' }>
}>

/**
 * Runtime → Workbench: commits a target; its purpose is the interaction's own purpose.
 * During `comment-range` the runtime attaches the transient click point of the final target
 * (inner content-viewport CSS px, Part 3 "final geometry for the active interaction"; the
 * pin-hint decision's "the click point comes from the runtime's own final-target report").
 * Workbench normalizes it against the Widget's latest accepted stream report.
 */
export type TargetingSelectMessage = Readonly<{
	type: 'targeting.select'
	context: TargetingWidgetContext
	payload: Readonly<{ targetingInteractionId: string; point?: Readonly<{ x: number; y: number }> }>
}>

/** Runtime → Workbench: Escape intent during `comment-range`; Workbench performs the exit. */
export type TargetingEscapeMessage = Readonly<{
	type: 'targeting.escape'
	context: TargetingContext
	payload: Readonly<{ targetingInteractionId: string }>
}>

export type TargetingWorkbenchMessage = TargetingEnterMessage | TargetingExitMessage
export type TargetingRuntimeMessage = TargetingHoverMessage | TargetingSelectMessage | TargetingEscapeMessage
export type TargetingMessage = TargetingWorkbenchMessage | TargetingRuntimeMessage

export const TARGETING_MESSAGE_TYPES = ['targeting.enter', 'targeting.exit', 'targeting.hover', 'targeting.select', 'targeting.escape'] as const

const BASE_CONTEXT_KEYS = ['previewSessionId', 'runtimeGenerationId', 'viewId', 'variantId'] as const

export function isTargetingMessageType(type: unknown): type is TargetingMessage['type'] {
	return typeof type === 'string' && (TARGETING_MESSAGE_TYPES as readonly string[]).includes(type)
}

export function isTargetingRuntimeMessage(message: TargetingMessage): message is TargetingRuntimeMessage {
	return message.type === 'targeting.hover' || message.type === 'targeting.select' || message.type === 'targeting.escape'
}

/**
 * Validates one targeting message. Session, generation and interaction identities are mandatory
 * (item 2.3): a message lacking one is invalid and takes the protocol-failure path.
 */
export function validateTargetingMessage(input: unknown): ValidationResult<TargetingMessage> {
	const v = new Validator()
	const envelope = v.object(input, '')
	if (!envelope) return v.finish<TargetingMessage>(input)
	rejectUnknownKeys(envelope, ['type', 'context', 'payload'], '', v)
	const type = v.string(envelope.type, '/type', true)
	const context = v.object(envelope.context, '/context')
	const payload = v.object(envelope.payload, '/payload')
	if (!type || !context || !payload) return v.finish<TargetingMessage>(input)
	if (!isTargetingMessageType(type)) {
		v.issue('protocol.unknown_message_type', '/type', 'This decoder accepts only targeting.enter, exit, hover, select and escape.')
		return v.finish<TargetingMessage>(input)
	}

	const widget: 'required' | 'optional' | 'forbidden' = type === 'targeting.select' ? 'required' : type === 'targeting.hover' ? 'optional' : 'forbidden'
	rejectUnknownKeys(context, widget === 'forbidden' ? [...BASE_CONTEXT_KEYS] : [...BASE_CONTEXT_KEYS, 'widgetId'], '/context', v)
	for (const key of ['previewSessionId', 'runtimeGenerationId', 'viewId'] as const) {
		if (!Object.hasOwn(context, key)) v.issue('protocol.missing_context_identity', `/context/${key}`, `Targeting messages require context.${key}.`)
		else v.string(context[key], `/context/${key}`, true)
	}
	if (Object.hasOwn(context, 'viewId')) validateUuid(context.viewId, '/context/viewId', v, 'View identity')
	if (Object.hasOwn(context, 'variantId')) v.string(context.variantId, '/context/variantId', true)
	if (widget === 'required' && !Object.hasOwn(context, 'widgetId'))
		v.issue('protocol.missing_context_identity', '/context/widgetId', 'targeting.select names the committed Widget in context.widgetId.')
	if (Object.hasOwn(context, 'widgetId')) v.string(context.widgetId, '/context/widgetId', true)

	const interaction = () => {
		if (!Object.hasOwn(payload, 'targetingInteractionId'))
			v.issue('protocol.missing_interaction_identity', '/payload/targetingInteractionId', 'Targeting messages carry payload.targetingInteractionId.')
		else v.string(payload.targetingInteractionId, '/payload/targetingInteractionId', true)
	}
	switch (type) {
		case 'targeting.enter':
			rejectUnknownKeys(payload, ['targetingInteractionId', 'purpose'], '/payload', v)
			interaction()
			if (payload.purpose !== 'inspection' && payload.purpose !== 'comment-range')
				v.issue('protocol.invalid_targeting_purpose', '/payload/purpose', 'targeting.enter requires purpose inspection or comment-range.')
			break
		case 'targeting.exit':
			rejectUnknownKeys(payload, [], '/payload', v)
			break
		case 'targeting.hover':
			rejectUnknownKeys(payload, ['targetingInteractionId', 'pointerType'], '/payload', v)
			interaction()
			if (Object.hasOwn(payload, 'pointerType') && payload.pointerType !== 'mouse' && payload.pointerType !== 'pen')
				v.issue('protocol.invalid_pointer_type', '/payload/pointerType', 'Hover candidates come from mouse or pen only; touch never hovers.')
			break
		case 'targeting.select': {
			rejectUnknownKeys(payload, ['targetingInteractionId', 'point'], '/payload', v)
			interaction()
			if (Object.hasOwn(payload, 'point')) {
				const point = v.object(payload.point, '/payload/point')
				if (point) {
					rejectUnknownKeys(point, ['x', 'y'], '/payload/point', v)
					v.finiteNumber(point.x, '/payload/point/x')
					v.finiteNumber(point.y, '/payload/point/y')
				}
			}
			break
		}
		case 'targeting.escape':
			rejectUnknownKeys(payload, ['targetingInteractionId'], '/payload', v)
			interaction()
			break
	}
	return v.finish<TargetingMessage>(input)
}
