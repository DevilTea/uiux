import { inject, provide, watch, type InjectionKey } from 'vue'
import { applyEvidenceContextSelection, createWorkbenchState, type WorkbenchState } from './useWorkbenchState'
import { createPreviewSession, type PreviewSession } from './usePreviewSession'
import type { EvidenceContextSelection, ViewRouteContext } from './workbench-types'
import type { LiveBatch } from './useLiveEvents'

export type Workbench = WorkbenchState & Readonly<{
	preview: PreviewSession
	selectView: (id: string) => Promise<void>
	/** Opens a View with an explicit render context, e.g. from a deep link. */
	openView: (id: string, context: ViewRouteContext) => Promise<void>
	selectWidget: (id: string) => void
	refreshAll: () => Promise<void>
	/**
	 * Applies a batch of change events: re-reads what changed and, when what the canvas renders
	 * changed (the View's Widget IR or Variants, a Locale it shows, the manifest's render settings),
	 * starts a fresh Preview generation so the open page shows it without a reload.
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
		saveLastView(id)
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
		saveLastView(id)
		if (!changingView) return
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

	async function applyLiveChanges(batch: LiveBatch): Promise<void> {
		const viewId = state.selectedView.value?.key
		const before = renderSignature()
		await state.applyLiveChanges(batch)
		const after = renderSignature()
		// Selecting another View meanwhile starts its own generation.
		if (before && after && before !== after && state.selectedView.value?.key === viewId) preview.replaceGeneration()
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
