<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from '#imports'
import { useUiuxClient } from '../composables/useUiuxClient'
import { RuntimePreviewProtocolBridge } from '../../src/preview/protocol/bridge'
import {
	PREVIEW_WIRE_CHANNEL,
	PREVIEW_CONTEXT_CHANNEL,
	PREVIEW_HIGHLIGHT_CHANNEL,
	PREVIEW_TARGETING_CHANNEL,
	type PreviewContextPayload,
	type PreviewHighlightPayload,
	type PreviewTargetingPayload,
} from '../../src/preview/protocol/transport'
import type {
	PreviewMaterializationResult,
} from '../../src/preview/preview-runtime'
import type { PreviewRuntimeBridge } from '../../src/preview/browser-runtime'
import type { ViewResource } from '../../src/domain/views/schema'
import type { ResolvedRenderContext } from '../../src/domain/render-context/schema'
import type { I18nResource } from '../../src/domain/i18n/schema'

const route = useRoute()
const uiux = useUiuxClient()
const localesMap = new Map<string, I18nResource>()

type Diagnostic = Readonly<{ code: string; path: string; message: string }>
type ViewRead = Readonly<{
	kind: 'view'
	key: string
	revision: string
	diagnostics: readonly Diagnostic[]
	resource: ViewResource
}>

const previewSessionId = ref<string>((route.query.session as string) || 'default-session')
const runtimeGenerationId = ref<string>((route.query.generation as string) || 'default-generation')
const viewId = ref<string>((route.query.viewId as string) || '')
const locale = ref<string>((route.query.locale as string) || 'en-US')
const viewportId = ref<string>((route.query.viewportId as string) || 'default')
const viewportWidth = ref<number>(Number(route.query.viewportWidth) || 1280)
const viewportHeight = ref<number>(Number(route.query.viewportHeight) || 800)
const themeId = ref<string>((route.query.themeId as string) || 'light')
const variantName = ref<string | undefined>((route.query.variant as string) || undefined)
const harnessMode = computed(() => route.query.harness === 'formal')

const highlightedWidgetId = ref<string>()
const isCommentMode = ref(false)
const activeTargetingInteractionId = ref<string>()
const viewData = ref<ViewRead>()
const loading = ref(true)
const error = ref<string>()
const handshakeStatus = ref<'initiating' | 'open' | 'failed'>('initiating')

const previewHostElement = ref<HTMLElement>()
let activeBridge: PreviewRuntimeBridge | undefined
let runtimeBridge: RuntimePreviewProtocolBridge | undefined
const materializationResult = ref<PreviewMaterializationResult>()

const activeContext = computed<ResolvedRenderContext>(() => ({
	viewId: viewId.value,
	...(variantName.value ? { variantName: variantName.value } : {}),
	locale: locale.value,
	viewportId: viewportId.value,
	viewport: { width: viewportWidth.value, height: viewportHeight.value },
	themeId: themeId.value,
}))

const isRootContentEmpty = computed(() => {
	const ir = viewData.value?.resource.ir as Record<string, unknown> | undefined
	if (!ir || ir.type !== 'RootShell') return false
	const slots = ir.slots as Record<string, unknown> | undefined
	const content = slots?.content
	return Array.isArray(content) && content.length === 0
})

function findTargetWidgetId(target: EventTarget | null): string {
	if (!target || !(target instanceof Element)) return 'root'
	const widgetEl = target.closest<HTMLElement>('[data-widget-id]')
	return widgetEl?.dataset.widgetId || 'root'
}

function handlePreviewPointerMove(event: PointerEvent) {
	if (!isCommentMode.value) return
	const targetId = findTargetWidgetId(event.target)
	highlightedWidgetId.value = targetId
	if (window.parent && window.parent !== window) {
		window.parent.postMessage({
			channel: PREVIEW_TARGETING_CHANNEL,
			payload: {
				type: 'hover',
				widgetId: targetId,
				viewId: viewId.value,
				targetingInteractionId: activeTargetingInteractionId.value,
			},
		}, window.location.origin)
	}
}

function handlePreviewPointerClick(event: MouseEvent) {
	if (!isCommentMode.value) return
	event.preventDefault()
	event.stopPropagation()
	const targetId = findTargetWidgetId(event.target)
	highlightedWidgetId.value = targetId
	if (window.parent && window.parent !== window) {
		window.parent.postMessage({
			channel: PREVIEW_TARGETING_CHANNEL,
			payload: {
				type: 'select',
				widgetId: targetId,
				viewId: viewId.value,
				targetingInteractionId: activeTargetingInteractionId.value,
			},
		}, window.location.origin)
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape' && isCommentMode.value) {
		isCommentMode.value = false
		if (window.parent && window.parent !== window) {
			window.parent.postMessage({
				channel: PREVIEW_TARGETING_CHANNEL,
				payload: {
					type: 'escape',
					targetingInteractionId: activeTargetingInteractionId.value,
				},
			}, window.location.origin)
		}
	}
}

function initBridge() {
	if (typeof window === 'undefined') return
	try {
		runtimeBridge = new RuntimePreviewProtocolBridge(
			previewSessionId.value,
			runtimeGenerationId.value,
			{ protocolVersion: 1, features: ['geometry'] },
			{
				send(message) {
					if (window.parent && window.parent !== window) {
						window.parent.postMessage({ channel: PREVIEW_WIRE_CHANNEL, message }, window.location.origin)
					}
				},
			},
		)
		runtimeBridge.declareCapabilities()
	}
	catch (cause) {
		handshakeStatus.value = 'failed'
		error.value = cause instanceof Error ? cause.message : 'Bridge init failed'
	}
}

async function loadView() {
	if (!viewId.value) {
		loading.value = false
		return
	}
	loading.value = true
	error.value = undefined
	try {
		const result = await uiux.readResource<ViewRead>('view', viewId.value)
		if (!result) throw new Error('Preview View is unavailable.')
		viewData.value = result
		await evaluateRuntime()
	}
	catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'Failed to load View'
		disposeCurrentRuntime()
		materializationResult.value = undefined
	}
	finally {
		loading.value = false
	}
}

function disposeCurrentRuntime() {
	if (activeBridge) {
		activeBridge.dispose()
		activeBridge = undefined
	}
}

async function evaluateRuntime() {
	if (!viewData.value?.resource || !viewId.value) return
	disposeCurrentRuntime()

	type PreviewAdaptersResponse =
		| { state: 'valid'; diagnostics: []; summaries: unknown[]; bundleUrl: string }
		| { state: 'invalid'; diagnostics: readonly Diagnostic[]; summaries: unknown[] }

	try {
		const adapterStatus = await uiux.previewAdapters() as PreviewAdaptersResponse
		if (adapterStatus.state === 'invalid') {
			materializationResult.value = {
				status: 'invalid',
				diagnostics: adapterStatus.diagnostics,
			}
			return
		}

		if (!adapterStatus.bundleUrl) return

		const bundleModule = await import(/* @vite-ignore */ adapterStatus.bundleUrl) as {
			mountPreviewRuntime?: (container: HTMLElement, opts: unknown) => PreviewRuntimeBridge
		}

		const mount = bundleModule.mountPreviewRuntime
			|| (window as unknown as { __UIUX_PREVIEW_RUNTIME__?: { mountPreviewRuntime: typeof bundleModule.mountPreviewRuntime } }).__UIUX_PREVIEW_RUNTIME__?.mountPreviewRuntime

		if (!mount) {
			materializationResult.value = {
				status: 'invalid',
				diagnostics: [{
					code: 'adapter.bundle_invalid',
					path: '/adapters',
					message: 'Preview runtime bundle did not expose mountPreviewRuntime.',
				}],
			}
			return
		}

		try {
			const locRes = await uiux.readResource<{ resource?: I18nResource }>('locale', locale.value)
			if (locRes?.resource) {
				localesMap.set(locale.value, locRes.resource)
			}
		}
		catch {
			// preserve accepted missing-key behavior
		}
		if (locale.value !== 'en-US') {
			try {
				const defRes = await uiux.readResource<{ resource?: I18nResource }>('locale', 'en-US')
				if (defRes?.resource) {
					localesMap.set('en-US', defRes.resource)
				}
			}
			catch {
				// optional fallback missing
			}
		}

		await nextTick()
		if (!previewHostElement.value) return

		activeBridge = mount(previewHostElement.value, {
			view: viewData.value.resource,
			context: activeContext.value,
			locales: localesMap,
			onStatusChange(status: PreviewMaterializationResult) {
				materializationResult.value = status
			},
		})
	}
	catch (cause) {
		materializationResult.value = {
			status: 'invalid',
			diagnostics: [{
				code: 'adapter.bundle_load_failed',
				path: '/adapters',
				message: cause instanceof Error ? cause.message : 'Failed to load preview runtime bundle',
			}],
		}
	}
}

function onWindowMessage(event: MessageEvent) {
	const data = event.data
	if (!data || typeof data !== 'object') return

	if (data.channel === PREVIEW_WIRE_CHANNEL && data.message && runtimeBridge) {
		const bridgeResult = runtimeBridge.receive(data.message)
		if (bridgeResult.status === 'accepted') {
			handshakeStatus.value = 'open'
		}
	}
	else if (data.channel === PREVIEW_CONTEXT_CHANNEL && data.payload) {
		const payload = data.payload as PreviewContextPayload
		const viewChanged = Boolean(payload.viewId && payload.viewId !== viewId.value)
		const localeChanged = Boolean(payload.locale && payload.locale !== locale.value)
		if (payload.viewId) viewId.value = payload.viewId
		if (payload.locale) locale.value = payload.locale
		if (payload.viewportId) viewportId.value = payload.viewportId
		if (payload.viewport?.width) viewportWidth.value = payload.viewport.width
		if (payload.viewport?.height) viewportHeight.value = payload.viewport.height
		if (payload.themeId) themeId.value = payload.themeId
		variantName.value = payload.variantName
		if (viewChanged) void loadView()
		else if (activeBridge) {
			if (localeChanged && payload.locale) {
				void uiux.readResource<{ resource?: I18nResource }>('locale', payload.locale)
					.then(res => {
						if (res?.resource) {
							localesMap.set(payload.locale!, res.resource)
							activeBridge?.updateLocales?.(localesMap)
						}
					})
					.catch(() => undefined)
			}
			activeBridge.updateContext(activeContext.value)
		}
		else evaluateRuntime()
	}
	else if (data.channel === PREVIEW_TARGETING_CHANNEL && data.payload) {
		const payload = data.payload as PreviewTargetingPayload
		if (payload.type === 'enter') {
			isCommentMode.value = true
			activeTargetingInteractionId.value = payload.targetingInteractionId
		}
		else if (payload.type === 'exit') {
			isCommentMode.value = false
			activeTargetingInteractionId.value = undefined
		}
	}
	else if (data.channel === PREVIEW_HIGHLIGHT_CHANNEL && data.payload) {
		const payload = data.payload as PreviewHighlightPayload
		highlightedWidgetId.value = payload.widgetId
		if (typeof payload.commentMode === 'boolean') {
			isCommentMode.value = payload.commentMode
			activeTargetingInteractionId.value = payload.targetingInteractionId
		}
	}
}

watch(highlightedWidgetId, (newId, oldId) => {
	if (typeof document === 'undefined') return
	if (oldId && previewHostElement.value) {
		try {
			const prev = previewHostElement.value.querySelector(`[data-widget-id="${CSS.escape(oldId)}"]`)
			if (prev) prev.removeAttribute('data-preview-highlighted')
		}
		catch {
			// ignore selector escape errors
		}
	}
	if (newId && newId !== 'root' && previewHostElement.value && !harnessMode.value) {
		try {
			const next = previewHostElement.value.querySelector(`[data-widget-id="${CSS.escape(newId)}"]`)
			if (next) next.setAttribute('data-preview-highlighted', 'true')
		}
		catch {
			// ignore selector escape errors
		}
	}
})

watch(() => route.query, (nextQuery) => {
	if (nextQuery.viewId && nextQuery.viewId !== viewId.value) {
		viewId.value = nextQuery.viewId as string
		loadView()
	}
	if (nextQuery.locale && nextQuery.locale !== locale.value) locale.value = nextQuery.locale as string
	if (nextQuery.themeId && nextQuery.themeId !== themeId.value) themeId.value = nextQuery.themeId as string
	if (nextQuery.variant !== undefined) variantName.value = (nextQuery.variant as string) || undefined
	if (activeBridge) activeBridge.updateContext(activeContext.value)
	else evaluateRuntime()
})

onMounted(() => {
	window.addEventListener('message', onWindowMessage)
	window.addEventListener('keydown', handleKeydown)
	initBridge()
	loadView()
})

onUnmounted(() => {
	window.removeEventListener('message', onWindowMessage)
	window.removeEventListener('keydown', handleKeydown)
	disposeCurrentRuntime()
})
</script>

<template>
  <div
    class="min-h-screen transition-colors"
    :class="[
      themeId === 'dark' ? 'bg-neutral-900 text-neutral-100' : 'bg-neutral-50 text-neutral-900',
      harnessMode ? '' : 'p-4',
    ]"
  >
    <!-- Loading state -->
    <div
      v-if="loading"
      data-preview-status="loading"
      class="flex h-64 items-center justify-center"
    >
      <div class="space-y-3 text-center">
        <div class="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p class="text-xs text-neutral-500">
          Materializing View Runtime…
        </p>
      </div>
    </div>

    <!-- Error state -->
    <div
      v-else-if="error"
      data-preview-status="error"
      class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600"
    >
      <p class="font-medium">
        Preview Load Error
      </p>
      <p class="mt-1 text-xs">
        {{ error }}
      </p>
    </div>

    <!-- No View Selected -->
    <div
      v-else-if="!viewId"
      data-preview-status="no_view"
      class="flex h-64 items-center justify-center text-center text-neutral-400"
    >
      <div>
        <p class="text-sm font-medium">
          No View Selected
        </p>
        <p class="mt-1 text-xs">
          Select a View from the left navigation tree to mount in preview.
        </p>
      </div>
    </div>

    <!-- Adapter Browser Materialization Unavailable State -->
    <div
      v-else-if="materializationResult?.status === 'adapter_unavailable'"
      data-preview-status="adapter_unavailable"
      class="rounded-xl border border-amber-500/40 bg-amber-500/10 p-5 text-amber-900 dark:text-amber-200"
    >
      <div class="flex items-center gap-2">
        <span class="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-xs font-semibold">adapter.materialization_unavailable</span>
        <span class="text-xs font-semibold uppercase tracking-wider">Accepted Architecture Seam</span>
      </div>
      <h3 class="mt-3 text-base font-semibold">
        Adapter Browser Materialization Unavailable
      </h3>
      <p class="mt-2 text-sm leading-relaxed">
        This View uses widget types (<code class="font-mono font-medium">{{ materializationResult.unsupportedTypes.join(', ') }}</code>) requiring external adapters.
        Loading arbitrary external adapter code in the browser preview iframe is blocked by the absence of an accepted server-to-browser module transport/bundler contract.
      </p>
      <div class="mt-4 rounded-lg bg-black/5 p-3 dark:bg-white/5">
        <p class="font-mono text-xs">
          Only the UIUX-managed <code>RootShell</code> plugin and renderer are currently materialized in this browser environment.
        </p>
      </div>
    </div>

    <!-- Runtime Invalid State -->
    <div
      v-else-if="materializationResult?.status === 'invalid'"
      data-preview-status="invalid"
      class="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-red-900 dark:text-red-200"
    >
      <p class="font-semibold">
        Runtime Execution Invalid
      </p>
      <ul class="mt-2 space-y-1 text-xs">
        <li
          v-for="diag in materializationResult.diagnostics"
          :key="diag.code + diag.path"
        >
          <span class="font-mono font-medium">[{{ diag.code }}]</span> {{ diag.path }}: {{ diag.message }}
        </li>
      </ul>
    </div>

    <!-- Ready / Materialized View IR State -->
    <div
      v-show="materializationResult?.status === 'ready' && !loading && !error && viewId"
      data-preview-status="ready"
      data-preview-ready="true"
      class="relative"
    >
      <!-- RootShell boundary container -->
      <div
        class="relative transition-all duration-150"
        :class="[
          harnessMode ? '' : ['min-h-[300px] rounded-lg', highlightedWidgetId === 'root'
            ? 'border border-primary ring-2 ring-primary/40'
            : 'border border-dashed border-neutral-300 dark:border-neutral-700'],
          isCommentMode ? 'cursor-crosshair ring-2 ring-amber-400/60' : '',
        ]"
        data-widget-id="root"
        @pointermove="handlePreviewPointerMove"
        @click.capture="handlePreviewPointerClick"
      >
        <!-- RootShell indicator tag (hidden in formal capture harness) -->
        <div
          v-if="!harnessMode"
          class="flex items-center justify-between border-b border-neutral-200/60 px-3 py-1.5 text-[11px] text-neutral-400 dark:border-neutral-800"
        >
          <div class="flex items-center gap-1.5">
            <span class="font-mono font-medium text-neutral-600 dark:text-neutral-300">RootShell</span>
            <span class="text-[10px]">#root</span>
          </div>
          <div class="flex items-center gap-2">
            <span
              v-if="isCommentMode"
              class="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-500 animate-pulse"
            >
              💬 Click to comment (Esc cancels)
            </span>
            <span class="font-mono text-[10px]">{{ locale }} · {{ themeId }}</span>
          </div>
        </div>

        <!-- Rendered component tree through standalone preview bundle -->
        <div :class="harnessMode ? '' : 'p-4'">
          <div
            ref="previewHostElement"
            class="preview-runtime-host"
          />

          <!-- Empty content slot visual indication -->
          <div
            v-if="isRootContentEmpty"
            class="flex min-h-[200px] flex-col items-center justify-center rounded-lg border border-dashed border-neutral-200 p-6 text-center text-neutral-400 dark:border-neutral-800"
          >
            <p class="text-sm font-medium text-neutral-500 dark:text-neutral-400">
              Empty content slot
            </p>
            <p class="mt-1 max-w-sm text-xs text-neutral-400 dark:text-neutral-500">
              RootShell is active and running under <code>@deviltea/widget-core</code>. No child widgets are currently authored in the <code>content</code> slot.
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep([data-widget-id][data-preview-highlighted='true']) {
  outline: 2px solid var(--color-primary-500, #3b82f6) !important;
  outline-offset: 2px !important;
  border-radius: 4px;
}
</style>
