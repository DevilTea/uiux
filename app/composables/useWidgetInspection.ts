import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { anchorViewId, anchorWidgetId, type ReviewThread } from '../../src/domain/reviews/schema'
import {
	findIrNode,
	variantDiagnostics,
	variantOverrides,
	widgetAncestry,
	widgetLabelSource,
} from '../utils/widget-inspection'
import {
	createBaseStateRequests,
	mintBaseStateRequestId,
	type BaseStateCell,
	type BaseStateTarget,
} from '../utils/base-state-requests'
import { useUiuxClient } from './useUiuxClient'
import type { Workbench } from './useWorkbench'
import type { ReviewSummary } from './workbench-types'

type LocaleRead = Readonly<{ key: string; revision: string; resource: Readonly<Record<string, string>> }>
type ReviewRead = Readonly<{ key: string; revision: string; resource: ReviewThread }>

/** A thread row in "Comments on this Widget": the summary plus its opening message, when loaded. */
export type WidgetThreadRow = Readonly<{
	key: string
	status: NonNullable<ReviewSummary['summary']['status']>
	messageCount: number
	author?: string
	excerpt?: string
	at?: string
}>

/** Threads read per selection, at most; the Comments tab lists the rest. */
const THREAD_DETAIL_LIMIT = 8

/**
 * What the Inspector shows for the selected Widget (brief e): what it is, where it sits, how this
 * Variant changes it, and what is wrong with it or said about it. `root` is the "nothing selected"
 * sentinel the canvas returns to on Escape.
 */
export function useWidgetInspection(workbench: Workbench) {
	const uiux = useUiuxClient()
	const {
		selectedView, selectedViewId, selectedWidgetId, selectedWidgetNode, widgetTreeResult,
		contextOptions, reviews, preview, resolveWidgetIdFromDiagnostic, localeRevisions,
	} = workbench

	const hasSelection = computed(() => !!selectedWidgetId.value && selectedWidgetId.value !== 'root')
	const node = computed(() => hasSelection.value ? selectedWidgetNode.value : undefined)
	/** A deep link or a structure change left the selection pointing at a Widget the View no longer has. */
	const missing = computed(() => hasSelection.value && widgetTreeResult.value?.status === 'valid' && !selectedWidgetNode.value)
	const irNode = computed(() => node.value ? findIrNode(selectedView.value?.resource.ir, node.value.id) : undefined)

	const ancestry = computed(() => {
		if (!node.value || widgetTreeResult.value?.status !== 'valid') return []
		return widgetAncestry(widgetTreeResult.value.root, node.value.id)
	})

	// The selected Locale's messages resolve `$i18n` labels, so the excerpt reads like the preview.
	const messages = shallowRef<Readonly<Record<string, string>>>({})
	const messagesFor = ref('')
	watch(() => [contextOptions.value.locales.selected, localeRevisions.value[contextOptions.value.locales.selected]] as const, async ([locale, revision]) => {
		const token = `${locale}@${revision ?? ''}`
		if (!locale || token === messagesFor.value) return
		messagesFor.value = token
		try {
			const read = await uiux.readResource<LocaleRead>('locale', locale)
			if (messagesFor.value === token) messages.value = read?.resource ?? {}
		}
		catch {
			if (messagesFor.value === token) messages.value = {}
		}
	}, { immediate: true })

	const label = computed(() => {
		const source = widgetLabelSource(irNode.value)
		if (!source) return undefined
		if (source.kind === 'text') return { text: source.value }
		const text = messages.value[source.key]
		return text?.trim() ? { text, messageKey: source.key } : { messageKey: source.key }
	})

	const variantName = computed(() => contextOptions.value.variants.selected || undefined)
	const variantInvalid = computed(() => !!variantName.value && (contextOptions.value.variants.isInvalid || !selectedView.value?.resource.variants[variantName.value]))
	const variantFaults = computed(() => variantDiagnostics(selectedView.value, variantName.value))
	const overrides = computed(() => node.value ? variantOverrides(selectedView.value, variantName.value, node.value.id) : [])

	/**
	 * The base-state values of the State members this Variant overrides on the selected Widget (issue
	 * #52, Rule 01a19a9d-a01a-72bd-9ea0-cad4e90ae7fc): read from the open Preview with one request at
	 * a time, abandoned by any change of what is shown. Nothing is asked of a Variant that is invalid.
	 */
	const baseStateVersion = ref(0)
	const baseState = createBaseStateRequests({
		send: request => preview.sendBaseStateRequest(request),
		mintRequestId: mintBaseStateRequestId,
		changed: () => { baseStateVersion.value++ },
		// A mount report retargets at once, before the watcher below runs.
		currentTarget: () => baseStateTarget.value,
	})
	const stopBaseState = preview.onBaseState(event => baseState.receive(event))
	const baseStateTarget = computed<BaseStateTarget>(() => {
		const options = contextOptions.value
		const viewId = selectedViewId.value
		const generation = preview.runtimeGenerationId.value
		// The revision of the View the open generation renders: the Preview reports it as `inspection.base-state.mounted`, and until it does Base cells read pending.
		const revision = preview.generationViewRevision.value
		const dimensions = options.viewports.selectedDimensions
		const variantId = variantName.value
		return {
			supported: preview.baseStateSupported.value,
			...(viewId && generation
				? { context: { previewSessionId: preview.previewSessionId.value, runtimeGenerationId: generation, viewId, ...(variantId ? { variantId } : {}) } }
				: {}),
			...(revision
				? {
						renderContext: {
							viewRevision: revision,
							locale: options.locales.selected,
							viewportId: options.viewports.selectedId,
							viewport: { width: dimensions.width, height: dimensions.height },
							themeId: options.themes.selected,
						},
					}
				: {}),
			...(node.value ? { widgetId: node.value.id } : {}),
			keys: variantName.value && !variantInvalid.value ? overrides.value.map(item => item.property) : [],
		}
	})
	watch(baseStateTarget, target => baseState.retarget(target), { immediate: true })
	onScopeDispose(() => {
		stopBaseState()
		baseState.dispose()
	})
	/** What each overridden State member's Base cell shows: pending, the base value, or Unavailable. */
	const baseCells = computed<ReadonlyMap<string, BaseStateCell>>(() => {
		void baseStateVersion.value
		return new Map(overrides.value.map(item => [item.property, baseState.read(item.property)]))
	})

	const findings = computed(() => {
		if (!node.value || !selectedView.value) return []
		const id = node.value.id
		return selectedView.value.diagnostics.filter(diagnostic => resolveWidgetIdFromDiagnostic(diagnostic) === id)
	})

	/** Live runtime geometry for this Widget (display only, never persisted). */
	const geometry = computed(() => {
		const value = preview.selectionGeometry.value
		return value && node.value && value.widgetId === node.value.id ? value : undefined
	})
	const visibility = computed(() => preview.selectionVisibility.value)

	const threadSummaries = computed(() => {
		if (!node.value) return []
		const id = node.value.id
		return reviews.value.filter(review => anchorViewId(review.summary.anchor) === selectedViewId.value && anchorWidgetId(review.summary.anchor) === id)
	})

	const threadDetails = shallowRef<ReadonlyMap<string, ReviewRead>>(new Map())
	let threadSequence = 0
	watch(threadSummaries, async (summaries) => {
		const sequence = ++threadSequence
		const wanted = summaries.slice(0, THREAD_DETAIL_LIMIT)
		const known = threadDetails.value
		const stale = wanted.filter(summary => known.get(summary.key)?.revision !== summary.revision)
		if (!stale.length) return
		const reads = await Promise.all(stale.map(summary => uiux.readResource<ReviewRead>('review', summary.key).catch(() => undefined)))
		if (sequence !== threadSequence) return
		const next = new Map(threadDetails.value)
		for (const read of reads) if (read) next.set(read.key, read)
		threadDetails.value = next
	}, { immediate: true })

	const threads = computed<readonly WidgetThreadRow[]>(() => threadSummaries.value.map((summary) => {
		const first = threadDetails.value.get(summary.key)?.resource.messages?.[0]
		return {
			key: summary.key,
			status: summary.summary.status ?? 'open',
			messageCount: summary.summary.messageCount ?? 0,
			...(first ? { author: first.actor.displayName || first.actor.type, excerpt: first.body, at: first.at } : {}),
		}
	}))

	return {
		hasSelection,
		node,
		missing,
		irNode,
		ancestry,
		label,
		variantName,
		variantInvalid,
		variantFaults,
		overrides,
		baseCells,
		findings,
		geometry,
		visibility,
		threads,
	}
}

export type WidgetInspection = ReturnType<typeof useWidgetInspection>
