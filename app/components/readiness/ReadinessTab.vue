<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { defineShortcuts, navigateTo, useI18n } from '#imports'
import type { HandoffRoot } from '../../../src/domain/handoff/schema'
import { REVIEW_RESOLUTIONS } from '../../../src/domain/reviews/schema'
import { resolveDiagnosticWidgetTarget } from '../../../src/preview/checks-navigation'
import { flattenWidgetTree } from '../../../src/preview/widget-tree'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import { useReadiness } from '../../composables/useReadiness'
import { useWorkbench } from '../../composables/useWorkbench'
import { reviewCoverageSummary, splitReadinessDiagnostics, type CaptureContext } from '../../utils/readiness'
import { viewLocation } from '../../utils/workbench-routes'
import CaptureSlideover from './CaptureSlideover.vue'
import EvidenceSheet from './EvidenceSheet.vue'
import HandoffDiagnosticList from './HandoffDiagnosticList.vue'
import HandoffExportModal from './HandoffExportModal.vue'

/**
 * A View's Readiness tab (brief f): four facets, each a status icon, a plain sentence and one
 * action. Validation is the View's Checks findings; Evidence is freshness across the contexts
 * that were explicitly captured; Reviews are the threads anchored here with resolution counts;
 * Handoff is the readiness gate run with this View as the only root (Part 1).
 */
const emit = defineEmits<{
	(e: 'openComments'): void
	(e: 'openInspect'): void
}>()

const { t } = useI18n()
const workbench = useWorkbench()
const { selectedView, selectedViewId, reviews, widgetTreeResult, currentActiveContext, authorReadOnly, isReadOnly, preview } = workbench
const readiness = useReadiness()
const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const atLeastTablet = useMediaQuery('(min-width: 768px)')

const viewName = computed(() => selectedView.value?.resource.name || t('common.unnamed'))

// ----- Validation ------------------------------------------------------------------------------

const knownWidgets = computed(() => widgetTreeResult.value?.status === 'valid'
	? new Map(flattenWidgetTree(widgetTreeResult.value.root).map(widget => [widget.id, widget.type]))
	: new Map<string, string>())
const findings = computed(() => (selectedView.value?.diagnostics ?? []).map((diagnostic) => {
	const widgetId = resolveDiagnosticWidgetTarget(diagnostic, selectedView.value?.resource.ir, new Set(knownWidgets.value.keys()))
	return { ...diagnostic, ...(widgetId ? { widgetId, widgetType: knownWidgets.value.get(widgetId) } : {}) }
}))
const findingsOpen = ref(true)

/** Checks navigation defers while Comment mode is on; the latest request wins (Part 3). */
const deferredWidget = ref<string>()
function selectFinding(widgetId: string): void {
	if (preview.isCommentMode.value) {
		deferredWidget.value = widgetId
		return
	}
	workbench.selectWidget(widgetId)
	emit('openInspect')
}
watch(preview.isCommentMode, (on) => {
	if (on || !deferredWidget.value) return
	const widgetId = deferredWidget.value
	deferredWidget.value = undefined
	workbench.selectWidget(widgetId)
})

// ----- Evidence --------------------------------------------------------------------------------

const evidence = computed(() => readiness.evidenceForView(selectedViewId.value))
const evidenceCounts = computed(() => ({
	total: evidence.value.length,
	fresh: evidence.value.filter(entry => entry.freshness.state === 'fresh').length,
	stale: evidence.value.filter(entry => entry.freshness.state === 'stale').length,
	unknown: evidence.value.filter(entry => entry.freshness.state === 'unknown').length,
}))
const needsCapture = computed(() => evidence.value.filter(entry => entry.freshness.state !== 'fresh'))
const STALE_PREVIEW = 3
const staleExpanded = ref(false)
const staleShown = computed(() => staleExpanded.value ? needsCapture.value : needsCapture.value.slice(0, STALE_PREVIEW))
const canCapture = computed(() => !authorReadOnly.value && isDesktop.value)
const captureOpen = ref(false)
const captureContexts = ref<readonly CaptureContext[]>([])

function openCapture(contexts?: readonly CaptureContext[]): void {
	if (!canCapture.value) return
	const active = currentActiveContext.value
	captureContexts.value = contexts?.length
		? contexts
		: active
			? [{ viewId: active.viewId, ...(active.variantName ? { variantName: active.variantName } : {}), locale: active.locale, viewportId: active.viewportId, viewport: active.viewport, themeId: active.themeId }]
			: []
	captureOpen.value = true
}

function applyContext(context: CaptureContext): void {
	void navigateTo(viewLocation(context.viewId, {
		variant: context.variantName,
		locale: context.locale,
		viewport: context.viewportId,
		theme: context.themeId,
		panel: 'readiness',
	}))
}

function staleLabel(entry: (typeof needsCapture.value)[number]): string {
	const context = entry.context
	return context ? [context.variantName ?? t('ctx.base'), `${context.viewportId} ${context.viewport.width} × ${context.viewport.height}`, context.locale, context.themeId].join(' · ') : t('evidence.context.unknown')
}

// ----- Reviews ---------------------------------------------------------------------------------

const threadsHere = computed(() => reviews.value.filter(review => review.summary.anchor?.viewId === selectedViewId.value))
const readyHere = computed(() => threadsHere.value.filter(review => review.summary.status === 'ready-for-review').length)
const openHere = computed(() => threadsHere.value.filter(review => (review.summary.status ?? 'open') === 'open').length)

// ----- Handoff (this View as the only root) ---------------------------------------------------

const entry = computed(() => selectedViewId.value ? readiness.viewAssessment(selectedViewId.value) : undefined)
const split = computed(() => splitReadinessDiagnostics(entry.value?.readiness?.blockingDiagnostics))
const ready = computed(() => entry.value?.status === 'ok' && entry.value.readiness?.implementationReady === true)
const coverage = computed(() => reviewCoverageSummary(entry.value?.readiness))
const resolvedParts = computed(() => REVIEW_RESOLUTIONS
	.filter(kind => coverage.value.resolved[kind] > 0)
	.map(kind => ({ kind, count: coverage.value.resolved[kind] })))
const canExport = computed(() => !authorReadOnly.value && atLeastTablet.value)
const exportOpen = ref(false)
const exportRoots = computed<HandoffRoot[]>(() => selectedViewId.value ? [{ type: 'view', viewId: selectedViewId.value }] : [])

function refresh(force = false): void {
	const id = selectedViewId.value
	if (!id) return
	if (force || readiness.isOutdated(readiness.viewAssessment(id))) void readiness.assessView(id, { force })
}

onMounted(() => { void readiness.loadEvidence() })
watch([selectedViewId, readiness.signature], () => refresh(), { immediate: true })

// ⇧⌘P captures Evidence for this View (desktop); ⇧⌘E exports a handoff rooted at it (brief f, section 8).
defineShortcuts({
	meta_shift_p: () => openCapture(),
	meta_shift_e: () => { if (canExport.value && !isReadOnly.value) exportOpen.value = true },
})

async function recheck(): Promise<void> {
	await readiness.loadEvidence(true)
	refresh(true)
}

type Facet = Readonly<{ icon: string; tone: string }>
const validationFacet = computed<Facet>(() => findings.value.length
	? { icon: 'i-lucide-triangle-alert', tone: 'text-warning' }
	: { icon: 'i-lucide-circle-check', tone: 'text-success' })
const evidenceFacet = computed<Facet>(() => {
	const counts = evidenceCounts.value
	if (!counts.total) return { icon: 'i-lucide-circle-dashed', tone: 'text-dimmed' }
	if (counts.stale) return { icon: 'i-lucide-history', tone: 'text-warning' }
	if (counts.fresh) return { icon: 'i-lucide-circle-check', tone: 'text-success' }
	return { icon: 'i-lucide-circle-help', tone: 'text-muted' }
})
const reviewsFacet = computed<Facet>(() => {
	if (readyHere.value) return { icon: 'i-lucide-eye', tone: 'text-info' }
	if (openHere.value) return { icon: 'i-lucide-circle-dot', tone: 'text-annotation' }
	return { icon: 'i-lucide-circle-check', tone: 'text-success' }
})
const handoffFacet = computed<Facet>(() => {
	if (!entry.value || entry.value.status === 'loading' && !entry.value.readiness) return { icon: 'i-lucide-loader-circle', tone: 'text-muted animate-spin' }
	if (entry.value.status === 'failed') return { icon: 'i-lucide-circle-alert', tone: 'text-error' }
	return ready.value ? { icon: 'i-lucide-badge-check', tone: 'text-success' } : { icon: 'i-lucide-circle-x', tone: 'text-error' }
})
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col overflow-y-auto"
    data-readiness-tab
  >
    <header class="flex items-center justify-between gap-2 border-b border-default px-3 py-2">
      <h2 class="min-w-0 truncate text-sm font-semibold text-highlighted">
        {{ t('ready.title', { view: viewName }) }}
      </h2>
      <div class="flex shrink-0 items-center gap-1">
        <UBadge
          v-if="entry?.status === 'ok' && ready"
          color="success"
          variant="subtle"
          icon="i-lucide-badge-check"
          data-readiness-badge="ready"
        >
          {{ t('ready.ready') }}
        </UBadge>
        <UBadge
          v-else-if="entry?.status === 'ok'"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-x"
          data-readiness-badge="blocked"
          :data-blocking-count="split.blocking.length"
        >
          {{ split.blocking.length ? t('ready.blockedBy', split.blocking.length) : t('ready.notReadyShort') }}
        </UBadge>
        <UTooltip :text="t('ready.recheck')">
          <UButton
            size="xs"
            variant="ghost"
            icon="i-lucide-refresh-cw"
            :loading="entry?.status === 'loading' || readiness.evidenceLoading.value"
            :aria-label="t('ready.recheck')"
            @click="recheck"
          />
        </UTooltip>
      </div>
    </header>

    <div class="divide-y divide-(--ui-border)">
      <!-- Validation -->
      <div
        class="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 px-3 py-2.5"
        data-facet="validation"
      >
        <UIcon
          :name="validationFacet.icon"
          class="mt-0.5 size-4"
          :class="validationFacet.tone"
        />
        <dl class="min-w-0 space-y-1">
          <dt class="flex items-center justify-between gap-2 text-sm font-medium text-highlighted">
            {{ t('ready.validation') }}
            <UButton
              v-if="findings.length"
              size="xs"
              variant="link"
              color="neutral"
              :trailing-icon="findingsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              :aria-expanded="findingsOpen"
              class="-me-2 -my-1.5 pointer-coarse:-my-3"
              @click="findingsOpen = !findingsOpen"
            >
              {{ findingsOpen ? t('ready.hide') : t('ready.show') }}
            </UButton>
          </dt>
          <dd class="text-sm text-muted">
            {{ findings.length ? t('ready.findings', findings.length) : t('ready.noFindings') }}
          </dd>
          <dd
            v-if="deferredWidget"
            class="text-xs text-muted"
            role="status"
          >
            {{ t('ready.deferred', { id: deferredWidget }) }}
          </dd>
          <dd v-if="findingsOpen && findings.length">
            <ul class="space-y-1.5 pt-1">
              <li
                v-for="(finding, index) in findings"
                :key="`${finding.code}:${finding.path}:${index}`"
                class="text-sm"
              >
                <span class="block font-mono text-xs text-warning">{{ finding.code }}</span>
                <span class="block text-default">{{ finding.message }}</span>
                <UButton
                  v-if="finding.widgetId"
                  size="xs"
                  variant="link"
                  color="neutral"
                  icon="i-lucide-crosshair"
                  class="-ms-2 font-mono"
                  @click="selectFinding(finding.widgetId!)"
                >
                  {{ finding.widgetType ? `${finding.widgetType} · ` : '' }}#{{ finding.widgetId }}
                </UButton>
                <span
                  v-else
                  class="block text-xs text-dimmed"
                >{{ t('ready.noWidget') }}</span>
              </li>
            </ul>
          </dd>
        </dl>
      </div>

      <!-- Evidence -->
      <div
        class="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 px-3 py-2.5"
        data-facet="evidence"
      >
        <UIcon
          :name="evidenceFacet.icon"
          class="mt-0.5 size-4"
          :class="evidenceFacet.tone"
        />
        <dl class="min-w-0 space-y-1">
          <dt class="flex items-center justify-between gap-2 text-sm font-medium text-highlighted">
            {{ t('ready.evidence') }}
            <UButton
              v-if="canCapture"
              size="xs"
              icon="i-lucide-camera"
              class="-my-1.5 pointer-coarse:-my-3"
              data-capture-open
              @click="openCapture()"
            >
              {{ t('evidence.capture') }}
            </UButton>
          </dt>
          <dd class="text-sm text-muted">
            <template v-if="readiness.evidenceError.value">
              {{ t('evidence.loadFailed') }}
            </template>
            <template v-else-if="!evidenceCounts.total">
              {{ t('evidence.none') }}
            </template>
            <template v-else>
              {{ t('evidence.summary', { fresh: evidenceCounts.fresh, stale: evidenceCounts.stale, unknown: evidenceCounts.unknown, total: evidenceCounts.total }) }}
            </template>
          </dd>
          <dd
            v-if="!isReadOnly && authorReadOnly"
            class="flex items-center gap-1.5 text-xs text-muted"
            data-access-notice="capture"
          >
            <UIcon
              name="i-lucide-user-lock"
              class="size-3.5"
            />
            {{ t('evidence.requiresEditor') }}
          </dd>
          <dd
            v-else-if="!isReadOnly && !isDesktop"
            class="text-xs text-muted"
          >
            {{ t('evidence.desktopOnly') }}
          </dd>
        </dl>
      </div>

      <!-- Reviews -->
      <div
        class="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 px-3 py-2.5"
        data-facet="reviews"
      >
        <UIcon
          :name="reviewsFacet.icon"
          class="mt-0.5 size-4"
          :class="reviewsFacet.tone"
        />
        <dl class="min-w-0 space-y-1">
          <dt class="flex items-center justify-between gap-2 text-sm font-medium text-highlighted">
            {{ t('ready.reviews') }}
            <UButton
              v-if="threadsHere.length"
              size="xs"
              variant="link"
              color="neutral"
              trailing-icon="i-lucide-chevron-right"
              class="-me-2 -my-1.5 pointer-coarse:-my-3"
              @click="emit('openComments')"
            >
              {{ t('ready.openComments') }}
            </UButton>
          </dt>
          <dd class="text-sm text-muted">
            <template v-if="readyHere || openHere">
              {{ [readyHere ? t('ready.reviewsReady', readyHere) : '', openHere ? t('ready.reviewsOpen', openHere) : ''].filter(Boolean).join(' · ') }}
            </template>
            <template v-else-if="threadsHere.length">
              {{ t('ready.reviewsClosed') }}
            </template>
            <template v-else>
              {{ t('ready.reviewsNone') }}
            </template>
          </dd>
          <dd
            v-if="resolvedParts.length"
            class="text-xs text-muted"
            data-resolution-counts
          >
            {{ t('ready.resolvedLabel') }}
            <span
              v-for="(part, index) in resolvedParts"
              :key="part.kind"
              :data-resolution="part.kind"
            >{{ index ? ' · ' : ' ' }}{{ part.count }} {{ t(`comments.resolution.${part.kind}`) }}</span>
          </dd>
        </dl>
      </div>

      <!-- Handoff -->
      <div
        class="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 px-3 py-2.5"
        data-facet="handoff"
      >
        <UIcon
          :name="handoffFacet.icon"
          class="mt-0.5 size-4"
          :class="handoffFacet.tone"
        />
        <dl class="min-w-0 space-y-1.5">
          <dt class="flex items-center justify-between gap-2 text-sm font-medium text-highlighted">
            {{ t('ready.handoff') }}
            <UButton
              v-if="canExport && !isReadOnly"
              size="xs"
              icon="i-lucide-package"
              class="-my-1.5 pointer-coarse:-my-3"
              data-export-open
              @click="exportOpen = true"
            >
              {{ t('handoff.export') }}
            </UButton>
          </dt>
          <dd
            v-if="!entry || entry.status === 'loading' && !entry.readiness"
            class="text-sm text-muted"
          >
            {{ t('ready.checking') }}
          </dd>
          <dd
            v-else-if="entry.status === 'failed'"
            class="text-sm text-error"
          >
            {{ t('handoff.assessFailed') }}<span
              v-if="entry.error?.message"
              class="block text-xs text-muted"
            >{{ entry.error.message }}</span>
          </dd>
          <template v-else>
            <dd
              class="text-sm"
              :class="ready ? 'text-success' : 'text-default'"
            >
              {{ ready ? 'implementation-ready' : t('ready.notReady') }}
            </dd>
            <dd
              v-if="entry.derived"
              class="text-xs text-muted"
            >
              {{ t('ready.derived') }}
            </dd>
            <dd
              v-if="split.blocking.length"
              class="space-y-1"
            >
              <p class="text-xs font-medium text-muted">
                {{ t('ready.blockingTitle', split.blocking.length) }}
              </p>
              <HandoffDiagnosticList
                :diagnostics="split.blocking"
                tone="blocking"
              />
            </dd>
            <dd
              v-if="split.advisory.length"
              class="space-y-1"
            >
              <p class="text-xs font-medium text-muted">
                {{ t('ready.advisoryTitle', split.advisory.length) }}
              </p>
              <HandoffDiagnosticList
                :diagnostics="split.advisory"
                tone="advisory"
              />
            </dd>
          </template>
          <dd
            v-if="!isReadOnly && authorReadOnly"
            class="flex items-center gap-1.5 text-xs text-muted"
            data-access-notice="export"
          >
            <UIcon
              name="i-lucide-user-lock"
              class="size-3.5"
            />
            {{ t('handoff.requiresEditor') }}
          </dd>
        </dl>
      </div>
    </div>

    <!-- Evidence detail: what needs a fresh capture, then the contact sheet -->
    <section
      v-if="evidence.length"
      class="space-y-3 border-t border-default px-3 py-3"
      :aria-label="t('evidence.sectionLabel')"
    >
      <div
        v-if="needsCapture.length"
        class="space-y-1.5"
        data-evidence-stale-list
      >
        <h3 class="text-xs font-medium text-muted">
          {{ t('evidence.needsCapture', needsCapture.length) }}
        </h3>
        <ul class="space-y-1.5">
          <li
            v-for="item in staleShown"
            :key="item.digest"
            class="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2"
          >
            <UIcon
              :name="item.freshness.state === 'stale' ? 'i-lucide-history' : 'i-lucide-circle-help'"
              class="mt-0.5 size-4"
              :class="item.freshness.state === 'stale' ? 'text-warning' : 'text-muted'"
            />
            <span class="min-w-0">
              <span class="block font-mono text-xs leading-5 break-words text-highlighted">{{ staleLabel(item) }}</span>
              <span class="block text-xs text-muted">{{ item.freshness.reason ? t(`evidence.reason.${item.freshness.reason}`, { subject: item.freshness.subject ?? '' }) : '' }}</span>
            </span>
          </li>
        </ul>
        <UButton
          v-if="needsCapture.length > STALE_PREVIEW"
          size="xs"
          variant="link"
          color="neutral"
          class="ms-4"
          :aria-expanded="staleExpanded"
          @click="staleExpanded = !staleExpanded"
        >
          {{ staleExpanded ? t('evidence.showFewer') : t('evidence.showAll', { n: needsCapture.length }) }}
        </UButton>
        <UButton
          v-if="canCapture"
          size="xs"
          icon="i-lucide-camera"
          class="ms-6"
          data-capture-stale
          @click="openCapture(needsCapture.flatMap(item => item.context ? [item.context] : []))"
        >
          {{ t('evidence.captureAllAgain') }}
        </UButton>
      </div>

      <div class="space-y-1.5">
        <h3 class="text-xs font-medium text-muted">
          {{ t('evidence.captures', evidence.length) }}
        </h3>
        <EvidenceSheet
          :entries="evidence"
          :view-name="viewName"
          :can-capture="canCapture"
          @capture-again="openCapture"
          @apply="applyContext"
        />
      </div>
    </section>

    <CaptureSlideover
      v-if="canCapture"
      v-model:open="captureOpen"
      :initial-contexts="captureContexts"
      @captured="refresh(true)"
    />
    <HandoffExportModal
      v-if="!isReadOnly"
      v-model:open="exportOpen"
      :initial-roots="exportRoots"
    />
  </div>
</template>
