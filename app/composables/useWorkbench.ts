import { inject, provide, watch, type InjectionKey } from 'vue'
import { applyEvidenceContextSelection, createWorkbenchState, type WorkbenchState } from './useWorkbenchState'
import { createPreviewSession, type PreviewSession } from './usePreviewSession'
import type { EvidenceContextSelection } from './workbench-types'

export type Workbench = WorkbenchState & Readonly<{
	preview: PreviewSession
	selectView: (id: string) => Promise<void>
	selectWidget: (id: string) => void
	refreshAll: () => Promise<void>
	applyEvidenceContext: (context: EvidenceContextSelection) => Promise<void>
}>

const WORKBENCH_KEY: InjectionKey<Workbench> = Symbol('uiux-workbench')

/** Creates the Workbench state for the page and provides it to every Workbench component below. */
export function provideWorkbench(): Workbench {
	const state = createWorkbenchState()
	const preview = createPreviewSession(state)

	async function selectView(id: string): Promise<void> {
		if (state.selectedViewId.value === id && state.selectedView.value?.key === id) return
		state.selectedViewId.value = id
		state.selectedWidgetId.value = 'root'
		state.selectedVariant.value = ''
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
		selectWidget: preview.selectWidget,
		refreshAll: () => state.refresh(preview.notifyIframeContext),
		applyEvidenceContext,
	}
	provide(WORKBENCH_KEY, workbench)
	return workbench
}

export function useWorkbench(): Workbench {
	const workbench = inject(WORKBENCH_KEY)
	if (!workbench) throw new Error('useWorkbench() must be used below provideWorkbench().')
	return workbench
}
