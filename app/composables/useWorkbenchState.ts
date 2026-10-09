import { computed, ref, shallowRef } from 'vue'
import { useI18n } from '#imports'
import { deriveRenderContextOptions, workspaceRenderContextKeys, type RenderContextKeys } from '../../src/preview/render-context-options'
import { deriveWidgetTree, findWidgetInTree, flattenWidgetTree, type WidgetTreeNode } from '../../src/preview/widget-tree'
import { describeFetchError } from '../utils/fetch-error'
import { useUiuxClient } from './useUiuxClient'
import { useAccess } from './useAccess'
import type {
	Diagnostic,
	EvidenceContextSelection,
	FlowSummary,
	LocaleSummary,
	ReviewSummary,
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
	// Role-aware controls (accepted identity decision 12). The server remains the authority.
	const access = useAccess()
	const publicationInfo = shallowRef<PublicationInfo>()
	const workspace = ref<WorkspaceRead>()
	/**
	 * The server refuses every canonical write until an older Workspace schema is migrated
	 * (`uiux migrate`, an explicit operator act), so authoring and review controls step back too.
	 */
	const writeBlocked = computed(() => {
		const state = workspace.value?.inspection?.state
		return state === 'migration_required' || state === 'unsupported'
	})
	const authorReadOnly = computed(() => isReadOnly.value || writeBlocked.value || !access.canAuthor.value)
	const reviewReadOnly = computed(() => isReadOnly.value || writeBlocked.value || !access.canReview.value)
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

	const assetCount = ref(0)
	const flows = ref<readonly FlowSummary[]>([])
	const reviews = ref<readonly ReviewSummary[]>([])
	const flowCount = computed(() => flows.value.length)
	const reviewCount = computed(() => reviews.value.length)
	/** Threads waiting for a human: open plus ready-for-review (resolved threads are done). */
	const unresolvedReviewCount = computed(() => reviews.value.filter(review => review.summary.status !== 'resolved').length)
	const readyReviewCount = computed(() => reviews.value.filter(review => review.summary.status === 'ready-for-review').length)
	const openReviewCount = computed(() => reviews.value.filter(review => (review.summary.status ?? 'open') === 'open').length)
	/** Checks findings across the Workspace manifest and every View. */
	const workspaceFindingCount = computed(() => (workspace.value?.diagnostics?.length || 0) + views.value.reduce((sum, view) => sum + (view.diagnosticCount || 0), 0))
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

	/**
	 * The Workspace-local render-context keys (Clause 01a11e0d-d2d0) that thread capture, inbox
	 * links and the stale-key notice check against; `undefined` until the manifest is read.
	 */
	const renderContextKeys = computed<RenderContextKeys | undefined>(() => workspace.value
		? workspaceRenderContextKeys(workspace.value.resource, discoveredLocales.value)
		: undefined)

	/**
	 * The reader's own Preview context from before an inbox link applied a thread's recorded one,
	 * so the thread header can offer to open the thread in that context instead (Rule 01a1170f-c11d).
	 * Never the chrome language or theme (Rule 01a118a1-9e11).
	 */
	const contextBeforeThread = ref<Readonly<{ threadId: string; locale: string; viewport: string; theme: string }>>()

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
			uiux.listResources<FlowSummary>(['flow'], { limit: 100 }).catch(() => undefined),
			uiux.listResources<ReviewSummary>(['review'], { limit: 100 }).catch(() => undefined),
		])
		if (viewPage) views.value = viewPage.items
		if (localePage) {
			discoveredLocales.value = localePage.items.map(item => item.key)
			localeRevisions.value = Object.fromEntries(localePage.items.map(item => [item.key, item.revision]))
		}
		if (assetPage) assetCount.value = assetPage.items.length
		if (flowPage) flows.value = flowPage.items
		if (reviewPage) reviews.value = reviewPage.items
	}

	/**
	 * Re-reads the manifest and the Locale list, so recorded render-context keys are checked against
	 * the Workspace's settings at open time, not a snapshot from page load (owner ruling 2026-10-09,
	 * Discussion #7). A failed read keeps the last known state.
	 */
	async function refreshRenderContextKeys(): Promise<void> {
		const [workspaceRead, localePage] = await Promise.all([
			uiux.readResource<WorkspaceRead>('workspace', 'workspace').catch(() => undefined),
			uiux.listResources<LocaleSummary>(['locale'], { limit: 100 }).catch(() => undefined),
		])
		if (workspaceRead) workspace.value = workspaceRead
		if (localePage) {
			discoveredLocales.value = localePage.items.map(item => item.key)
			localeRevisions.value = Object.fromEntries(localePage.items.map(item => [item.key, item.revision]))
		}
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
				uiux.listResources<FlowSummary>(['flow'], { limit: 100 }).catch(() => ({ items: [] as FlowSummary[] })),
				uiux.listResources<ReviewSummary>(['review'], { limit: 100 }).catch(() => ({ items: [] as ReviewSummary[] })),
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
			flows.value = flowPage.items
			reviews.value = reviewPage.items
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
		authorReadOnly,
		reviewReadOnly,
		writeBlocked,
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
		assetCount,
		flows,
		reviews,
		flowCount,
		reviewCount,
		unresolvedReviewCount,
		readyReviewCount,
		openReviewCount,
		workspaceFindingCount,
		localeCount,
		checkCount,
		contextOptions,
		renderContextKeys,
		contextBeforeThread,
		currentActiveContext,
		widgetTreeResult,
		selectedWidgetNode,
		widgetStateOverrides,
		selectedWidgetDiagnostics,
		resolveWidgetIdFromDiagnostic,
		loadSelectedView,
		refresh,
		refreshCounts,
		refreshRenderContextKeys,
	}
}

export type WorkbenchState = ReturnType<typeof createWorkbenchState>

export function applyEvidenceContextSelection(state: WorkbenchState, context: EvidenceContextSelection): void {
	state.selectedVariant.value = context.variantName || ''
	state.selectedLocale.value = context.locale
	state.selectedViewportId.value = context.viewportId
	state.selectedThemeId.value = context.themeId
}
