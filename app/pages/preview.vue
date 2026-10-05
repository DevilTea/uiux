<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { definePageMeta, useI18n, useRoute } from '#imports'
import { useUiuxClient } from '../composables/useUiuxClient'
import { describeFetchError } from '../utils/fetch-error'
import { resolveDefaultLocale, resolveDefaultThemeId } from '../../src/preview/render-context-options'
import type { WorkspaceManifest } from '../../src/domain/workspace/schema'
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
	if (!isCommentMode.value) {
		// Outside comment mode a click selects the hit-tested widget in the Workbench tree and Inspector.
		// The widget's own interaction still runs; nothing is prevented.
		if (harnessMode.value || !window.parent || window.parent === window) return
		const targetId = findTargetWidgetId(event.target)
		highlightedWidgetId.value = targetId
		window.parent.postMessage({
			channel: PREVIEW_TARGETING_CHANNEL,
			payload: {
				type: 'select',
				purpose: 'inspection',
				widgetId: targetId,
				viewId: viewId.value,
			},
		}, window.location.origin)
		return
	}
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
        so no padding, borders or in-flow chrome here: highlights are inset rings (box-shadow).
        The Workbench canvas owns the visual gutter and shows the View, locale and theme outside the iframe.
      -->
      <div
        class="relative transition-shadow duration-150"
        :class="[
          harnessMode ? '' : ['min-h-screen', highlightedWidgetId === 'root' ? 'ring-2 ring-inset ring-highlight' : ''],
          isCommentMode ? 'cursor-crosshair ring-2 ring-inset ring-comment/60' : '',
        ]"
        data-widget-id="root"
        @pointermove="handlePreviewPointerMove"
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

<style scoped>
:deep([data-widget-id][data-preview-highlighted='true']) {
  outline: 2px solid var(--wb-highlight, var(--ui-primary)) !important;
  outline-offset: 2px !important;
  border-radius: 4px;
}
</style>
