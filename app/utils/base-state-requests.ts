import {
	baseStateResponseAnswers,
	baseStateMemberOf,
	MAX_BASE_STATE_KEYS,
	MAX_BASE_STATE_TEXT_LENGTH,
	type BaseStateContext,
	type BaseStateRenderContext,
	type BaseStateRequestMessage,
	type BaseStateResponseMessage,
	type BaseStateValue,
} from '../../src/preview/protocol/base-state'
import { PARTIAL_CONTOUR_RESPONSE_TIMEOUT_MS, containsProtocolControl } from '../../src/preview/protocol/schema'

/**
 * The Workbench side of `inspection.base-state` (issue #52; Contract Clauses
 * 01a19a9b-3c4d-74cb-9695-ce20087e2188 and 01a19ab9-d028-7bb9-a370-4736992852f5; Feature Rule
 * 01a19a9d-a01a-72bd-9ea0-cad4e90ae7fc): which State members of the selected Widget to ask the
 * Preview for, one request at a time, and what each key reads meanwhile and afterwards. The controller
 * is pure: the clock, the id mint and the send are the host's, so every rule is unit-testable.
 *
 * A key reads `pending` while its request is outstanding or not yet sent, `value` once answered, and
 * `unavailable` for everything else; it never reads a default or a guess. There is no cache (Clause
 * 01a19a9b-3c4d-74cb-9695-ce20087e2188): every abandonment forgets what it had and asks again.
 */

/** How long one request waits for its response; the contour refinement wait of Clause 01a19a9b-3c4d-74cb-9695-ce20087e2188. */
export const BASE_STATE_RESPONSE_TIMEOUT_MS = PARTIAL_CONTOUR_RESPONSE_TIMEOUT_MS

/** What one State member's Base cell shows. */
export type BaseStateCell =
	| Readonly<{ status: 'pending' }>
	| Readonly<{ status: 'value'; value: BaseStateValue }>
	| Readonly<{ status: 'unavailable' }>

/**
 * What the Inspector wants read now. Any change of its identity abandons the pending request and
 * discards the unsent ones: the generation, View, the View revision the generation renders, Variant,
 * Locale, viewport, theme, the selected Widget and its overridden keys.
 */
export type BaseStateTarget = Readonly<{
	/** The Preview session, the open generation, the View and the open Variant; `undefined` while there is no generation. */
	context?: BaseStateContext
	/**
	 * Whether the open generation declared `inspection.base-state`: `undefined` while a generation is
	 * still opening (its cells read pending), `false` when it did not declare it or failed (Unavailable).
	 */
	supported: boolean | undefined
	/**
	 * The revision of the View the open generation renders and the Workbench's current Locale, viewport
	 * and theme, which a response must echo. `undefined` while the generation's revision is not known yet.
	 */
	renderContext?: BaseStateRenderContext
	/** The selected Widget, `undefined` when none is. */
	widgetId?: string
	/** The State members the open Variant overrides on that Widget. */
	keys: readonly string[]
}>

/** The part of `BridgeSendResult` this controller reads. */
export type BaseStateSendStatus = Readonly<{ status: string }>

export type BaseStateEvent =
	| Readonly<{ kind: 'response'; message: BaseStateResponseMessage }>
	| Readonly<{ kind: 'rejected'; requestId?: string }>

export type BaseStateRequestsHost = Readonly<{
	/** Sends one request; anything but `sent` means it did not leave and its keys read Unavailable. */
	send: (request: BaseStateRequestMessage) => BaseStateSendStatus
	/** A fresh non-empty `requestId`, unique within the Preview session. */
	mintRequestId: () => string
	/** Called whenever a cell may read differently. */
	changed: () => void
	setTimer?: (callback: () => void, ms: number) => unknown
	clearTimer?: (handle: unknown) => void
}>

type Pending = {
	requestId: string
	keys: readonly string[]
	/** True once this request's keys were asked again after a mismatching `renderContext`. */
	reasked: boolean
	timer: unknown
}

/** The keys of one request. */
type Batch = readonly string[]

export type BaseStateRequests = Readonly<{
	/** Points the controller at what the Inspector shows now; a target with the same identity changes nothing. */
	retarget: (target: BaseStateTarget) => void
	/** Hands it what the session received for `inspection.base-state`. */
	receive: (event: BaseStateEvent) => void
	/** What `key`'s Base cell shows now. */
	read: (key: string) => BaseStateCell
	/** Abandons everything; the controller reads Unavailable afterwards. */
	dispose: () => void
}>

let mintSequence = 0
/** A request id that no earlier controller of this page minted, so a late response of an old controller never matches a new one. */
export function mintBaseStateRequestId(): string {
	mintSequence += 1
	return `base-state-${mintSequence}-${Date.now().toString(36)}`
}

/** Splits `keys` into sequential batches of at most `MAX_BASE_STATE_KEYS`. */
export function baseStateBatches(keys: readonly string[]): readonly Batch[] {
	const batches: string[][] = []
	for (let start = 0; start < keys.length; start += MAX_BASE_STATE_KEYS) batches.push(keys.slice(start, start + MAX_BASE_STATE_KEYS))
	return batches
}

/** Display-safe text within the bound of `failure.report`: what a request may carry (Clause 01a19a9b-347f-782c-bd9a-22dc52096603). */
function sendableText(text: string): boolean {
	return text.length <= MAX_BASE_STATE_TEXT_LENGTH && !containsProtocolControl(text)
}

function sameRenderContext(a: BaseStateRenderContext, b: BaseStateRenderContext): boolean {
	return a.viewRevision === b.viewRevision
		&& a.locale === b.locale
		&& a.viewportId === b.viewportId
		&& a.viewport.width === b.viewport.width
		&& a.viewport.height === b.viewport.height
		&& a.themeId === b.themeId
}

/** The identity of a target: equal identities need no new request. `undefined` while nothing can be asked. */
function targetIdentity(target: BaseStateTarget): string | undefined {
	if (target.supported !== true || !target.context || !target.renderContext || !target.widgetId || !target.keys.length) return undefined
	const { previewSessionId, runtimeGenerationId, viewId, variantId } = target.context
	const { viewRevision, locale, viewportId, viewport, themeId } = target.renderContext
	return JSON.stringify([previewSessionId, runtimeGenerationId, viewId, variantId ?? null, viewRevision, locale, viewportId, viewport.width, viewport.height, themeId, target.widgetId, target.keys])
}

export function createBaseStateRequests(host: BaseStateRequestsHost): BaseStateRequests {
	const setTimer = host.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
	const clearTimer = host.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))

	let identity: string | undefined
	/** Nothing can be asked yet, but will be once the generation opens: the cells read pending, not Unavailable. */
	let waiting = false
	let target: BaseStateTarget | undefined
	/** Settled keys of the current target. A key absent here and in `target.keys` is pending. */
	let settled = new Map<string, BaseStateCell>()
	let batches: readonly Batch[] = []
	let nextBatch = 0
	let pending: Pending | undefined
	let disposed = false

	function abandon(): void {
		if (pending) clearTimer(pending.timer)
		pending = undefined
		settled = new Map()
		batches = []
		nextBatch = 0
	}

	function settle(keys: readonly string[], cell: BaseStateCell): void {
		for (const key of keys) settled.set(key, cell)
	}

	function finish(keys: readonly string[], cell: BaseStateCell): void {
		settle(keys, cell)
		pending = undefined
		sendNext()
		host.changed()
	}

	/** Sends the next batch that has anything to send; ends when none is left. */
	function sendNext(): void {
		while (!pending && target && nextBatch < batches.length) {
			const keys = batches[nextBatch++]!
			send(keys, false)
		}
	}

	function send(keys: readonly string[], reasked: boolean): void {
		const current = target!
		const requestId = host.mintRequestId()
		const request: BaseStateRequestMessage = {
			type: 'inspection.base-state.request',
			context: current.context!,
			payload: { requestId, widgetId: current.widgetId!, keys },
		}
		const status = host.send(request).status
		if (status !== 'sent') {
			// The request never left: nothing is pending and its keys cannot be read.
			settle(keys, UNAVAILABLE)
			return
		}
		const entry: Pending = { requestId, keys, reasked, timer: undefined }
		entry.timer = setTimer(() => {
			// A response that comes later names a request that is no longer pending, so it is stale.
			if (pending === entry) finish(keys, UNAVAILABLE)
		}, BASE_STATE_RESPONSE_TIMEOUT_MS)
		pending = entry
	}

	function start(next: BaseStateTarget): void {
		// Keys and a Widget identity beyond the text bound are never sent: they read Unavailable.
		const widgetSendable = sendableText(next.widgetId!)
		const sendable: string[] = []
		for (const key of next.keys) {
			if (widgetSendable && sendableText(key)) sendable.push(key)
			else settled.set(key, UNAVAILABLE)
		}
		batches = baseStateBatches(sendable)
		nextBatch = 0
		sendNext()
	}

	return {
		retarget(next) {
			if (disposed) return
			const nextIdentity = targetIdentity(next)
			const nextWaiting = !nextIdentity && next.keys.length > 0 && !!next.widgetId
				&& (next.supported === undefined || (next.supported === true && (!next.context || !next.renderContext)))
			if (nextIdentity === identity && nextWaiting === waiting) return
			waiting = nextWaiting
			if (nextIdentity === identity) {
				host.changed()
				return
			}
			abandon()
			identity = nextIdentity
			target = next
			if (nextIdentity) start(next)
			host.changed()
		},

		receive(event) {
			if (disposed || !pending || !target || !identity) return
			const current = pending
			if (event.kind === 'rejected') {
				// A rejection that names no request ends none: the pending one ends by its own wait.
				if (event.requestId === current.requestId) finish(current.keys, UNAVAILABLE)
				return
			}
			const { message } = event
			// A response of a request that is not pending is stale.
			if (message.payload.requestId !== current.requestId) return
			const context = target.context!
			if (message.context.previewSessionId !== context.previewSessionId
				|| message.context.runtimeGenerationId !== context.runtimeGenerationId
				|| message.context.viewId !== context.viewId
				|| message.context.variantId !== context.variantId) return
			// It names the pending request but does not answer it: rejected whole, never a protocol failure.
			if (!baseStateResponseAnswers(message, { requestId: current.requestId, widgetId: target.widgetId!, keys: current.keys })) {
				finish(current.keys, UNAVAILABLE)
				return
			}
			if (!sameRenderContext(message.payload.renderContext, target.renderContext!)) {
				// Computed for another render context: dropped, and the same keys asked once more.
				clearTimer(current.timer)
				pending = undefined
				if (current.reasked) {
					finish(current.keys, UNAVAILABLE)
					return
				}
				send(current.keys, true)
				if (!pending) sendNext()
				host.changed()
				return
			}
			clearTimer(current.timer)
			for (const key of current.keys) {
				const member = baseStateMemberOf(message.payload.values, key)
				settled.set(key, 'value' in member ? { status: 'value', value: member.value } : UNAVAILABLE)
			}
			pending = undefined
			sendNext()
			host.changed()
		},

		read(key) {
			// Not asked: the generation is still opening (pending), or it did not declare the feature, failed, or there is nothing to ask.
			if (!identity) return waiting ? PENDING : UNAVAILABLE
			return settled.get(key) ?? PENDING
		},

		dispose() {
			disposed = true
			abandon()
			identity = undefined
			waiting = false
			target = undefined
		},
	}
}

const PENDING: BaseStateCell = Object.freeze({ status: 'pending' as const })
const UNAVAILABLE: BaseStateCell = Object.freeze({ status: 'unavailable' as const })
