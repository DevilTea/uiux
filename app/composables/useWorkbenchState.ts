import { computed, ref, shallowRef } from 'vue'
import { useI18n } from '#imports'
import { deriveRenderContextOptions } from '../../src/preview/render-context-options'
import { deriveWidgetTree, findWidgetInTree, flattenWidgetTree, type WidgetTreeNode } from '../../src/preview/widget-tree'
import { describeFetchError } from '../utils/fetch-error'
import { useUiuxClient } from './useUiuxClient'
import type {
	ActivePanel,
	Diagnostic,
	EvidenceContextSelection,
	LocaleSummary,
	SpecTab,
	ViewRead,
	ViewSummary,
	WorkspaceRead,
} from './workbench-types'

export type PublicationInfo = Readonly<{ publicationIdentity: string; sourceRevision?: string; generatedAt: string }>

/**
 * Workbench data and selection state: the selected Workspace, its Views, the
 * selected View / Widget, render-context selections and section counts.
 * Created once by the Workbench page and shared through `useWorkbench()`.
 */
export function createWorkbenchState() {
	const uiux = useUiuxClient()
	const { t } = useI18n()
	const isReadOnly = uiux.isReadOnly

	const publicationInfo = shallowRef<PublicationInfo>()
	const workspace = ref<WorkspaceRead>()
	const views = ref<readonly ViewSummary[]>([])
	const discoveredLocales = ref<readonly string[]>([])
	const localeRevisions = ref<Readonly<Record<string, string>>>({})
	const selectedViewId = ref<string>()
	const selectedView = ref<ViewRead>()
	const loading = ref(true)
	const detailLoading = ref(false)
	const error = ref<string>()
	let viewLoadSequence = 0

	// Render context selections. Empty means "use the effective default" from contextOptions.
	const selectedVariant = ref('')
	const selectedLocale = ref('')
	const selectedViewportId = ref('')
	const selectedThemeId = ref('')

	const selectedWidgetId = ref('root')
	const activeNav = ref<ActivePanel>('views')
	const activeSpecTab = ref<SpecTab>('spec')
	const specPanelExpanded = ref(true)

	const assetCount = ref(0)
	const flowCount = ref(0)
	const reviewCount = ref(0)
	const localeCount = computed(() => discoveredLocales.value.length)
	const checkCount = computed(() => (selectedView.value?.diagnostics?.length || 0) + (workspace.value?.diagnostics?.length || 0))

	const contextOptions = computed(() => deriveRenderContextOptions({
		workspace: workspace.value?.resource,
		view: selectedView.value?.resource,
		discoveredLocales: discoveredLocales.value,
		selectedVariant: selectedVariant.value,
		selectedLocale: selectedLocale.value,
		selectedViewportId: selectedViewportId.value,
		selectedThemeId: selectedThemeId.value,
	}))

	const currentActiveContext = computed(() => {
		if (!selectedView.value) return undefined
		const options = contextOptions.value
		const viewport = options.viewports.selectedDimensions
		return {
			viewId: selectedView.value.key,
			variantName: options.variants.selected || undefined,
			locale: options.locales.selected,
			viewportId: options.viewports.selectedId,
			viewport: { width: viewport.width, height: viewport.height },
			themeId: options.themes.selected,
		}
	})

	const widgetTreeResult = computed(() => {
		if (!selectedView.value?.resource.ir) return undefined
		return deriveWidgetTree(selectedView.value.resource.ir)
	})

	const selectedWidgetNode = computed<WidgetTreeNode | undefined>(() => {
		if (!widgetTreeResult.value || widgetTreeResult.value.status !== 'valid') return undefined
		return findWidgetInTree(widgetTreeResult.value.root, selectedWidgetId.value)
	})

	const widgetStateOverrides = computed(() => {
		if (!selectedVariant.value || !selectedView.value?.resource.variants) return undefined
		const variant = selectedView.value.resource.variants[selectedVariant.value]
		if (!variant || !variant.state) return undefined
		return variant.state[selectedWidgetId.value]
	})

	const selectedWidgetDiagnostics = computed(() => {
		if (!selectedView.value?.diagnostics) return []
		const targetPath = selectedWidgetId.value === 'root' ? '/ir' : '/ir/slots'
		return selectedView.value.diagnostics.filter(item => item.path.includes(targetPath))
	})

	function resolveWidgetIdFromDiagnostic(diagnostic: Diagnostic): string | undefined {
		const path = diagnostic.path || ''
		if (path === '/ir' || path === '/ir/') return 'root'
		const slotMatch = path.match(/^\/ir\/slots\/([^/]+)\/(\d+)/)
		if (slotMatch && selectedView.value?.resource.ir && typeof selectedView.value.resource.ir === 'object') {
			const slotName = slotMatch[1]!
			const slotIndex = Number(slotMatch[2])
			const slots = (selectedView.value.resource.ir as Record<string, unknown>).slots
			if (slots && typeof slots === 'object') {
				const entries = (slots as Record<string, unknown>)[slotName]
				if (Array.isArray(entries) && entries[slotIndex] && typeof entries[slotIndex] === 'object') {
					const id = (entries[slotIndex] as Record<string, unknown>).id
					if (typeof id === 'string') return id
				}
			}
		}
		if (widgetTreeResult.value?.status === 'valid') {
			for (const widget of flattenWidgetTree(widgetTreeResult.value.root)) {
				if (widget.id !== 'root' && (path.includes(widget.id) || diagnostic.message.includes(`#${widget.id}`) || diagnostic.message.includes(`"${widget.id}"`)))
					return widget.id
			}
		}
		return undefined
	}

	async function loadSelectedView(onLoaded?: () => void): Promise<void> {
		const requestSequence = ++viewLoadSequence
		const id = selectedViewId.value
		if (!id) {
			selectedView.value = undefined
			detailLoading.value = false
			return
		}
		detailLoading.value = true
		try {
			const nextView = await uiux.readResource<ViewRead>('view', id)
			if (!nextView) throw new Error(t('workbench.errors.viewUnavailable'))
			if (viewLoadSequence !== requestSequence || selectedViewId.value !== id) return
			selectedView.value = nextView
			error.value = undefined
			onLoaded?.()
		}
		catch (cause) {
			if (viewLoadSequence !== requestSequence || selectedViewId.value !== id) return
			error.value = describeFetchError(cause, t('workbench.errors.viewLoadFailed')).message
			selectedView.value = undefined
		}
		finally {
			if (viewLoadSequence === requestSequence)
				detailLoading.value = false
		}
	}

	/** Re-reads only the section counts shown in the navigation badges. */
	async function refreshCounts(): Promise<void> {
		const [viewPage, localePage, assetPage, flowPage, reviewPage] = await Promise.all([
			uiux.listResources<ViewSummary>(['view'], { limit: 100 }).catch(() => undefined),
			uiux.listResources<LocaleSummary>(['locale'], { limit: 100 }).catch(() => undefined),
			uiux.listResources<unknown>(['asset'], { limit: 100 }).catch(() => undefined),
			uiux.listResources<unknown>(['flow'], { limit: 100 }).catch(() => undefined),
			uiux.listResources<unknown>(['review'], { limit: 100 }).catch(() => undefined),
		])
		if (viewPage) views.value = viewPage.items
		if (localePage) {
			discoveredLocales.value = localePage.items.map(item => item.key)
			localeRevisions.value = Object.fromEntries(localePage.items.map(item => [item.key, item.revision]))
		}
		if (assetPage) assetCount.value = assetPage.items.length
		if (flowPage) flowCount.value = flowPage.items.length
		if (reviewPage) reviewCount.value = reviewPage.items.length
	}

	async function refresh(onViewLoaded?: () => void): Promise<void> {
		loading.value = true
		error.value = undefined
		try {
			const [workspaceRead, viewPage, localePage, assetPage, flowPage, reviewPage] = await Promise.all([
				uiux.readResource<WorkspaceRead>('workspace', 'workspace'),
				uiux.listResources<ViewSummary>(['view'], { limit: 100 }),
				uiux.listResources<LocaleSummary>(['locale'], { limit: 100 }),
				uiux.listResources<unknown>(['asset'], { limit: 100 }).catch(() => ({ items: [] })),
				uiux.listResources<unknown>(['flow'], { limit: 100 }).catch(() => ({ items: [] })),
				uiux.listResources<unknown>(['review'], { limit: 100 }).catch(() => ({ items: [] })),
			])
			if (!workspaceRead) throw new Error(t('workbench.errors.workspaceUnavailable'))
			if (isReadOnly.value) {
				const snapshot = await uiux.publication()
				publicationInfo.value = {
					publicationIdentity: snapshot.publicationIdentity,
					generatedAt: snapshot.generatedAt,
					...(snapshot.sourceRevision ? { sourceRevision: snapshot.sourceRevision } : {}),
				}
			}
			workspace.value = workspaceRead
			views.value = viewPage.items
			discoveredLocales.value = localePage.items.map(item => item.key)
			localeRevisions.value = Object.fromEntries(localePage.items.map(item => [item.key, item.revision]))
			assetCount.value = assetPage.items.length
			flowCount.value = flowPage.items.length
			reviewCount.value = reviewPage.items.length
			const selectedStillExists = selectedViewId.value && viewPage.items.some(item => item.key === selectedViewId.value)
			selectedViewId.value = selectedStillExists ? selectedViewId.value : viewPage.items[0]?.key
			await loadSelectedView(onViewLoaded)
		}
		catch (cause) {
			error.value = describeFetchError(cause, t('workbench.errors.workspaceReadFailed')).message
		}
		finally {
			loading.value = false
		}
	}

	return {
		isReadOnly,
		publicationInfo,
		workspace,
		views,
		discoveredLocales,
		localeRevisions,
		selectedViewId,
		selectedView,
		loading,
		detailLoading,
		error,
		selectedVariant,
		selectedLocale,
		selectedViewportId,
		selectedThemeId,
		selectedWidgetId,
		activeNav,
		activeSpecTab,
		specPanelExpanded,
		assetCount,
		flowCount,
		reviewCount,
		localeCount,
		checkCount,
		contextOptions,
		currentActiveContext,
		widgetTreeResult,
		selectedWidgetNode,
		widgetStateOverrides,
		selectedWidgetDiagnostics,
		resolveWidgetIdFromDiagnostic,
		loadSelectedView,
		refresh,
		refreshCounts,
	}
}

export type WorkbenchState = ReturnType<typeof createWorkbenchState>

export function applyEvidenceContextSelection(state: WorkbenchState, context: EvidenceContextSelection): void {
	state.selectedVariant.value = context.variantName || ''
	state.selectedLocale.value = context.locale
	state.selectedViewportId.value = context.viewportId
	state.selectedThemeId.value = context.themeId
}
