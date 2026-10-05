<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { definePageMeta, useI18n, useRoute } from '#imports'
import { useUiuxClient } from '../composables/useUiuxClient'
import { describeFetchError } from '../utils/fetch-error'
import { resolveDefaultLocale, resolveDefaultThemeId } from '../../src/preview/render-context-options'
import type { WorkspaceManifest } from '../../src/domain/workspace/schema'
import { RuntimePreviewProtocolBridge } from '../../src/preview/protocol/bridge'
import { MULTI_TARGET_GEOMETRY_FEATURE } from '../../src/preview/protocol/schema'
import { RuntimeGeometryProducer } from '../../src/preview/geometry-producer'
import { createDomGeometryMeasurer } from '../../src/preview/dom-geometry'
import { attachGeometrySignals, type GeometrySignalSubscription } from '../../src/preview/geometry-signals'
import {
	PREVIEW_WIRE_CHANNEL,
	PREVIEW_CONTEXT_CHANNEL,
	type PreviewContextPayload,
	type PreviewTargetingPurpose,
} from '../../src/preview/protocol/transport'
import type { TargetingContext, TargetingRuntimeMessage } from '../../src/preview/protocol/targeting'
import type {
	PreviewMaterializationResult,
} from '../../src/preview/preview-runtime'
import type { PreviewRuntimeBridge } from '../../src/preview/browser-runtime'
import type { ViewResource } from '../../src/domain/views/schema'
import type { ResolvedRenderContext } from '../../src/domain/render-context/schema'
import type { I18nResource } from '../../src/domain/i18n/schema'

// The Preview document has no Workbench shell and never follows the Workbench color mode: pin
// the document to light and scope the host's own status chrome to the Workspace theme rendered.
definePageMeta({ layout: false, colorMode: 'light' })

const route = useRoute()
const uiux = useUiuxClient()
const { t } = useI18n()
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
// Locale and theme are resolved from the Workspace (same rules as the Workbench header) when not supplied.
const locale = ref<string>((route.query.locale as string) || '')
const viewportId = ref<string>((route.query.viewportId as string) || 'default')
const viewportWidth = ref<number>(Number(route.query.viewportWidth) || 1280)
const viewportHeight = ref<number>(Number(route.query.viewportHeight) || 800)
const themeId = ref<string>((route.query.themeId as string) || '')
const workspaceDefaultLocale = ref<string>()
/** The preview host follows the brightness of the Workspace theme it renders, not the Workbench appearance. */
const hostColorScope = computed(() => themeId.value === 'dark' ? 'dark' : 'light')
const variantName = ref<string | undefined>((route.query.variant as string) || undefined)
const harnessMode = computed(() => route.query.harness === 'formal')

/**
 * The targeting interaction Workbench entered (Part 3): `inspection` for the Select tool,
 * `comment-range` for Comment mode, none for Interact. The runtime hit-tests and reports the
 * hover candidate; Workbench draws every outline. Nothing in this document is restyled for it.
 */
const targetingPurpose = ref<PreviewTargetingPurpose>()
const isCommentMode = computed(() => targetingPurpose.value === 'comment-range')
const activeTargetingInteractionId = ref<string>()
let hoverCandidateWidgetId: string | undefined
const viewData = ref<ViewRead>()
const loading = ref(true)
const error = ref<string>()
const handshakeStatus = ref<'initiating' | 'open' | 'failed'>('initiating')

const previewHostElement = ref<HTMLElement>()
let activeBridge: PreviewRuntimeBridge | undefined
let runtimeBridge: RuntimePreviewProtocolBridge | undefined
let geometryProducer: RuntimeGeometryProducer | undefined
let geometrySignals: GeometrySignalSubscription | undefined
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

function targetingContext(): TargetingContext {
	return {
		previewSessionId: previewSessionId.value,
		runtimeGenerationId: runtimeGenerationId.value,
		viewId: viewId.value,
		...(variantName.value ? { variantId: variantName.value } : {}),
	}
}

/**
 * Targeting goes out in the protocol envelope through the bridge, so nothing crosses before the
 * capability ACK and every message carries session, generation and interaction identity.
 */
function sendTargeting(message: TargetingRuntimeMessage) {
	runtimeBridge?.sendTargeting(message)
}

/** Reports a changed hover candidate for the active interaction; touch has no hover (Part 3). */
function reportHoverCandidate(widgetId: string | undefined, pointerType: string) {
	const targetingInteractionId = activeTargetingInteractionId.value
	if (!targetingPurpose.value || !targetingInteractionId) return
	if (widgetId === hoverCandidateWidgetId) return
	hoverCandidateWidgetId = widgetId
	sendTargeting({
		type: 'targeting.hover',
		context: { ...targetingContext(), ...(widgetId ? { widgetId } : {}) },
		payload: {
			targetingInteractionId,
			...(pointerType === 'mouse' || pointerType === 'pen' ? { pointerType } : {}),
		},
	})
}

function handlePreviewPointerMove(event: PointerEvent) {
	if (!targetingPurpose.value || event.pointerType === 'touch') return
	reportHoverCandidate(findTargetWidgetId(event.target), event.pointerType)
}

function handlePreviewPointerLeave(event: PointerEvent) {
	if (event.pointerType === 'touch') return
	reportHoverCandidate(undefined, event.pointerType)
}

/**
 * A click commits the hit-tested Widget for the active interaction only. The Interact tool holds
 * no interaction, so its clicks belong to the View and never cross the boundary (item 2.3).
 */
function handlePreviewPointerClick(event: MouseEvent) {
	const targetingInteractionId = activeTargetingInteractionId.value
	const purpose = targetingPurpose.value
	if (!purpose || !targetingInteractionId || harnessMode.value) return
	const widgetId = findTargetWidgetId(event.target)
	if (purpose === 'inspection') {
		// Select: the click also selects the Widget in the Workbench; the Widget's own interaction still runs.
		sendTargeting({ type: 'targeting.select', context: { ...targetingContext(), widgetId }, payload: { targetingInteractionId } })
		return
	}
	event.preventDefault()
	event.stopPropagation()
	// The transient click point of the final target, in inner content-viewport CSS px.
	sendTargeting({
		type: 'targeting.select',
		context: { ...targetingContext(), widgetId },
		payload: { targetingInteractionId, point: { x: event.clientX, y: event.clientY } },
	})
}

function handleKeydown(event: KeyboardEvent) {
	const targetingInteractionId = activeTargetingInteractionId.value
	if (event.key === 'Escape' && isCommentMode.value && targetingInteractionId) {
		// Workbench owns the mode exit (Part 3); the runtime only reports the intent.
		sendTargeting({ type: 'targeting.escape', context: targetingContext(), payload: { targetingInteractionId } })
	}
}

/** Focus moving to the Workbench cancels the transient hover candidate (Part 3); the mode stays. */
function handleWindowBlur() {
	reportHoverCandidate(undefined, 'mouse')
}

function widgetElement(widgetId: string): Element | null {
	try {
		return document.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"]`)
	}
	catch {
		return null
	}
}

function currentGeometryContext() {
	return { viewId: viewId.value, ...(variantName.value ? { variantId: variantName.value } : {}) }
}

function initBridge() {
	if (typeof window === 'undefined') return
	try {
		runtimeBridge = new RuntimePreviewProtocolBridge(
			previewSessionId.value,
			runtimeGenerationId.value,
			{ protocolVersion: 1, features: ['geometry', MULTI_TARGET_GEOMETRY_FEATURE] },
			{
				send(message) {
					if (window.parent && window.parent !== window) {
						window.parent.postMessage({ channel: PREVIEW_WIRE_CHANNEL, message }, window.location.origin)
					}
				},
			},
		)
		const bridge = runtimeBridge
		// The geometry producer of this runtime generation (Part 2, multi-target geometry streams).
		geometryProducer = new RuntimeGeometryProducer({
			send: (response) => { bridge.sendGeometry(response) },
			measurer: createDomGeometryMeasurer({ document }),
			requestFrame: callback => window.requestAnimationFrame(callback),
			cancelFrame: handle => window.cancelAnimationFrame(handle),
			now: () => performance.now(),
		})
		geometryProducer.setContext(currentGeometryContext())
		geometrySignals = attachGeometrySignals(window, geometryProducer, widgetElement)
		runtimeBridge.declareCapabilities()
	}
	catch (cause) {
		handshakeStatus.value = 'failed'
		error.value = cause instanceof Error ? cause.message : t('preview.errors.bridgeInitFailed')
	}
}

/** Resolves the Workspace default locale and, when not supplied, the effective locale and theme. */
async function resolveWorkspaceDefaults() {
	if (workspaceDefaultLocale.value && locale.value && themeId.value) return
	let manifest: WorkspaceManifest | undefined
	try {
		manifest = (await uiux.readResource<{ resource?: WorkspaceManifest }>('workspace', 'workspace'))?.resource
	}
	catch {
		manifest = undefined
	}
	workspaceDefaultLocale.value = resolveDefaultLocale(manifest)
	if (!locale.value) locale.value = workspaceDefaultLocale.value
	if (!themeId.value) themeId.value = resolveDefaultThemeId(manifest)
}

async function loadView() {
	if (!viewId.value) {
		loading.value = false
		return
	}
	loading.value = true
	error.value = undefined
	try {
		await resolveWorkspaceDefaults()
		const result = await uiux.readResource<ViewRead>('view', viewId.value)
		if (!result) throw new Error(t('preview.errors.viewUnavailable'))
		viewData.value = result
		await evaluateRuntime()
	}
	catch (cause) {
		error.value = describeFetchError(cause, t('preview.errors.viewLoadFailed')).message
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
					message: t('preview.errors.bundleInvalid'),
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
		const fallbackLocale = workspaceDefaultLocale.value
		if (fallbackLocale && locale.value !== fallbackLocale) {
			try {
				const defRes = await uiux.readResource<{ resource?: I18nResource }>('locale', fallbackLocale)
				if (defRes?.resource) {
					localesMap.set(fallbackLocale, defRes.resource)
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
			...(workspaceDefaultLocale.value ? { defaultLocale: workspaceDefaultLocale.value } : {}),
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
				message: cause instanceof Error ? cause.message : t('preview.errors.bundleLoadFailed'),
			}],
		}
	}
}

function onWindowMessage(event: MessageEvent) {
	// Only the embedding Workbench document of this origin talks to the runtime (item 2.3).
	if (event.origin !== window.location.origin || event.source !== window.parent || window.parent === window) return
	const data = event.data
	if (!data || typeof data !== 'object') return

	if (data.channel === PREVIEW_WIRE_CHANNEL && data.message && runtimeBridge) {
		const bridgeResult = runtimeBridge.receive(data.message)
		if (bridgeResult.status !== 'accepted') return
		const message = bridgeResult.message
		if (message.type === 'capability.ack') handshakeStatus.value = 'open'
		else if ((message.type === 'geometry.acquire.request' || message.type === 'geometry.release') && geometryProducer) {
			geometryProducer.receive(message)
			geometrySignals?.refreshObservedWidgets()
		}
		else if (message.type === 'targeting.enter') {
			// A new interaction supersedes the previous one at once; its hover candidate starts empty.
			targetingPurpose.value = message.payload.purpose
			activeTargetingInteractionId.value = message.payload.targetingInteractionId
			hoverCandidateWidgetId = undefined
		}
		else if (message.type === 'targeting.exit') {
			targetingPurpose.value = undefined
			activeTargetingInteractionId.value = undefined
			hoverCandidateWidgetId = undefined
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
}

// The runtime context the producer reports for: streams of another View or Variant stay silent,
// and streams of the previous context end without a release when it changes.
watch([viewId, variantName], () => {
	geometryProducer?.setContext(currentGeometryContext())
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

// Canvas zoom (R4). Ctrl/⌘ + wheel and trackpad pinch over the View would zoom the whole
// Workbench page; the canvas zooms only from its gutter (brief b), so the gesture is absorbed here.
function absorbCanvasZoomWheel(event: WheelEvent) {
	if (event.ctrlKey || event.metaKey) event.preventDefault()
}

onMounted(() => {
	window.addEventListener('message', onWindowMessage)
	window.addEventListener('keydown', handleKeydown)
	window.addEventListener('blur', handleWindowBlur)
	if (window.parent !== window) window.addEventListener('wheel', absorbCanvasZoomWheel, { passive: false })
	initBridge()
	loadView()
})

onUnmounted(() => {
	window.removeEventListener('message', onWindowMessage)
	window.removeEventListener('keydown', handleKeydown)
	window.removeEventListener('blur', handleWindowBlur)
	window.removeEventListener('wheel', absorbCanvasZoomWheel)
	geometrySignals?.dispose()
	geometryProducer?.dispose()
	disposeCurrentRuntime()
})
</script>


<template>
  <!--
    The preview host renders inside the Workspace theme being previewed, so its own
    status chrome is scoped to that theme's brightness (.light / .dark token scope)
    instead of the Workbench appearance setting.
  -->
  <div
    class="min-h-screen text-default transition-colors"
    :class="[
      hostColorScope,
      hostColorScope === 'dark' ? 'bg-default' : 'bg-muted',
    ]"
  >
    <!-- Loading state -->
    <div
      v-if="loading"
      data-preview-status="loading"
      class="flex h-64 items-center justify-center p-4"
    >
      <div
        class="space-y-3 text-center"
        role="status"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="mx-auto size-8 animate-spin text-primary motion-reduce:animate-none"
        />
        <p class="text-xs text-muted">
          {{ t('preview.loading') }}
        </p>
      </div>
    </div>

    <!-- Error state -->
    <div
      v-else-if="error"
      data-preview-status="error"
      class="p-4"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('preview.errorTitle')"
        :description="error"
      />
    </div>

    <!-- No View Selected -->
    <div
      v-else-if="!viewId"
      data-preview-status="no_view"
      class="flex h-64 items-center justify-center p-4"
    >
      <UEmpty
        icon="i-lucide-monitor-dot"
        :title="t('preview.noViewTitle')"
        :description="t('preview.noViewDescription')"
        variant="naked"
      />
    </div>

    <!-- Adapter Browser Materialization Unavailable State -->
    <div
      v-else-if="materializationResult?.status === 'adapter_unavailable'"
      data-preview-status="adapter_unavailable"
      class="p-4"
    >
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-puzzle"
        :title="t('preview.adapterUnavailable.title')"
      >
        <template #description>
          <div class="space-y-2">
            <p class="flex flex-wrap items-center gap-2">
              <UBadge
                color="warning"
                variant="soft"
                size="sm"
                class="font-mono"
              >
                adapter.materialization_unavailable
              </UBadge>
              <span class="text-xs font-medium">{{ t('preview.adapterUnavailable.seam') }}</span>
            </p>
            <i18n-t
              keypath="preview.adapterUnavailable.description"
              tag="p"
              class="text-sm leading-relaxed"
              scope="global"
            >
              <template #types>
                <code class="font-mono font-medium">{{ materializationResult.unsupportedTypes.join(', ') }}</code>
              </template>
            </i18n-t>
            <i18n-t
              keypath="preview.adapterUnavailable.note"
              tag="p"
              class="rounded-md bg-elevated p-3 font-mono text-xs"
              scope="global"
            >
              <template #rootShell>
                <code>RootShell</code>
              </template>
            </i18n-t>
          </div>
        </template>
      </UAlert>
    </div>

    <!-- Runtime Invalid State -->
    <div
      v-else-if="materializationResult?.status === 'invalid'"
      data-preview-status="invalid"
      class="p-4"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-octagon-alert"
        :title="t('preview.invalidTitle')"
      >
        <template #description>
          <ul class="mt-1 space-y-1 text-xs">
            <li
              v-for="diag in materializationResult.diagnostics"
              :key="diag.code + diag.path"
            >
              <span class="font-mono font-medium">[{{ diag.code }}]</span> {{ diag.path }}: {{ diag.message }}
            </li>
          </ul>
        </template>
      </UAlert>
    </div>

    <!-- Ready / Materialized View IR State -->
    <div
      v-show="materializationResult?.status === 'ready' && !loading && !error && viewId"
      data-preview-status="ready"
      data-preview-ready="true"
      class="relative"
    >
      <!--
        RootShell boundary container. Its content box must equal the selected viewport exactly,
        so no padding, borders or in-flow chrome here. Selection, hover and comment outlines are all
        drawn by the Workbench overlay from runtime-reported geometry; this document is never
        restyled to show them. Only the cursor carries Comment mode inside the View.
        The Workbench canvas owns the visual gutter and shows the View, locale and theme outside the iframe.
      -->
      <div
        class="relative"
        :class="[
          harnessMode ? '' : 'min-h-screen',
          isCommentMode ? 'cursor-crosshair' : '',
        ]"
        data-widget-id="root"
        @pointermove="handlePreviewPointerMove"
        @pointerleave="handlePreviewPointerLeave"
        @click.capture="handlePreviewPointerClick"
      >
        <!-- Rendered component tree through standalone preview bundle -->
        <div>
          <div
            ref="previewHostElement"
            class="preview-runtime-host"
          />

          <!-- Empty content slot visual indication -->
          <UEmpty
            v-if="isRootContentEmpty"
            icon="i-lucide-square-dashed"
            :title="t('preview.emptySlotTitle')"
            variant="outline"
            :ui="{ root: 'min-h-[200px] border-dashed' }"
          >
            <template #description>
              <i18n-t
                keypath="preview.emptySlotDescription"
                tag="span"
                scope="global"
              >
                <template #core>
                  <code>{{ '@deviltea/widget-core' }}</code>
                </template>
                <template #slot>
                  <code>content</code>
                </template>
              </i18n-t>
            </template>
          </UEmpty>
        </div>
      </div>
    </div>
  </div>
</template>
