<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { deriveWidgetTree, findWidgetInTree, flattenWidgetTree, type WidgetTreeNode } from '../../src/preview/widget-tree'
import { deriveRenderContextOptions } from '../../src/preview/render-context-options'
import { WorkbenchPreviewProtocolBridge } from '../../src/preview/protocol/bridge'
import {
	PREVIEW_WIRE_CHANNEL,
	PREVIEW_CONTEXT_CHANNEL,
	PREVIEW_HIGHLIGHT_CHANNEL,
	PREVIEW_TARGETING_CHANNEL,
	type PreviewTargetingPayload,
} from '../../src/preview/protocol/transport'
import { PreviewNavigationState } from '../../src/preview/navigation-state'
import type { ViewResource } from '../../src/domain/views/schema'
import type { WorkspaceManifest } from '../../src/domain/workspace/schema'
import WorkspaceSettingsPanel from '../components/WorkspaceSettingsPanel.vue'
import LocalesPanel from '../components/LocalesPanel.vue'
import AssetsPanel from '../components/AssetsPanel.vue'
import FlowsPanel from '../components/FlowsPanel.vue'
import ReviewsPanel from '../components/ReviewsPanel.vue'
import ChecksPanel from '../components/ChecksPanel.vue'
import EvidencePanel from '../components/EvidencePanel.vue'
import HandoffPanel from '../components/HandoffPanel.vue'

type Diagnostic = Readonly<{ code: string; path: string; message: string }>
type WorkspaceRead = Readonly<{
	kind: 'workspace'
	key: 'workspace'
	revision: string
	diagnostics: readonly Diagnostic[]
	resource: WorkspaceManifest
}>
type ViewSummary = Readonly<{
	kind: 'view'
	key: string
	revision: string
	diagnosticCount: number
	summary: { name?: string; feature?: string }
}>
type DiscoveryPage = Readonly<{ items: readonly ViewSummary[]; nextCursor?: string }>
type LocaleSummary = Readonly<{ kind: 'locale'; key: string }>
type LocaleDiscoveryPage = Readonly<{ items: readonly LocaleSummary[] }>
type DecisionRead = Readonly<{
	id: string
	question: string
	status: 'pending' | 'deferred' | 'decided'
	outcome?: Readonly<{ summary: string; rationale: string }>
	history: readonly unknown[]
}>
type ReferenceRead = Readonly<{
	type: string
	uri: string
	label?: string
	relation?: string
}>
type ViewRead = Readonly<{
	kind: 'view'
	key: string
	revision: string
	diagnostics: readonly Diagnostic[]
	resource: ViewResource & {
		spec: {
			intent: string
			entryConditions: readonly string[]
			interactionRules: readonly string[]
			constraints: readonly string[]
			accessibility: readonly string[]
			references: readonly ReferenceRead[]
			decisions: readonly DecisionRead[]
		}
	}
}>

const workspace = ref<WorkspaceRead>()
const views = ref<readonly ViewSummary[]>([])
const discoveredLocales = ref<readonly string[]>([])
const selectedViewId = ref<string>()
const selectedView = ref<ViewRead>()
const filter = ref('')
const loading = ref(true)
const detailLoading = ref(false)
const viewLoadSequence = ref(0)
const error = ref<string>()

// Render context selections
const selectedVariant = ref<string>('')
const selectedLocale = ref<string>('')
const selectedViewportId = ref<string>('')
const selectedThemeId = ref<string>('')

// Widget tree & selection state
const selectedWidgetId = ref<string>('root')
const previewIframe = ref<HTMLIFrameElement>()
const previewCanvasArea = ref<HTMLDivElement>()
const previewCanvasSize = ref({ width: 0, height: 0 })
const PREVIEW_CANVAS_PADDING_PX = 48
const PREVIEW_FRAME_HEADER_PX = 28
const PREVIEW_FRAME_BORDER_PX = 2
let previewCanvasResizeObserver: ResizeObserver | undefined

// Preview Protocol Session & Bridge
const previewSessionId = ref<string>(`session-${Date.now()}`)
const runtimeGenerationId = ref<string>(`gen-${Date.now()}`)
const sessionPhase = ref<'initiating' | 'open' | 'failed'>('initiating')

let workbenchBridge: WorkbenchPreviewProtocolBridge | undefined
let navigationCoordinator: PreviewNavigationState | undefined

// Panel navigation: 'views' | 'workspace' | 'locales' | 'assets' | 'flows' | 'reviews' | 'checks' | 'evidence' | 'handoff'
type ActivePanel = 'views' | 'workspace' | 'locales' | 'assets' | 'flows' | 'reviews' | 'checks' | 'evidence' | 'handoff'
const activeNav = ref<ActivePanel>('views')

// Comment mode & targeting state
const isCommentMode = ref(false)
const targetingInteractionId = ref<string>()
const reviewsPanelRef = ref<InstanceType<typeof ReviewsPanel>>()

// Resource counts for badges
const assetCount = ref(0)
const flowCount = ref(0)
const reviewCount = ref(0)
const localeCount = computed(() => discoveredLocales.value.length)
const checkCount = computed(() => {
	const viewDiags = selectedView.value?.diagnostics?.length || 0
	const wsDiags = workspace.value?.diagnostics?.length || 0
	return viewDiags + wsDiags
})

// Secondary tabs: 'spec' | 'references' | 'decisions' | 'checks'
const activeBottomTab = ref<'spec' | 'references' | 'decisions' | 'checks'>('spec')
const bottomPanelExpanded = ref(true)

const visibleViews = computed(() => {
	const query = filter.value.trim().toLowerCase()
	if (!query) return views.value
	return views.value.filter((view) => {
		const fields = [view.key, view.summary.name, view.summary.feature]
		return fields.some(value => value?.toLowerCase().includes(query))
	})
})

const contextOptions = computed(() => {
	return deriveRenderContextOptions({
		workspace: workspace.value?.resource,
		view: selectedView.value?.resource,
		discoveredLocales: discoveredLocales.value,
		selectedVariant: selectedVariant.value,
		selectedLocale: selectedLocale.value,
		selectedViewportId: selectedViewportId.value,
		selectedThemeId: selectedThemeId.value,
	})
})

const currentActiveContext = computed(() => {
	if (!selectedView.value) return undefined
	const options = contextOptions.value
	const vp = options.viewports.selectedDimensions
	return {
		viewId: selectedView.value.key,
		variantName: options.variants.selected || undefined,
		locale: options.locales.selected,
		viewportId: options.viewports.selectedId,
		viewport: { width: vp.width, height: vp.height },
		themeId: options.themes.selected,
	}
})
const previewLogicalFrameSize = computed(() => {
	const viewport = contextOptions.value.viewports.selectedDimensions
	return {
		width: viewport.width + PREVIEW_FRAME_BORDER_PX,
		height: viewport.height + PREVIEW_FRAME_HEADER_PX + PREVIEW_FRAME_BORDER_PX,
	}
})

const previewScale = computed(() => {
	const logical = previewLogicalFrameSize.value
	const availableWidth = Math.max(0, previewCanvasSize.value.width - PREVIEW_CANVAS_PADDING_PX)
	const availableHeight = Math.max(0, previewCanvasSize.value.height - PREVIEW_CANVAS_PADDING_PX)
	if (!availableWidth || !availableHeight) return 1
	return Math.max(0.1, Math.min(1, availableWidth / logical.width, availableHeight / logical.height))
})

const previewScalePercent = computed(() => Math.round(previewScale.value * 100))

function measurePreviewCanvas(): void {
	const canvas = previewCanvasArea.value
	if (!canvas) return
	previewCanvasSize.value = {
		width: canvas.clientWidth,
		height: canvas.clientHeight,
	}
}

function onApplyEvidenceContext(context: {
	viewId: string
	variantName?: string
	locale: string
	viewportId: string
	themeId: string
}) {
	if (selectedViewId.value !== context.viewId) {
		selectView(context.viewId)
	}
	selectedVariant.value = context.variantName || ''
	selectedLocale.value = context.locale
	selectedViewportId.value = context.viewportId
	selectedThemeId.value = context.themeId
}

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
	const targetPath = selectedWidgetId.value === 'root' ? '/ir' : `/ir/slots`
	return selectedView.value.diagnostics.filter(d => d.path.includes(targetPath))
})

const previewIframeSrc = computed(() => {
	if (!selectedViewId.value) return ''
	const dims = contextOptions.value.viewports.selectedDimensions
	const params = new URLSearchParams({
		session: previewSessionId.value,
		generation: runtimeGenerationId.value,
		viewId: selectedViewId.value,
		locale: contextOptions.value.locales.selected,
		viewportId: contextOptions.value.viewports.selectedId,
		viewportWidth: String(dims.width),
		viewportHeight: String(dims.height),
		themeId: contextOptions.value.themes.selected,
	})
	if (contextOptions.value.variants.selected)
		params.set('variant', contextOptions.value.variants.selected)
	return `/preview?${params.toString()}`
})

function initWorkbenchBridge() {
	if (typeof window === 'undefined') return
	try {
		workbenchBridge = new WorkbenchPreviewProtocolBridge(
			previewSessionId.value,
			{
				send(message) {
					if (previewIframe.value?.contentWindow) {
						previewIframe.value.contentWindow.postMessage({ channel: PREVIEW_WIRE_CHANNEL, message }, '*')
					}
				},
			},
			declaration => declaration.protocolVersion === 1
				? { ok: true }
				: { ok: false, reason: 'capability.unsupported_protocol_version' },
		)
		workbenchBridge.admitGeneration(runtimeGenerationId.value, 'initial')
		navigationCoordinator = new PreviewNavigationState({
			viewId: selectedViewId.value || '',
			selectedWidgetId: selectedWidgetId.value,
		})
	}
	catch (cause) {
		sessionPhase.value = 'failed'
		error.value = cause instanceof Error ? cause.message : 'Workbench bridge initialization failed.'
	}
}

function onWindowMessage(event: MessageEvent) {
	const data = event.data
	if (!data || typeof data !== 'object') return

	if (data.channel === PREVIEW_WIRE_CHANNEL && data.message && workbenchBridge) {
		const result = workbenchBridge.receive(data.message)
		if (result.status === 'ack-dispatched') {
			sessionPhase.value = 'open'
		}
		else if (result.status === 'capability-failure' || result.status === 'invalid') {
			sessionPhase.value = 'failed'
		}
	}
	else if (data.channel === PREVIEW_TARGETING_CHANNEL && data.payload) {
		const payload = data.payload as PreviewTargetingPayload
		if (payload.type === 'select' && payload.widgetId) {
			selectWidget(payload.widgetId)
			activeNav.value = 'reviews'
			isCommentMode.value = false
			if (previewIframe.value?.contentWindow) {
				previewIframe.value.contentWindow.postMessage({
					channel: PREVIEW_TARGETING_CHANNEL,
					payload: { type: 'exit' },
				}, '*')
				previewIframe.value.contentWindow.postMessage({
					channel: PREVIEW_HIGHLIGHT_CHANNEL,
					payload: { commentMode: false },
				}, '*')
			}
			reviewsPanelRef.value?.openCreateModal(payload.widgetId)
		}
		else if (payload.type === 'escape') {
			isCommentMode.value = false
		}
	}
}

function toggleCommentMode() {
	isCommentMode.value = !isCommentMode.value
	if (isCommentMode.value) {
		targetingInteractionId.value = `target-${Date.now()}`
		if (previewIframe.value?.contentWindow) {
			previewIframe.value.contentWindow.postMessage({
				channel: PREVIEW_TARGETING_CHANNEL,
				payload: {
					type: 'enter',
					purpose: 'comment-range',
					targetingInteractionId: targetingInteractionId.value,
				},
			}, '*')
			previewIframe.value.contentWindow.postMessage({
				channel: PREVIEW_HIGHLIGHT_CHANNEL,
				payload: {
					commentMode: true,
					targetingInteractionId: targetingInteractionId.value,
				},
			}, '*')
		}
	}
	else {
		if (previewIframe.value?.contentWindow) {
			previewIframe.value.contentWindow.postMessage({
				channel: PREVIEW_TARGETING_CHANNEL,
				payload: {
					type: 'exit',
				},
			}, '*')
			previewIframe.value.contentWindow.postMessage({
				channel: PREVIEW_HIGHLIGHT_CHANNEL,
				payload: {
					commentMode: false,
				},
			}, '*')
		}
	}
}

function notifyIframeContext() {
	if (!previewIframe.value?.contentWindow || !selectedViewId.value) return
	const dims = contextOptions.value.viewports.selectedDimensions
	previewIframe.value.contentWindow.postMessage({
		channel: PREVIEW_CONTEXT_CHANNEL,
		payload: {
			viewId: selectedViewId.value,
			variantName: contextOptions.value.variants.selected,
			locale: contextOptions.value.locales.selected,
			viewportId: contextOptions.value.viewports.selectedId,
			viewport: { width: dims.width, height: dims.height },
			themeId: contextOptions.value.themes.selected,
		},
	}, '*')
}

function selectWidget(id: string) {
	selectedWidgetId.value = id
	if (selectedViewId.value && navigationCoordinator) {
		const reqId = `nav-${Date.now()}`
		navigationCoordinator.requestChecksNavigation({
			navigationRequestId: reqId,
			viewId: selectedViewId.value,
			widgetId: id,
		})
		navigationCoordinator.applyNavigationResolution({
			navigationRequestId: reqId,
			viewId: selectedViewId.value,
			widgetId: id,
		}, 'resolved')
	}
	if (previewIframe.value?.contentWindow) {
		previewIframe.value.contentWindow.postMessage({
			channel: PREVIEW_HIGHLIGHT_CHANNEL,
			payload: { widgetId: id },
		}, '*')
	}
}

function resolveWidgetIdFromDiagnostic(diag: Diagnostic): string | undefined {
	const path = diag.path || ''
	if (path === '/ir' || path === '/ir/') return 'root'
	const slotMatch = path.match(/^\/ir\/slots\/([^/]+)\/(\d+)/)
	if (slotMatch && selectedView.value?.resource.ir && typeof selectedView.value.resource.ir === 'object') {
		const slotName = slotMatch[1]!
		const slotIndex = Number(slotMatch[2])
		const slots = (selectedView.value.resource.ir as Record<string, unknown>).slots
		if (slots && typeof slots === 'object') {
			const arr = (slots as Record<string, unknown>)[slotName]
			if (Array.isArray(arr) && arr[slotIndex] && typeof arr[slotIndex] === 'object') {
				const id = (arr[slotIndex] as Record<string, unknown>).id
				if (typeof id === 'string') return id
			}
		}
	}
	if (widgetTreeResult.value?.status === 'valid') {
		const all = flattenWidgetTree(widgetTreeResult.value.root)
		for (const w of all) {
			if (w.id !== 'root' && (path.includes(w.id) || diag.message.includes(`#${w.id}`) || diag.message.includes(`"${w.id}"`))) {
				return w.id
			}
		}
	}
	return undefined
}

function handleCheckItemClick(diag: Diagnostic) {
	const resolved = resolveWidgetIdFromDiagnostic(diag)
	if (resolved) {
		selectWidget(resolved)
	}
}

async function onWorkspaceSaved() {
	await refresh()
}

async function onLocalesChanged() {
	await refresh()
}

async function onViewPromoted() {
	await loadSelectedView()
	await refresh()
}

async function refresh() {
	loading.value = true
	error.value = undefined
	try {
		const [workspaceRead, viewPage, localePage, assetPage, flowPage, reviewPage] = await Promise.all([
			$fetch<WorkspaceRead>('/api/resources/workspace/workspace'),
			$fetch<DiscoveryPage>('/api/resources/list', {
				method: 'POST',
				body: { kinds: ['view'], limit: 100 },
			}),
			$fetch<LocaleDiscoveryPage>('/api/resources/list', {
				method: 'POST',
				body: { kinds: ['locale'], limit: 100 },
			}),
			$fetch<{ items: unknown[] }>('/api/resources/list', {
				method: 'POST',
				body: { kinds: ['asset'], limit: 100 },
			}).catch(() => ({ items: [] })),
			$fetch<{ items: unknown[] }>('/api/resources/list', {
				method: 'POST',
				body: { kinds: ['flow'], limit: 100 },
			}).catch(() => ({ items: [] })),
			$fetch<{ items: unknown[] }>('/api/resources/list', {
				method: 'POST',
				body: { kinds: ['review'], limit: 100 },
			}).catch(() => ({ items: [] })),
		])
		workspace.value = workspaceRead
		views.value = viewPage.items
		discoveredLocales.value = localePage.items.map(i => i.key)
		assetCount.value = assetPage.items.length
		flowCount.value = flowPage.items.length
		reviewCount.value = reviewPage.items.length
		const selectedStillExists = selectedViewId.value && viewPage.items.some(item => item.key === selectedViewId.value)
		selectedViewId.value = selectedStillExists ? selectedViewId.value : viewPage.items[0]?.key
		await loadSelectedView()
	}
	catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'Workbench could not read the selected Workspace.'
	}
	finally {
		loading.value = false
	}
}

async function selectView(id: string) {
	if (selectedViewId.value === id && selectedView.value?.key === id) return
	selectedViewId.value = id
	selectedWidgetId.value = 'root'
	selectedVariant.value = ''
	await loadSelectedView()
	runtimeGenerationId.value = `gen-${Date.now()}`
	if (workbenchBridge) {
		workbenchBridge.replaceGenerationForLifecycle(runtimeGenerationId.value, 'reload')
		sessionPhase.value = 'initiating'
	}
}

async function loadSelectedView() {
	const requestSequence = ++viewLoadSequence.value
	const id = selectedViewId.value
	if (!id) {
		selectedView.value = undefined
		detailLoading.value = false
		return
	}
	detailLoading.value = true
	try {
		const nextView = await $fetch<ViewRead>(`/api/resources/view/${encodeURIComponent(id)}`)
		if (viewLoadSequence.value !== requestSequence || selectedViewId.value !== id) return
		selectedView.value = nextView
		error.value = undefined
		notifyIframeContext()
	}
	catch (cause) {
		if (viewLoadSequence.value !== requestSequence || selectedViewId.value !== id) return
		error.value = cause instanceof Error ? cause.message : 'View detail could not be loaded.'
		selectedView.value = undefined
	}
	finally {
		if (viewLoadSequence.value === requestSequence)
			detailLoading.value = false
	}
}

function shortRevision(revision: string) {
	return revision.length > 18 ? `${revision.slice(0, 18)}…` : revision
}

watch([selectedVariant, selectedLocale, selectedViewportId, selectedThemeId], () => {
	notifyIframeContext()
})

onMounted(() => {
	window.addEventListener('message', onWindowMessage)
	initWorkbenchBridge()
	measurePreviewCanvas()
	if (previewCanvasArea.value) {
		previewCanvasResizeObserver = new ResizeObserver(measurePreviewCanvas)
		previewCanvasResizeObserver.observe(previewCanvasArea.value)
	}
	refresh()
})

onUnmounted(() => {
	window.removeEventListener('message', onWindowMessage)
	previewCanvasResizeObserver?.disconnect()
	previewCanvasResizeObserver = undefined
})
</script>

<template>
  <main class="flex h-screen flex-col overflow-hidden bg-neutral-900 text-neutral-100">
    <!-- Top Design Tool Header Bar with Canonical Context Controls -->
    <header class="flex h-14 shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-950 px-4">
      <div class="flex items-center gap-3">
        <h1 class="text-sm font-semibold tracking-tight text-white">
          UIUX Workbench
        </h1>
        <UBadge
          color="neutral"
          variant="soft"
          size="sm"
        >
          local-first
        </UBadge>
        <span class="text-neutral-600">|</span>
        <div
          v-if="selectedView"
          class="flex items-center gap-2"
        >
          <span class="text-xs font-medium text-neutral-300">{{ selectedView.resource.name }}</span>
          <UBadge
            v-if="selectedView.resource.feature"
            color="primary"
            variant="soft"
            size="xs"
          >
            {{ selectedView.resource.feature }}
          </UBadge>
        </div>
      </div>

      <!-- Center Context Controls: Variant / Locale / Viewport / Theme -->
      <div
        v-if="selectedView"
        class="flex items-center gap-3"
      >
        <!-- Variant Control -->
        <div class="flex items-center gap-1.5 text-xs">
          <span class="text-neutral-500">Variant:</span>
          <select
            v-if="contextOptions.variants.hasVariants"
            v-model="selectedVariant"
            class="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-primary"
          >
            <option value="">
              Default (base)
            </option>
            <option
              v-for="v in contextOptions.variants.available"
              :key="v"
              :value="v"
            >
              {{ v }}
            </option>
          </select>
          <span
            v-else
            class="rounded border border-dashed border-neutral-800 bg-neutral-900/50 px-2 py-0.5 text-[11px] text-neutral-500"
          >
            None authored
          </span>
          <span
            v-if="contextOptions.variants.isInvalid"
            class="text-[10px] text-red-400"
          >Invalid</span>
        </div>

        <!-- Locale Control -->
        <div class="flex items-center gap-1.5 text-xs">
          <span class="text-neutral-500">Locale:</span>
          <select
            v-if="contextOptions.locales.hasAdditionalLocales"
            v-model="selectedLocale"
            class="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-primary"
          >
            <option
              v-for="loc in contextOptions.locales.available"
              :key="loc"
              :value="loc"
            >
              {{ loc }}
            </option>
          </select>
          <span
            v-else
            class="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 font-mono text-[11px] text-neutral-300"
          >
            {{ contextOptions.locales.defaultLocale }}
          </span>
        </div>

        <!-- Viewport Control -->
        <div class="flex items-center gap-1.5 text-xs">
          <span class="text-neutral-500">Viewport:</span>
          <select
            v-if="!contextOptions.viewports.isEmpty"
            v-model="selectedViewportId"
            class="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-primary"
          >
            <option
              v-for="vp in contextOptions.viewports.available"
              :key="vp.id"
              :value="vp.id"
            >
              {{ vp.label }}
            </option>
          </select>
          <span
            v-else
            class="rounded border border-dashed border-neutral-800 bg-neutral-900/50 px-2 py-0.5 text-[11px] text-amber-400/80"
          >
            No presets (1280 × 800)
          </span>
        </div>

        <!-- Theme Control -->
        <div class="flex items-center gap-1.5 text-xs">
          <span class="text-neutral-500">Theme:</span>
          <select
            v-if="!contextOptions.themes.isEmpty"
            v-model="selectedThemeId"
            class="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-primary"
          >
            <option
              v-for="th in contextOptions.themes.available"
              :key="th"
              :value="th"
            >
              {{ th }}
            </option>
          </select>
          <span
            v-else
            class="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-400"
          >
            Default
          </span>
        </div>
      </div>

      <!-- Right Handshake & Refresh Actions -->
      <div class="flex items-center gap-3">
        <!-- Preview Session Protocol Handshake Badge -->
        <div class="flex items-center gap-1.5 text-xs">
          <span
            class="h-2 w-2 rounded-full"
            :class="[
              sessionPhase === 'open' ? 'bg-emerald-400' : sessionPhase === 'initiating' ? 'bg-amber-400 animate-pulse' : 'bg-red-400',
            ]"
          />
          <span class="text-xs text-neutral-400">
            Session: <span class="font-mono text-neutral-200">{{ sessionPhase }}</span>
          </span>
        </div>

        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          :loading="loading"
          @click="refresh"
        >
          Refresh
        </UButton>
      </div>
    </header>

    <!-- Main Design Tool Tri-Pane Workspace -->
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <!-- Left Panel: View Navigation & First-Class Secondary Panels -->
      <aside class="flex w-80 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
        <!-- Compact Primary/Secondary Navigation Switcher -->
        <div class="grid shrink-0 grid-cols-3 gap-1 border-b border-neutral-800 bg-neutral-950 p-2 text-[11px] font-medium">
          <button
            type="button"
            class="flex min-w-0 items-center justify-center gap-1 rounded px-2 py-1 transition"
            :class="activeNav === 'views' ? 'bg-primary text-white font-semibold shadow-sm' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'"
            @click="activeNav = 'views'"
          >
            Views
            <span class="rounded bg-black/30 px-1 text-[9px]">{{ views.length }}</span>
          </button>

          <button
            type="button"
            class="flex min-w-0 items-center justify-center gap-1 rounded px-2 py-1 transition"
            :class="activeNav === 'workspace' ? 'bg-primary text-white font-semibold shadow-sm' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'"
            @click="activeNav = 'workspace'"
          >
            Workspace
          </button>

          <button
            type="button"
            class="flex min-w-0 items-center justify-center gap-1 rounded px-2 py-1 transition"
            :class="activeNav === 'locales' ? 'bg-primary text-white font-semibold shadow-sm' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'"
            @click="activeNav = 'locales'"
          >
            Locales
            <span class="rounded bg-black/30 px-1 text-[9px]">{{ localeCount }}</span>
          </button>

          <button
            type="button"
            class="flex min-w-0 items-center justify-center gap-1 rounded px-2 py-1 transition"
            :class="activeNav === 'assets' ? 'bg-primary text-white font-semibold shadow-sm' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'"
            @click="activeNav = 'assets'"
          >
            Assets
            <span class="rounded bg-black/30 px-1 text-[9px]">{{ assetCount }}</span>
          </button>

          <button
            type="button"
            class="flex min-w-0 items-center justify-center gap-1 rounded px-2 py-1 transition"
            :class="activeNav === 'flows' ? 'bg-primary text-white font-semibold shadow-sm' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'"
            @click="activeNav = 'flows'"
          >
            Flows
            <span class="rounded bg-black/30 px-1 text-[9px]">{{ flowCount }}</span>
          </button>

          <button
            type="button"
            class="flex min-w-0 items-center justify-center gap-1 rounded px-2 py-1 transition"
            :class="activeNav === 'reviews' ? 'bg-primary text-white font-semibold shadow-sm' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'"
            @click="activeNav = 'reviews'"
          >
            Reviews
            <span class="rounded bg-black/30 px-1 text-[9px]">{{ reviewCount }}</span>
          </button>

          <button
            type="button"
            class="flex min-w-0 items-center justify-center gap-1 rounded px-2 py-1 transition"
            :class="activeNav === 'checks' ? 'bg-primary text-white font-semibold shadow-sm' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'"
            @click="activeNav = 'checks'"
          >
            Checks
            <span
              v-if="checkCount > 0"
              class="rounded bg-amber-500/30 text-amber-300 px-1 text-[9px]"
            >{{ checkCount }}</span>
          </button>

          <button
            type="button"
            class="flex min-w-0 items-center justify-center gap-1 rounded px-2 py-1 transition"
            :class="activeNav === 'evidence' ? 'bg-primary text-white font-semibold shadow-sm' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'"
            @click="activeNav = 'evidence'"
          >
            Evidence
          </button>

          <button
            type="button"
            class="flex min-w-0 items-center justify-center gap-1 rounded px-2 py-1 transition"
            :class="activeNav === 'handoff' ? 'bg-primary text-white font-semibold shadow-sm' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'"
            @click="activeNav = 'handoff'"
          >
            Handoff
          </button>
        </div>

        <!-- Panel 1: Views & Widget Tree -->
        <div
          v-show="activeNav === 'views'"
          class="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <!-- Views Browser Header -->
          <div class="border-b border-neutral-800 p-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold uppercase tracking-wider text-neutral-400">Views</span>
              <UBadge
                color="neutral"
                variant="subtle"
                size="xs"
              >
                {{ views.length }}
              </UBadge>
            </div>
            <div class="mt-2">
              <UInput
                v-model="filter"
                size="xs"
                placeholder="Filter views…"
                class="w-full"
              />
            </div>
          </div>

          <!-- Views List -->
          <div class="max-h-48 overflow-y-auto border-b border-neutral-800 p-2">
            <div
              v-if="visibleViews.length"
              class="space-y-1"
            >
              <button
                v-for="view in visibleViews"
                :key="view.key"
                type="button"
                class="w-full rounded px-2.5 py-1.5 text-left text-xs transition"
                :class="selectedViewId === view.key ? 'bg-primary/20 text-white font-medium' : 'text-neutral-300 hover:bg-neutral-800/60'"
                @click="selectView(view.key)"
              >
                <div class="flex items-center justify-between gap-1">
                  <span class="truncate">{{ view.summary.name || 'Unnamed' }}</span>
                  <UBadge
                    v-if="view.diagnosticCount"
                    color="warning"
                    variant="soft"
                    size="xs"
                  >
                    {{ view.diagnosticCount }}
                  </UBadge>
                </div>
              </button>
            </div>
            <div
              v-else
              class="py-4 text-center text-xs text-neutral-500"
            >
              {{ filter.trim() ? 'No matching views' : 'No views yet' }}
            </div>
          </div>

          <!-- Canonical Widget Tree Section -->
          <div class="flex min-h-0 flex-1 flex-col">
            <div class="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
              <span class="text-xs font-semibold uppercase tracking-wider text-neutral-400">Widget Tree</span>
              <span class="text-[10px] text-neutral-500">View.ir</span>
            </div>

            <div class="flex-1 overflow-y-auto p-2">
              <div
                v-if="widgetTreeResult?.status === 'valid'"
                class="space-y-0.5 text-xs"
              >
                <!-- Recursive or flattened tree view -->
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left transition"
                  :class="selectedWidgetId === widgetTreeResult.root.id ? 'bg-primary/20 text-primary-300 font-medium' : 'text-neutral-300 hover:bg-neutral-800/60'"
                  @click="selectWidget(widgetTreeResult.root.id)"
                >
                  <span class="font-mono text-neutral-500">#</span>
                  <span class="font-semibold">{{ widgetTreeResult.root.type }}</span>
                  <span class="font-mono text-[10px] text-neutral-400">({{ widgetTreeResult.root.id }})</span>
                </button>

                <!-- Children in slot order -->
                <div
                  v-if="widgetTreeResult.root.children.length"
                  class="ml-3 border-l border-neutral-800 pl-2 space-y-0.5"
                >
                  <button
                    v-for="child in widgetTreeResult.root.children"
                    :key="child.id"
                    type="button"
                    class="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left transition"
                    :class="selectedWidgetId === child.id ? 'bg-primary/20 text-primary-300 font-medium' : 'text-neutral-300 hover:bg-neutral-800/60'"
                    @click="selectWidget(child.id)"
                  >
                    <span
                      v-if="child.slotName"
                      class="rounded bg-neutral-800 px-1 text-[9px] text-neutral-400"
                    >{{ child.slotName }}</span>
                    <span class="font-medium">{{ child.type }}</span>
                    <span class="font-mono text-[10px] text-neutral-400">#{{ child.id }}</span>
                  </button>
                </div>

                <!-- Empty Root Content indicator -->
                <div
                  v-else
                  class="ml-3 border-l border-neutral-800/60 pl-2 py-1 text-[11px] text-neutral-500 italic"
                >
                  (empty content slot)
                </div>
              </div>

              <div
                v-else-if="selectedView"
                class="p-3 text-center text-xs text-neutral-500"
              >
                {{ widgetTreeResult?.reason || 'No IR tree available' }}
              </div>
            </div>
          </div>
        </div>

        <!-- Panel 2: Workspace Settings -->
        <WorkspaceSettingsPanel
          v-if="activeNav === 'workspace'"
          :workspace="workspace"
          @saved="onWorkspaceSaved"
          @reload="refresh"
        />

        <!-- Panel 3: Locales Panel -->
        <LocalesPanel
          v-if="activeNav === 'locales'"
          :default-locale="workspace?.resource?.i18n?.defaultLocale"
          @locales-changed="onLocalesChanged"
        />

        <!-- Panel 4: Assets Panel -->
        <AssetsPanel
          v-if="activeNav === 'assets'"
        />

        <!-- Panel 5: UX Flows Panel -->
        <FlowsPanel
          v-if="activeNav === 'flows'"
          :available-views="views"
          :current-view-id="selectedViewId"
          @select-view="selectView"
        />

        <!-- Panel 6: Reviews Panel -->
        <ReviewsPanel
          v-if="activeNav === 'reviews'"
          ref="reviewsPanelRef"
          :current-view-id="selectedViewId"
          :selected-widget-id="selectedWidgetId"
          :current-view-revision="selectedView?.revision"
          :is-comment-mode="isCommentMode"
          @highlight-widget="selectWidget"
          @toggle-comment-mode="toggleCommentMode"
          @view-promoted="onViewPromoted"
        />

        <!-- Panel 7: Checks Panel -->
        <ChecksPanel
          v-if="activeNav === 'checks'"
          :workspace-diagnostics="workspace?.diagnostics"
          :view-diagnostics="selectedView?.diagnostics"
          :view-ir="selectedView?.resource.ir"
          @select-widget="selectWidget"
        />

        <!-- Panel 8: Evidence Panel -->
        <EvidencePanel
          v-if="activeNav === 'evidence'"
          :selected-view="selectedView"
          :all-views="views"
          :workspace="workspace"
          :discovered-locales="discoveredLocales"
          :active-context="currentActiveContext"
          @apply-context="onApplyEvidenceContext"
          @refresh="refresh"
        />

        <!-- Panel 9: Handoff Panel -->
        <HandoffPanel
          v-if="activeNav === 'handoff'"
          :views="views"
        />
      </aside>

      <!-- Central Preview Workspace (PRIMARY AREA - DOMINATES SCREEN) -->
      <section class="relative flex min-w-0 flex-1 flex-col bg-neutral-900">
        <!-- Canvas Toolbar -->
        <div class="flex h-9 shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-900/90 px-4 text-xs">
          <div class="flex items-center gap-2">
            <span class="font-medium text-neutral-400">Preview Canvas</span>
            <span class="text-neutral-600">·</span>
            <span class="font-mono text-neutral-300">{{ contextOptions.viewports.selectedDimensions.width }} × {{ contextOptions.viewports.selectedDimensions.height }} px</span>
          </div>

          <div class="flex items-center gap-3">
            <UButton
              :color="isCommentMode ? 'warning' : 'neutral'"
              :variant="isCommentMode ? 'solid' : 'outline'"
              size="xs"
              title="Click widgets in Preview to anchor comments"
              @click="toggleCommentMode"
            >
              {{ isCommentMode ? '🎯 Comment Mode Active (Esc)' : '💬 Comment' }}
            </UButton>
            <span class="text-neutral-600">·</span>
            <span class="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">{{ previewScalePercent }}%</span>
            <span class="text-neutral-600">·</span>
            <span class="text-neutral-400">Real Iframe Boundary</span>
          </div>
        </div>

        <!-- Central Canvas Viewport Area -->
        <div
          ref="previewCanvasArea"
          class="relative flex flex-1 items-center justify-center overflow-auto p-6 bg-[radial-gradient(#333_1px,transparent_1px)] [background-size:16px_16px]"
        >
          <!-- The iframe keeps the canonical viewport size. Only this outer presentation layer scales. -->
          <div
            v-if="selectedView"
            class="relative shrink-0"
            :style="{
              width: `${previewLogicalFrameSize.width * previewScale}px`,
              height: `${previewLogicalFrameSize.height * previewScale}px`,
            }"
          >
            <!-- Viewport Framing Container -->
            <div
              class="absolute left-0 top-0 flex flex-col rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl"
              :style="{
                width: `${previewLogicalFrameSize.width}px`,
                height: `${previewLogicalFrameSize.height}px`,
                transform: `scale(${previewScale})`,
                transformOrigin: 'top left',
              }"
            >
              <!-- Frame Window Header -->
              <div class="flex h-7 shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-900 px-3 text-[11px] text-neutral-400">
                <div class="flex items-center gap-1.5">
                  <span class="h-2 w-2 rounded-full bg-neutral-700" />
                  <span class="h-2 w-2 rounded-full bg-neutral-700" />
                  <span class="h-2 w-2 rounded-full bg-neutral-700" />
                  <span class="ml-2 font-mono text-neutral-300">{{ selectedView.resource.name }}</span>
                </div>
                <span class="font-mono text-[10px] text-neutral-500">{{ contextOptions.viewports.selectedId }}</span>
              </div>

              <!-- Real Preview Iframe Boundary: logical size remains identical to RenderContext.viewport. -->
              <iframe
                ref="previewIframe"
                :src="previewIframeSrc"
                class="block shrink-0 border-0 bg-transparent"
                :style="{
                  width: `${contextOptions.viewports.selectedDimensions.width}px`,
                  height: `${contextOptions.viewports.selectedDimensions.height}px`,
                }"
                title="UIUX View Preview"
              />
            </div>
          </div>

          <!-- Empty Workspace State -->
          <div
            v-else-if="!loading"
            class="flex flex-col items-center justify-center text-center text-neutral-500"
          >
            <p class="text-base font-medium text-neutral-300">
              No View Selected
            </p>
            <p class="mt-1 max-w-sm text-xs text-neutral-400">
              Select a View from the left navigation tree to mount the interactive preview canvas.
            </p>
          </div>
        </div>

        <!-- Secondary Bottom Panel (Spec / References / Decisions / Checks) -->
        <div class="border-t border-neutral-800 bg-neutral-950">
          <!-- Bottom Panel Header / Tabs -->
          <div class="flex h-9 items-center justify-between border-b border-neutral-800/80 px-4">
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="px-2.5 py-1 text-xs font-medium transition"
                :class="activeBottomTab === 'spec' ? 'text-primary-400 border-b-2 border-primary-400' : 'text-neutral-400 hover:text-neutral-200'"
                @click="activeBottomTab = 'spec'"
              >
                Spec
              </button>
              <button
                type="button"
                class="px-2.5 py-1 text-xs font-medium transition"
                :class="activeBottomTab === 'references' ? 'text-primary-400 border-b-2 border-primary-400' : 'text-neutral-400 hover:text-neutral-200'"
                @click="activeBottomTab = 'references'"
              >
                References ({{ selectedView?.resource.spec.references.length || 0 }})
              </button>
              <button
                type="button"
                class="px-2.5 py-1 text-xs font-medium transition"
                :class="activeBottomTab === 'decisions' ? 'text-primary-400 border-b-2 border-primary-400' : 'text-neutral-400 hover:text-neutral-200'"
                @click="activeBottomTab = 'decisions'"
              >
                Decisions ({{ selectedView?.resource.spec.decisions.length || 0 }})
              </button>
              <button
                type="button"
                class="px-2.5 py-1 text-xs font-medium transition"
                :class="activeBottomTab === 'checks' ? 'text-primary-400 border-b-2 border-primary-400' : 'text-neutral-400 hover:text-neutral-200'"
                @click="activeBottomTab = 'checks'"
              >
                Checks ({{ selectedView?.diagnostics.length || 0 }})
              </button>
            </div>

            <button
              type="button"
              class="text-xs text-neutral-500 hover:text-neutral-300"
              @click="bottomPanelExpanded = !bottomPanelExpanded"
            >
              {{ bottomPanelExpanded ? 'Collapse' : 'Expand' }}
            </button>
          </div>

          <!-- Bottom Panel Content Body -->
          <div
            v-show="bottomPanelExpanded"
            class="max-h-56 overflow-y-auto p-4 text-xs"
          >
            <!-- Spec Tab Content -->
            <div
              v-if="activeBottomTab === 'spec' && selectedView"
              class="space-y-4"
            >
              <div>
                <p class="font-semibold uppercase tracking-wider text-neutral-400">
                  Intent
                </p>
                <p class="mt-1 text-neutral-200 leading-relaxed">
                  {{ selectedView.resource.spec.intent || 'No intent authored.' }}
                </p>
              </div>

              <div class="grid grid-cols-2 gap-4">
                <div class="rounded border border-neutral-800 p-2.5">
                  <p class="font-medium text-neutral-300">
                    Entry Conditions ({{ selectedView.resource.spec.entryConditions.length }})
                  </p>
                  <ul
                    v-if="selectedView.resource.spec.entryConditions.length"
                    class="mt-1.5 space-y-1 text-neutral-400"
                  >
                    <li
                      v-for="(item, idx) in selectedView.resource.spec.entryConditions"
                      :key="idx"
                    >
                      • {{ item }}
                    </li>
                  </ul>
                  <p
                    v-else
                    class="mt-1 text-neutral-500"
                  >
                    None
                  </p>
                </div>

                <div class="rounded border border-neutral-800 p-2.5">
                  <p class="font-medium text-neutral-300">
                    Interaction Rules ({{ selectedView.resource.spec.interactionRules.length }})
                  </p>
                  <ul
                    v-if="selectedView.resource.spec.interactionRules.length"
                    class="mt-1.5 space-y-1 text-neutral-400"
                  >
                    <li
                      v-for="(item, idx) in selectedView.resource.spec.interactionRules"
                      :key="idx"
                    >
                      • {{ item }}
                    </li>
                  </ul>
                  <p
                    v-else
                    class="mt-1 text-neutral-500"
                  >
                    None
                  </p>
                </div>
              </div>
            </div>

            <!-- References Tab (Clean formatted presentation, NO RAW JSON) -->
            <div
              v-else-if="activeBottomTab === 'references' && selectedView"
              class="space-y-2"
            >
              <div
                v-if="selectedView.resource.spec.references.length"
                class="grid grid-cols-2 gap-2"
              >
                <div
                  v-for="item in selectedView.resource.spec.references"
                  :key="item.uri"
                  class="rounded border border-neutral-800 bg-neutral-900 p-2.5"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-medium text-neutral-200">{{ item.label || item.uri }}</span>
                    <div class="flex gap-1">
                      <span
                        v-if="item.type"
                        class="rounded bg-neutral-800 px-1 py-0.5 text-[9px] text-neutral-400"
                      >{{ item.type }}</span>
                      <span
                        v-if="item.relation"
                        class="rounded bg-primary/20 px-1 py-0.5 text-[9px] text-primary-300"
                      >{{ item.relation }}</span>
                    </div>
                  </div>
                  <a
                    v-if="item.uri.startsWith('http')"
                    :href="item.uri"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="mt-1 block truncate text-[11px] text-primary-400 hover:underline"
                  >
                    {{ item.uri }} ↗
                  </a>
                  <p
                    v-else
                    class="mt-1 truncate font-mono text-[10px] text-neutral-500"
                  >
                    {{ item.uri }}
                  </p>
                </div>
              </div>
              <p
                v-else
                class="text-neutral-500"
              >
                No references authored for this View.
              </p>
            </div>

            <!-- Decisions Tab Content -->
            <div
              v-else-if="activeBottomTab === 'decisions' && selectedView"
              class="space-y-2"
            >
              <div
                v-if="selectedView.resource.spec.decisions.length"
                class="space-y-2"
              >
                <div
                  v-for="dec in selectedView.resource.spec.decisions"
                  :key="dec.id"
                  class="rounded border border-neutral-800 bg-neutral-900 p-3"
                >
                  <div class="flex items-start justify-between gap-2">
                    <p class="font-medium text-neutral-200">
                      {{ dec.question }}
                    </p>
                    <UBadge
                      :color="dec.status === 'decided' ? 'success' : dec.status === 'pending' ? 'warning' : 'neutral'"
                      variant="soft"
                      size="xs"
                    >
                      {{ dec.status }}
                    </UBadge>
                  </div>
                  <p
                    v-if="dec.outcome"
                    class="mt-1.5 text-neutral-300"
                  >
                    <span class="font-semibold text-neutral-400">Outcome:</span> {{ dec.outcome.summary }}
                  </p>
                  <p
                    v-if="dec.outcome?.rationale"
                    class="mt-1 text-neutral-400 italic"
                  >
                    {{ dec.outcome.rationale }}
                  </p>
                  <p class="mt-2 font-mono text-[10px] text-neutral-500">
                    {{ dec.history.length }} history events · {{ dec.id }}
                  </p>
                </div>
              </div>
              <p
                v-else
                class="text-neutral-500"
              >
                No architectural decisions recorded for this View.
              </p>
            </div>

            <!-- Checks Tab Content -->
            <div
              v-else-if="activeBottomTab === 'checks' && selectedView"
              class="space-y-2"
            >
              <div
                v-if="selectedView.diagnostics.length"
                class="space-y-1.5"
              >
                <div
                  v-for="diag in selectedView.diagnostics"
                  :key="diag.code + diag.path"
                  class="rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-200"
                >
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-2">
                      <span class="font-mono font-medium text-amber-400">[{{ diag.code }}]</span>
                      <span class="font-mono text-neutral-400">{{ diag.path }}</span>
                    </div>
                    <div>
                      <button
                        v-if="resolveWidgetIdFromDiagnostic(diag)"
                        type="button"
                        class="rounded bg-primary/20 px-1.5 py-0.5 font-mono text-[10px] text-primary-300 hover:bg-primary/30"
                        title="Jump to widget in preview"
                        @click="handleCheckItemClick(diag)"
                      >
                        🎯 Jump #{{ resolveWidgetIdFromDiagnostic(diag) }}
                      </button>
                      <span
                        v-else
                        class="rounded bg-neutral-800/80 px-1 py-0.5 font-mono text-[9px] text-neutral-500"
                      >
                        [unresolved location]
                      </span>
                    </div>
                  </div>
                  <p class="mt-1 text-neutral-300">
                    {{ diag.message }}
                  </p>
                </div>
              </div>
              <div
                v-else
                class="text-emerald-400"
              >
                ✓ All checks passed. Zero diagnostic findings.
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Right Panel: Contextual Inspector -->
      <aside class="flex w-80 shrink-0 flex-col border-l border-neutral-800 bg-neutral-950 p-4">
        <div class="flex items-center justify-between border-b border-neutral-800 pb-3">
          <span class="text-xs font-semibold uppercase tracking-wider text-neutral-400">Inspector</span>
          <span class="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300">
            {{ selectedWidgetNode ? selectedWidgetNode.type : 'View' }}
          </span>
        </div>

        <div class="flex-1 overflow-y-auto py-3 space-y-4 text-xs">
          <!-- Widget Selection Detail -->
          <div
            v-if="selectedWidgetNode"
            class="space-y-4"
          >
            <div>
              <p class="font-semibold text-neutral-400">
                Selected Widget
              </p>
              <div class="mt-2 rounded border border-neutral-800 bg-neutral-900 p-2.5 space-y-2">
                <div class="flex justify-between">
                  <span class="text-neutral-500">Identity:</span>
                  <span class="font-mono text-neutral-200">#{{ selectedWidgetNode.id }}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-neutral-500">Type:</span>
                  <span class="font-semibold text-neutral-200">{{ selectedWidgetNode.type }}</span>
                </div>
                <div
                  v-if="selectedWidgetNode.slotName"
                  class="flex justify-between"
                >
                  <span class="text-neutral-500">Slot:</span>
                  <span class="font-mono text-neutral-200">{{ selectedWidgetNode.slotName }}[{{ selectedWidgetNode.slotIndex }}]</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-neutral-500">Depth:</span>
                  <span class="font-mono text-neutral-200">{{ selectedWidgetNode.depth }}</span>
                </div>
              </div>
            </div>

            <!-- Widget State Overrides -->
            <div>
              <p class="font-semibold text-neutral-400">
                Variant State Overrides
              </p>
              <div
                v-if="widgetStateOverrides"
                class="mt-2 rounded border border-neutral-800 bg-neutral-900 p-2.5 font-mono text-[11px]"
              >
                <div
                  v-for="(val, key) in widgetStateOverrides"
                  :key="key"
                  class="flex justify-between py-0.5"
                >
                  <span class="text-neutral-400">{{ key }}:</span>
                  <span class="text-neutral-200">{{ JSON.stringify(val) }}</span>
                </div>
              </div>
              <p
                v-else
                class="mt-1 text-neutral-500"
              >
                No state overrides for this widget in active variant.
              </p>
            </div>

            <!-- Targeted Diagnostics -->
            <div>
              <p class="font-semibold text-neutral-400">
                Widget Findings
              </p>
              <div
                v-if="selectedWidgetDiagnostics.length"
                class="mt-2 space-y-1.5"
              >
                <div
                  v-for="diag in selectedWidgetDiagnostics"
                  :key="diag.code"
                  class="rounded bg-amber-500/10 p-2 text-amber-300"
                >
                  <p class="font-mono font-medium">
                    {{ diag.code }}
                  </p>
                  <p class="mt-0.5 text-neutral-400">
                    {{ diag.message }}
                  </p>
                </div>
              </div>
              <p
                v-else
                class="mt-1 text-emerald-400/80"
              >
                ✓ Clean widget state
              </p>
            </div>
          </div>

          <!-- View Summary Detail (when View is selected or Root) -->
          <div
            v-else-if="selectedView"
            class="space-y-4"
          >
            <div>
              <p class="font-semibold text-neutral-400">
                View Metadata
              </p>
              <div class="mt-2 rounded border border-neutral-800 bg-neutral-900 p-2.5 space-y-2">
                <div>
                  <span class="text-neutral-500">ID:</span>
                  <p class="font-mono text-[10px] text-neutral-300 break-all">
                    {{ selectedView.resource.id }}
                  </p>
                </div>
                <div class="flex justify-between">
                  <span class="text-neutral-500">Revision:</span>
                  <span class="font-mono text-neutral-300">{{ shortRevision(selectedView.revision) }}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-neutral-500">Variants:</span>
                  <span class="text-neutral-300">{{ Object.keys(selectedView.resource.variants).length }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </main>
</template>
