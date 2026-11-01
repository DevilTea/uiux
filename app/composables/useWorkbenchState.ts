import { computed, ref } from 'vue'
import { useI18n } from '#imports'
import { deriveRenderContextOptions, workspaceRenderContextKeys, type RenderContextKeys } from '../../src/preview/render-context-options'
import { deriveWidgetTree, findWidgetInTree, flattenWidgetTree, type WidgetTreeNode } from '../../src/preview/widget-tree'
import { describeFetchError } from '../utils/fetch-error'
import { listAllResources } from '../utils/list-all-resources'
import { useUiuxClient } from './useUiuxClient'
import type { PermissionKey } from '../../src/application/access/keys'
import { useAccess } from './useAccess'
import type { LiveBatch } from './useLiveEvents'
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

/** The kinds whose lists the shell holds, re-read when an event names them. */
const LIVE_LIST_KINDS = ['view', 'locale', 'asset', 'flow', 'review'] as const

/**
 * Workbench data and selection state: the selected Workspace, its Views, the
 * selected View / Widget, render-context selections and section counts.
 * Created once by the Workbench page and shared through `useWorkbench()`.
 */
export function createWorkbenchState() {
	const uiux = useUiuxClient()
	const { t } = useI18n()
	// Per-key controls (Rule 01a11485-eba3-7c07-a94f-0d69e610a0b6). The server remains the authority.
	const access = useAccess()
	const workspace = ref<WorkspaceRead>()
	/**
	 * The server refuses every canonical write while the Workspace's `schemaVersion` is not the one
	 * this UIUX reads (`unsupported`), so authoring and review controls step back too.
	 */
	const writeBlocked = computed(() => workspace.value?.inspection?.state === 'unsupported')
	/**
	 * Whether the Workbench offers a write that needs `key`: the Workspace is live and supported, and
	 * the signed-in member holds the key (Discussion #140, decision 12: each page and action checks
	 * its own key). Device tiers narrow this further where each surface decides.
	 */
	function canWrite(key: PermissionKey): boolean {
		return !writeBlocked.value && access.can(key)
	}
	/** Commenting and replying need `reviews.write`; without it the Review surfaces are read-only. */
	const reviewReadOnly = computed(() => !canWrite('reviews.write'))
	const views = ref<readonly ViewSummary[]>([])
	const discoveredLocales = ref<readonly string[]>([])
	const localeRevisions = ref<Readonly<Record<string, string>>>({})
	const selectedViewId = ref<string>()
	const selectedView = ref<ViewRead>()
	const loading = ref(true)
	const detailLoading = ref(false)
	const error = ref<string>()
	let viewLoadSequence = 0
	const liveReadSequence = new Map<string, number>()

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
	/**
	 * The Workspace default Locale while it has no Locale file: a persistent Workspace configuration
	 * error (Rule 01a115cd-b2ad-7989-8faa-07d48bc8ee30) that blocks Preview and capture (Rule
	 * 01a115cd-b30b-706e-b8a2-46e62259156e). `undefined` while the file exists or before the manifest is read.
	 */
	const missingDefaultLocale = computed(() => {
		const defaultLocale = workspace.value?.resource?.i18n?.defaultLocale
		return defaultLocale && !discoveredLocales.value.includes(defaultLocale) ? defaultLocale : undefined
	})
	/** Checks findings across the Workspace manifest and every View, with the missing default-Locale file. */
	const workspaceFindingCount = computed(() => (workspace.value?.diagnostics?.length || 0) + (missingDefaultLocale.value ? 1 : 0) + views.value.reduce((sum, view) => sum + (view.diagnosticCount || 0), 0))
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

	/**
	 * Reads the selected View. `quiet` is a live refresh (Rule 01a11485-f414-7882-b94f-cd4236c26d89):
	 * the View stays on screen while it is re-read, and a failed read keeps the last one shown.
	 */
	async function loadSelectedView(onLoaded?: () => void, options: Readonly<{ quiet?: boolean }> = {}): Promise<void> {
		const requestSequence = ++viewLoadSequence
		const id = selectedViewId.value
		if (!id) {
			selectedView.value = undefined
			detailLoading.value = false
			return
		}
		if (!options.quiet) detailLoading.value = true
		try {
			const nextView = await uiux.readResource<ViewRead>('view', id)
			if (!nextView) throw new Error(t('workbench.errors.viewUnavailable'))
			if (viewLoadSequence !== requestSequence || selectedViewId.value !== id) return
			selectedView.value = nextView
			error.value = undefined
			onLoaded?.()
		}
		catch (cause) {
			if (viewLoadSequence !== requestSequence || selectedViewId.value !== id || options.quiet) return
			error.value = describeFetchError(cause, t('workbench.errors.viewLoadFailed')).message
			selectedView.value = undefined
		}
		finally {
			if (viewLoadSequence === requestSequence)
				detailLoading.value = false
		}
	}

	/** Every summary of one kind, following the list cursor (the Reviews inbox shows them all); a failed page read rejects. */
	async function listAllOrThrow<Summary>(kind: string): Promise<Summary[]> {
		return (await listAllResources<Summary>(uiux, [kind])).items
	}

	/** The same read that keeps the last known list when it fails; the next event or resync reads again. */
	async function listAll<Summary>(kind: string): Promise<Summary[] | undefined> {
		try {
			return await listAllOrThrow<Summary>(kind)
		}
		catch {
			return undefined
		}
	}

	/**
	 * Applies one batch of change events (Feature "Live refresh"): re-reads, through the list and
	 * point-read APIs, each list a changed kind appears in, the Workspace manifest when it changed,
	 * and the open View when its revision moved. Nothing shown is cleared while it is re-read, and a
	 * draft lives in its editor, which keeps it (Rule 01a11485-f414-7882-b94f-cd4236c26d89).
	 */
	async function applyLiveChanges(batch: LiveBatch, onViewLoaded?: () => void): Promise<void> {
		const kinds = new Set(batch.resync ? [...LIVE_LIST_KINDS, 'workspace'] : batch.changes.map(change => change.kind))
		const reads: Promise<void>[] = []
		// Batches can overlap: only the newest read of a kind is applied.
		const latest = (kind: string) => {
			const sequence = (liveReadSequence.get(kind) ?? 0) + 1
			liveReadSequence.set(kind, sequence)
			return () => liveReadSequence.get(kind) === sequence
		}
		// A View's diagnostics include its `$asset` bindings, checked against the Assets and the Adapters'
		// Catalog (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c): an Asset or Product Kit change re-reads them.
		const bindingInputsMoved = kinds.has('asset') || kinds.has('product-kit')
		const read = <Value>(kind: string, load: () => Promise<Value | undefined>, apply: (value: Value) => void) => {
			if (!kinds.has(kind) && !(kind === 'view' && bindingInputsMoved)) return
			const current = latest(kind)
			reads.push(load().then((value) => { if (value !== undefined && current()) apply(value) }, () => undefined))
		}
		read('workspace', () => uiux.readResource<WorkspaceRead>('workspace', 'workspace'), (value) => { workspace.value = value })
		read('view', () => listAll<ViewSummary>('view'), (items) => { views.value = items })
		read('locale', () => listAll<LocaleSummary>('locale'), (items) => {
			discoveredLocales.value = items.map(item => item.key)
			localeRevisions.value = Object.fromEntries(items.map(item => [item.key, item.revision]))
		})
		read('asset', () => listAll<unknown>('asset'), (items) => { assetCount.value = items.length })
		read('flow', () => listAll<FlowSummary>('flow'), (items) => { flows.value = items })
		read('review', () => listAll<ReviewSummary>('review'), (items) => { reviews.value = items })
		await Promise.all(reads)
		const id = selectedViewId.value
		const listed = views.value.find(view => view.key === id)
		if (id && listed && ((kinds.has('view') && listed.revision !== selectedView.value?.revision) || bindingInputsMoved))
			await loadSelectedView(onViewLoaded, { quiet: true })
	}

	/** Re-reads only the section counts shown in the navigation badges. */
	async function refreshCounts(): Promise<void> {
		const [viewItems, localeItems, assetItems, flowItems, reviewItems] = await Promise.all([
			listAll<ViewSummary>('view'),
			listAll<LocaleSummary>('locale'),
			listAll<unknown>('asset'),
			listAll<FlowSummary>('flow'),
			listAll<ReviewSummary>('review'),
		])
		if (viewItems) views.value = viewItems
		if (localeItems) {
			discoveredLocales.value = localeItems.map(item => item.key)
			localeRevisions.value = Object.fromEntries(localeItems.map(item => [item.key, item.revision]))
		}
		if (assetItems) assetCount.value = assetItems.length
		if (flowItems) flows.value = flowItems
		if (reviewItems) reviews.value = reviewItems
	}

	/**
	 * Re-reads the manifest and the Locale list, so recorded render-context keys are checked against
	 * the Workspace's settings at open time, not a snapshot from page load (owner ruling 2026-10-09,
	 * Discussion #7). A failed read keeps the last known state.
	 */
	async function refreshRenderContextKeys(): Promise<void> {
		const [workspaceRead, localeItems] = await Promise.all([
			uiux.readResource<WorkspaceRead>('workspace', 'workspace').catch(() => undefined),
			listAll<LocaleSummary>('locale'),
		])
		if (workspaceRead) workspace.value = workspaceRead
		if (localeItems) {
			discoveredLocales.value = localeItems.map(item => item.key)
			localeRevisions.value = Object.fromEntries(localeItems.map(item => [item.key, item.revision]))
		}
	}

	async function refresh(onViewLoaded?: () => void): Promise<void> {
		loading.value = true
		error.value = undefined
		try {
			const [workspaceRead, viewItems, localeItems, assetItems, flowItems, reviewItems] = await Promise.all([
				uiux.readResource<WorkspaceRead>('workspace', 'workspace'),
				listAllOrThrow<ViewSummary>('view'),
				listAllOrThrow<LocaleSummary>('locale'),
				listAllOrThrow<unknown>('asset').catch(() => [] as unknown[]),
				listAllOrThrow<FlowSummary>('flow').catch(() => [] as FlowSummary[]),
				listAllOrThrow<ReviewSummary>('review').catch(() => [] as ReviewSummary[]),
			])
			if (!workspaceRead) throw new Error(t('workbench.errors.workspaceUnavailable'))
			workspace.value = workspaceRead
			views.value = viewItems
			discoveredLocales.value = localeItems.map(item => item.key)
			localeRevisions.value = Object.fromEntries(localeItems.map(item => [item.key, item.revision]))
			assetCount.value = assetItems.length
			flows.value = flowItems
			reviews.value = reviewItems
			const selectedStillExists = selectedViewId.value && viewItems.some(item => item.key === selectedViewId.value)
			selectedViewId.value = selectedStillExists ? selectedViewId.value : viewItems[0]?.key
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
		canWrite,
		reviewReadOnly,
		writeBlocked,
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
		missingDefaultLocale,
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
		applyLiveChanges,
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
