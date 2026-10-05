import { inject, provide, watch, type InjectionKey } from 'vue'
import { applyEvidenceContextSelection, createWorkbenchState, type WorkbenchState } from './useWorkbenchState'
import { createPreviewSession, type PreviewSession } from './usePreviewSession'
import type { EvidenceContextSelection, ViewRouteContext } from './workbench-types'

export type Workbench = WorkbenchState & Readonly<{
	preview: PreviewSession
	selectView: (id: string) => Promise<void>
	/** Opens a View with an explicit render context, e.g. from a deep link. */
	openView: (id: string, context: ViewRouteContext) => Promise<void>
	selectWidget: (id: string) => void
	refreshAll: () => Promise<void>
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
		await state.loadSelectedView(preview.notifyIframeContext)
		preview.replaceGeneration()
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
		preview.replaceGeneration()
	}

	async function applyEvidenceContext(context: EvidenceContextSelection): Promise<void> {
		if (state.selectedViewId.value !== context.viewId) await selectView(context.viewId)
		applyEvidenceContextSelection(state, context)
	}

	watch([state.selectedVariant, state.selectedLocale, state.selectedViewportId, state.selectedThemeId], () => {
		preview.notifyIframeContext()
	})

	const workbench: Workbench = {
		...state,
		preview,
		selectView,
		openView,
		selectWidget: preview.selectWidget,
		refreshAll: () => state.refresh(preview.notifyIframeContext),
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
