import { computed, onScopeDispose, watch, type ComputedRef, type Ref } from 'vue'
import {
	aggregateEdgeIndicators,
	clusterPins,
	type PinCluster,
	type PinEdgeIndicator,
	type PinPlacement,
	type PinThreadInput,
} from '../../src/preview/pin-visibility'
import { useWorkbench } from './useWorkbench'

export type { PinCluster, PinEdgeIndicator, PinPlacement, PinThreadInput } from '../../src/preview/pin-visibility'

export type PinPlacementsApi = Readonly<{
	/** One entry per input thread, in input order. */
	placements: ComputedRef<readonly PinPlacement[]>
	/** Visible pins merged within 24 CSS px (presentation only). */
	clusters: ComputedRef<readonly PinCluster[]>
	/** Off-screen pins aggregated into one indicator per edge. */
	edgeIndicators: ComputedRef<readonly PinEdgeIndicator[]>
	/** Widgets that have threads but no stream because of the 64-Widget cap (or the single-stream fallback). */
	overCapWidgetIds: ComputedRef<readonly string[]>
}>

/**
 * The pins consumer of the Preview geometry streams (Part 2/3, 2026-10-05 multi-target group).
 *
 * Give it the in-scope comment threads; it tracks their Widgets (decision 6 priority, the open
 * thread and the pending composer first) and returns each thread's placement: `visible` with the pin tip `point` in the
 * canvas overlay layer's CSS px, `offscreen` with an `edge` indicator, `hidden` with a `reason`,
 * or `invalid` for an anchor whose Widget is gone. It draws nothing: the pin visuals are the
 * caller's. Must be used below `provideWorkbench()`, inside a component or effect scope; the
 * tracking ends when that scope is disposed.
 */
export function usePinPlacements(
	threads: Ref<readonly PinThreadInput[]>,
	options: Readonly<{ openThreadId?: Ref<string | undefined>; pendingThreadId?: Ref<string | undefined> }> = {},
): PinPlacementsApi {
	const { preview } = useWorkbench()
	const owner = {}
	watch([threads, () => options.openThreadId?.value, () => options.pendingThreadId?.value], ([next, openThreadId, pendingThreadId]) => {
		preview.setPinThreads(next, { ...(openThreadId ? { openThreadId } : {}), ...(pendingThreadId ? { pendingThreadId } : {}) }, owner)
	}, { immediate: true })
	// Releases only this consumer's threads: the next View page declares its pins before this scope ends.
	onScopeDispose(() => preview.releasePinThreads(owner))

	const placements = computed(() => preview.pinPlacements.value)
	return Object.freeze({
		placements,
		clusters: computed(() => clusterPins(placements.value)),
		edgeIndicators: computed(() => aggregateEdgeIndicators(placements.value)),
		overCapWidgetIds: computed(() => {
			void placements.value
			return preview.geometryStreams.overCapWidgets()
		}),
	})
}
