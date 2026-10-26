import { inject, provide, watch, type InjectionKey } from 'vue'
import { applyEvidenceContextSelection, createWorkbenchState, type WorkbenchState } from './useWorkbenchState'
import { createPreviewSession, type PreviewSession } from './usePreviewSession'
import type { EvidenceContextSelection, ViewRouteContext } from './workbench-types'
import type { LiveBatch } from './useLiveEvents'
import { createProductKitTracker } from './product-kit-tracker'
import { bindsChangedAsset } from '../../src/assets/bindings'
import { kitBuildSettledOutput, useKitBuild } from './useKitBuild'

export type Workbench = WorkbenchState & Readonly<{
	preview: PreviewSession
	selectView: (id: string) => Promise<void>
	/** Opens a View with an explicit render context, e.g. from a deep link. */
	openView: (id: string, context: ViewRouteContext) => Promise<void>
	/**
	 * Selects a Widget. `reveal: true` marks a Checks navigation, the only selection that asks the Preview
	 * to scroll a visible but offscreen Widget into view (Rule 01a11a59-ea08-74ff-8a88-6e70b4fa3a84).
	 */
	selectWidget: (id: string, options?: Readonly<{ reveal?: boolean }>) => void
	refreshAll: () => Promise<void>
	/**
	 * Applies a batch of change events: re-reads what changed and, when what the canvas renders
	 * changed (the View's Widget IR or Variants, a Locale it shows, the manifest's render settings,
	 * the Product Kit file with the Adapters and their configuration), starts a fresh Preview
	 * generation so the open page shows it without a reload.
	 */
	applyLiveChanges: (batch: LiveBatch) => Promise<void>
	applyEvidenceContext: (context: EvidenceContextSelection) => Promise<void>
	/** The View opened most recently in this browser, if any. */
	lastViewId: () => string | undefined
}>

const WORKBENCH_KEY: InjectionKey<Workbench> = Symbol('uiux-workbench')
const LAST_VIEW_STORAGE_KEY = 'uiux.workbench.lastView'

function readLastView(): string | undefined {
	try { return globalThis.localStorage?.getItem(LAST_VIEW_STORAGE_KEY) ?? undefined }
	catch { return undefined }
}

function saveLastView(id: string): void {
	try { globalThis.localStorage?.setItem(LAST_VIEW_STORAGE_KEY, id) }
	catch { /* storage unavailable: only the convenience is lost */ }
}

/** Creates the Workbench state for the shell and provides it to every Workbench component below. */
export function provideWorkbench(): Workbench {
	const state = createWorkbenchState()
	const preview = createPreviewSession(state)

	async function selectView(id: string): Promise<void> {
		if (state.selectedViewId.value === id && state.selectedView.value?.key === id) return
		state.selectedViewId.value = id
		state.selectedWidgetId.value = 'root'
		state.selectedVariant.value = ''
		preview.noteOpenedContext({ viewId: id, widgetId: 'root' })
		saveLastView(id)
		// The Preview renders from the Product Kit file as it is now: its revision is the baseline.
		void productKit.startPreview()
		// The preview session starts a fresh runtime generation once the new View is loaded.
		await state.loadSelectedView(preview.notifyIframeContext)
	}

	async function openView(id: string, context: ViewRouteContext): Promise<void> {
		const changingView = state.selectedViewId.value !== id || state.selectedView.value?.key !== id
		state.selectedVariant.value = context.variant
		state.selectedLocale.value = context.locale
		state.selectedViewportId.value = context.viewport
		state.selectedThemeId.value = context.theme
		state.selectedWidgetId.value = context.widget || 'root'
		// A Checks navigation that waits for its stream belongs to the address it opened, and to no other.
		preview.noteOpenedContext({ viewId: id, variantId: context.variant, widgetId: context.widget })
		saveLastView(id)
		if (!changingView) return
		void productKit.startPreview()
		state.selectedViewId.value = id
		await state.loadSelectedView(preview.notifyIframeContext)
	}

	async function applyEvidenceContext(context: EvidenceContextSelection): Promise<void> {
		if (state.selectedViewId.value !== context.viewId) await selectView(context.viewId)
		applyEvidenceContextSelection(state, context)
	}

	watch([state.selectedVariant, state.selectedLocale, state.selectedViewportId, state.selectedThemeId], () => {
		preview.notifyIframeContext()
	})

	// A finished kit build may change the Adapters' Catalog, which a View's `$asset` binding diagnostics are
	// checked against (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c): the View list and the open View are read
	// again. The layout polls the build state; this only follows it.
	const kitBuild = useKitBuild()
	watch(() => kitBuild.build.value, (next, previous) => {
		if (!kitBuildSettledOutput(previous, next)) return
		void state.refreshCounts()
		if (state.selectedViewId.value) void state.loadSelectedView(undefined, { quiet: true })
	})

	/** What the Preview document of the open View renders from, as one comparable string. */
	function renderSignature(): string {
		const view = state.selectedView.value
		if (!view) return ''
		const manifest = state.workspace.value?.resource as Record<string, unknown> | undefined
		const options = state.contextOptions.value
		const locales = new Set([options.locales.selected, manifest && (manifest.i18n as { defaultLocale?: string } | undefined)?.defaultLocale].filter((code): code is string => !!code))
		return JSON.stringify([
			view.key,
			(view.resource as { ir?: unknown }).ir,
			(view.resource as { variants?: unknown }).variants,
			manifest ? [manifest.i18n, manifest.viewports, manifest.themes, manifest.adapters] : null,
			[...locales].sort().map(code => [code, state.localeRevisions.value[code] ?? null]),
		])
	}

	/** Only while a View is open does the Product Kit file matter: only the Preview renders from it. */
	const productKit = createProductKitTracker(async () => (await ($fetch as unknown as (url: string) => Promise<{ revision?: string }>)('/api/product-kit')).revision)
	const productKitMoved = async (batch: LiveBatch): Promise<boolean> => state.selectedView.value ? await productKit.moved(batch) : false

	async function applyLiveChanges(batch: LiveBatch): Promise<void> {
		const viewId = state.selectedView.value?.key
		const before = renderSignature()
		const [kitMoved] = await Promise.all([productKitMoved(batch), state.applyLiveChanges(batch)])
		const after = renderSignature()
		// A replaced or deleted Asset the View binds is resolved again by a new generation (Rule 01a167f4-48f2-7460-8c12-dfc4cda35cd0).
		const assetMoved = bindsChangedAsset((state.selectedView.value?.resource as { ir?: unknown } | undefined)?.ir, batch)
		// Selecting another View meanwhile starts its own generation.
		if (before && after && (before !== after || kitMoved || assetMoved) && state.selectedView.value?.key === viewId) preview.replaceGeneration()
	}

	const workbench: Workbench = {
		...state,
		preview,
		selectView,
		openView,
		selectWidget: preview.selectWidget,
		refreshAll: () => state.refresh(preview.notifyIframeContext),
		applyLiveChanges,
		applyEvidenceContext,
		lastViewId: readLastView,
	}
	provide(WORKBENCH_KEY, workbench)
	return workbench
}

export function useWorkbench(): Workbench {
	const workbench = inject(WORKBENCH_KEY)
	if (!workbench) throw new Error('useWorkbench() must be used below provideWorkbench().')
	return workbench
}
