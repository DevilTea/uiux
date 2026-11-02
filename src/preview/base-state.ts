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
		return { renderContext, readings: keys.map(key => ({ key, member: readMember(runtime!, widgetId, key) })) }
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

function readMember(runtime: WidgetSystemRuntime, widgetId: string, key: string): BaseStateMember {
	try {
		const inspection = inspectRuntime(runtime)
		const node = inspection.blueprint.nodes.find(candidate => candidate.resolved && candidate.node.id === widgetId)
		if (!node?.resolved) return UNAVAILABLE_MEMBER
		const state = inspection.getWidget(node.nodeId)?.getState(key)
		if (!state) return UNAVAILABLE_MEMBER
		const copied = toBaseStateValue(state.getSnapshot().value)
		return copied.ok ? Object.freeze({ value: copied.value }) : UNAVAILABLE_MEMBER
	}
	catch {
		// A Runtime this widget-core module instance did not create (`WidgetInspectionError`) cannot be
		// read, and neither can a member whose read throws.
		return UNAVAILABLE_MEMBER
	}
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
