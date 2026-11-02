import type { WidgetSystemRuntime } from '@deviltea/widget-core'
import { inspectRuntime } from '@deviltea/widget-core/inspection'

import type { AssetResolutionTable } from '../assets/bindings'
import type { ResolvedRenderContext } from '../domain/render-context/schema'
import type { ViewResource } from '../domain/views/schema'
import { buildViewRuntime, withoutVariant, type RuntimeAdapterBundle } from '../runtime'
import {
	encodeBaseStateResponse,
	toBaseStateValue,
	UNAVAILABLE_MEMBER,
	unavailableReadings,
	type BaseStateMember,
	type BaseStateRenderContext,
	type BaseStateRequestMessage,
	type BaseStateResponseMessage,
} from './protocol/base-state'

/**
 * The runtime side of `inspection.base-state` (issue #52; Rules 01a19a9d-9d1b-7db9-a535-96dedc258395
 * and 01a19ab9-d787-7025-a293-7788659bb0b0; Clauses 01a19a9b-386b-7598-a0b9-6865cb9fd6e0 and
 * 01a19ab9-cc7c-749c-98fc-ebf18dd27743).
 *
 * A Widget's base-state value is read from a separate Runtime, built from the open View with no
 * Variant and the render context's Locale, viewport and theme kept. That Runtime is never mounted,
 * so nothing renders, observes or reports for it: it emits no Widget Event, produces no Checks entry
 * or geometry, and changes no live Runtime, Evidence or canonical resource. It is disposed after the
 * read, whatever the read does.
 */

/** What the mounted Preview Runtime hands over to answer one request. */
export type BaseStateMounted = Readonly<{
	view: ViewResource
	adapters: RuntimeAdapterBundle
	assets: AssetResolutionTable
	/** The render context the live Runtime has applied: its Variant, if any, is the mounted one. */
	context: ResolvedRenderContext
	/** The revision of the View read the mounted Runtime was built from. */
	viewRevision: string
}>

export type BaseStateReading = Readonly<{
	/** The render context the values were computed for. */
	renderContext: BaseStateRenderContext
	/** One entry per requested key, in request order. */
	readings: readonly Readonly<{ key: string; member: BaseStateMember }>[]
}>

/**
 * Reads the base-state values of `widgetId`'s State members `keys` from a Runtime built just for the
 * read. A key whose Widget or State member does not exist, or whose value is not one a response may
 * carry, is Unavailable; so is every key when no base Runtime can be built. Nothing here throws, and
 * nothing here sends a `failure.report` (Clause 01a19a9b-386b-7598-a0b9-6865cb9fd6e0).
 */
export function readBaseState(
	mounted: BaseStateMounted,
	widgetId: string,
	keys: readonly string[],
	/** The Runtime builder; a test substitutes its own to observe what is built and disposed. */
	build: typeof buildViewRuntime = buildViewRuntime,
): BaseStateReading {
	const context = withoutVariant(mounted.context)
	const renderContext: BaseStateRenderContext = Object.freeze({
		viewRevision: mounted.viewRevision,
		locale: context.locale,
		viewportId: context.viewportId,
		viewport: Object.freeze({ width: context.viewport.width, height: context.viewport.height }),
		themeId: context.themeId,
	})
	let runtime: WidgetSystemRuntime | undefined
	try {
		const built = build({ view: mounted.view, adapters: mounted.adapters, assets: mounted.assets, context })
		if (built.state !== 'ready') return { renderContext, readings: unavailableReadings(keys) }
		runtime = built.runtime
		// The Widget is looked up once for all keys; a Runtime that cannot be inspected throws here.
		const inspection = inspectRuntime(runtime)
		const node = inspection.blueprint.nodes.find(candidate => candidate.resolved && candidate.node.id === widgetId)
		const widget = node?.resolved ? inspection.getWidget(node.nodeId) : null
		return { renderContext, readings: keys.map(key => ({ key, member: widget ? readMember(widget, key) : UNAVAILABLE_MEMBER })) }
	}
	catch {
		// An Adapter that throws while the Runtime is built or read leaves every key unreadable.
		return { renderContext, readings: unavailableReadings(keys) }
	}
	finally {
		try {
			runtime?.dispose()
		}
		catch {
			// A Runtime that fails to dispose is still never mounted or observed; the read is unaffected.
		}
	}
}

function readMember(widget: NonNullable<ReturnType<ReturnType<typeof inspectRuntime>['getWidget']>>, key: string): BaseStateMember {
	try {
		const state = widget.getState(key)
		if (!state) return UNAVAILABLE_MEMBER
		const copied = toBaseStateValue(state.getSnapshot().value)
		return copied.ok ? Object.freeze({ value: copied.value }) : UNAVAILABLE_MEMBER
	}
	catch {
		// A member whose read throws cannot be read.
		return UNAVAILABLE_MEMBER
	}
}

/**
 * Sends `response` through `send`. A response the bridge refuses as `invalid` (for example a
 * `renderContext` text member beyond its bound) is replaced by the same answer with every key
 * Unavailable and the same `renderContext`, so the Workbench is answered rather than left to time
 * out; `onUnsendable` is called when even that is refused. Any other result (a gate that is not
 * open) is the caller's to ignore: nothing is sent and nothing is a failure.
 */
export function sendBaseStateAnswer(
	response: BaseStateResponseMessage,
	send: (message: BaseStateResponseMessage) => Readonly<{ status: string }>,
	onUnsendable: () => void,
): void {
	if (send(response).status !== 'invalid') return
	const fallback = encodeBaseStateResponse({
		context: response.context,
		requestId: response.payload.requestId,
		widgetId: response.payload.widgetId,
		renderContext: response.payload.renderContext,
		readings: unavailableReadings(Object.keys(response.payload.values)),
	})
	if (send(fallback).status === 'invalid') onUnsendable()
}

/**
 * The response to one accepted request, or `undefined` when the runtime must drop it: nothing is
 * mounted, or `viewId` or `variantId` is not the View and Variant it has mounted (Clause
 * 01a19a9b-386b-7598-a0b9-6865cb9fd6e0). `mounted` is read at the moment of the call and is what the
 * Runtime has applied, never a context it is about to apply.
 */
export function answerBaseStateRequest(
	request: BaseStateRequestMessage,
	mounted: BaseStateMounted | undefined,
	build: typeof buildViewRuntime = buildViewRuntime,
): BaseStateResponseMessage | undefined {
	if (!mounted) return undefined
	if (request.context.viewId !== mounted.view.id || request.context.viewId !== mounted.context.viewId) return undefined
	if (request.context.variantId !== mounted.context.variantName) return undefined
	const { renderContext, readings } = readBaseState(mounted, request.payload.widgetId, request.payload.keys, build)
	return encodeBaseStateResponse({
		context: request.context,
		requestId: request.payload.requestId,
		widgetId: request.payload.widgetId,
		renderContext,
		readings,
	})
}

/** What a held request is answered by: the Preview runtime bridge, or whatever stands in for it. */
export type BaseStateAnswerer = Readonly<{
	/** Whether a Runtime is mounted now: not while linking, nor between a disposal and its replacement's mount. */
	hasMountedRuntime?(): boolean
	answerBaseStateRequest?(request: BaseStateRequestMessage): BaseStateResponseMessage | undefined
}>

/**
 * The single `inspection.base-state.request` of a generation that arrived while nothing was mounted
 * (Clause 01a19a9b-386b-7598-a0b9-6865cb9fd6e0). The Runtime that mounts the View is built after the
 * capability ACK and again for every View, Locale or Adapter change, so a request can arrive in a
 * window where no Runtime is mounted. It is held here rather than dropped: a newer one replaces it, a
 * mount that completes answers it once (or drops it by the rule `answerBaseStateRequest` applies to
 * any request), and the end of the generation discards it. The holder belongs to the generation, not
 * to a mounted runtime: a runtime disposed before it mounts takes nothing with it.
 */
export class BaseStateRequestHold {
	private held: BaseStateRequestMessage | undefined
	private ended = false

	/**
	 * @param generationEnded Whether the generation has ended (it sent its last envelope), asked
	 * whenever a request is received or a mount settles.
	 */
	constructor(private readonly generationEnded: () => boolean = () => false) {}

	/**
	 * One accepted request: answered now when a Runtime is mounted (`undefined` when it is dropped),
	 * otherwise held in place of any earlier held request, and `undefined`.
	 */
	receive(request: BaseStateRequestMessage, runtime: BaseStateAnswerer | undefined): BaseStateResponseMessage | undefined {
		if (this.isEnded()) return undefined
		if (runtime?.hasMountedRuntime?.() === true) {
			// This request is the latest: an older held one is not answered after it.
			this.held = undefined
			return runtime.answerBaseStateRequest?.(request)
		}
		this.held = request
		return undefined
	}

	/**
	 * A mount completed: answers the held request, if any, exactly once. It stays held when no Runtime
	 * is mounted after all.
	 */
	settle(runtime: BaseStateAnswerer | undefined): BaseStateResponseMessage | undefined {
		if (this.isEnded()) return undefined
		const request = this.held
		if (!request || runtime?.hasMountedRuntime?.() !== true) return undefined
		this.held = undefined
		return runtime.answerBaseStateRequest?.(request)
	}

	/** Whether a request is held. */
	get pending(): boolean {
		return this.held !== undefined
	}

	/** The generation ended: the held request is discarded, and nothing is held or answered after it. */
	end(): void {
		this.ended = true
		this.held = undefined
	}

	private isEnded(): boolean {
		if (!this.ended && this.generationEnded()) this.end()
		return this.ended
	}
}
