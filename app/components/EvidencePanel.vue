<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { useUiuxClient } from '../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../composables/useWorkbenchFeedback'
import { useWorkbenchFormat } from '../composables/useWorkbenchFormat'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import type { FormalEvidenceRecord } from '../../src/domain/evidence/schema'
import { evaluateEvidenceStaleness } from '../../src/domain/evidence/staleness'
import type { ViewResource } from '../../src/domain/views/schema'
import type { WorkspaceManifest } from '../../src/domain/workspace/schema'

type Diagnostic = Readonly<{ code: string; path: string; message: string }>
type ViewRead = Readonly<{
	kind: 'view'
	key: string
	revision: string
	diagnostics: readonly Diagnostic[]
	resource: ViewResource
}>
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
	summary: { name?: string; feature?: string }
}>
type FormalEvidenceItem = Readonly<{
	digest: string
	record: FormalEvidenceRecord
}>
type CaptureContextResult = Readonly<{
	context?: Readonly<Record<string, unknown>>
	status: 'captured' | 'failed'
	evidenceDigest?: string
	error?: string
	diagnostics?: readonly Readonly<{ code?: string; path?: string; message: string }>[]
}>
type CaptureResponse = Readonly<{
	status: 'ok' | 'incomplete' | 'failed'
	results: readonly CaptureContextResult[]
	summary?: Readonly<{ total: number; captured: number; failed: number }>
	executedAt?: string
}>
type CaptureFailure = Readonly<{ label: string; messages: readonly string[] }>
type CaptureIssue = Readonly<{
	color: 'warning' | 'error'
	title: string
	description?: string
	failures: readonly CaptureFailure[]
}>

const props = defineProps<{
	readOnly?: boolean
	selectedView?: ViewRead
	allViews: readonly ViewSummary[]
	workspace?: WorkspaceRead
	discoveredLocales: readonly string[]
	localeRevisions: Readonly<Record<string, string>>
	activeContext?: {
		viewId: string
		variantName?: string
		locale: string
		viewportId: string
		viewport: { width: number; height: number }
		themeId: string
	}
}>()

const uiux = useUiuxClient()
const { t } = useI18n()
const feedback = useWorkbenchFeedback()
const fmt = useWorkbenchFormat()

const emit = defineEmits<{
	(e: 'applyContext', context: {
		viewId: string
		variantName?: string
		locale: string
		viewportId: string
		themeId: string
	}): void
	(e: 'refresh'): void
	(e: 'changed'): void
}>()

const evidenceItems = shallowRef<readonly FormalEvidenceItem[]>([])
const loading = ref(false)
const loadError = shallowRef<FetchErrorDetails>()
const capturing = ref(false)
const captureIssue = shallowRef<CaptureIssue>()
const filterCurrentView = ref(false)
const selectedEvidenceDigest = ref<string>()
const modalImageUrl = ref<string>()

const modalOpen = computed({
	get: () => modalImageUrl.value !== undefined,
	set: (open: boolean) => {
		if (!open) modalImageUrl.value = undefined
	},
})

const filteredItems = computed<readonly FormalEvidenceItem[]>(() => {
	if (!filterCurrentView.value || !props.selectedView?.key) {
		return evidenceItems.value
	}
	return evidenceItems.value.filter(item => {
		const ctx = item.record.executionContext as Record<string, unknown> | undefined
		return ctx?.viewId === props.selectedView?.key
	})
})

const selectedItem = computed<FormalEvidenceItem | undefined>(() => {
	return evidenceItems.value.find(i => i.digest === selectedEvidenceDigest.value) || filteredItems.value[0]
})

const selectedDigest = computed<string | undefined>({
	get: () => selectedItem.value?.digest,
	set: (digest) => {
		if (digest) selectedEvidenceDigest.value = digest
	},
})

const stalenessByDigest = computed(() => {
	const map = new Map<string, { isStale: boolean; reason?: string }>()
	for (const item of evidenceItems.value) {
		map.set(item.digest, checkStaleness(item.record))
	}
	return map
})

const listItems = computed(() => filteredItems.value.map((item) => {
	const ctx = item.record.executionContext as Record<string, unknown> | undefined
	return {
		value: item.digest,
		label: shortHash(item.digest),
		viewId: String(ctx?.viewId ?? ''),
		locale: String(ctx?.locale ?? ''),
		themeId: String(ctx?.themeId ?? ''),
		isStale: stalenessByDigest.value.get(item.digest)?.isStale ?? true,
	}
}))

const selectedStaleness = computed(() => {
	if (!selectedItem.value) return undefined
	return stalenessByDigest.value.get(selectedItem.value.digest)
})

const selectedItemContext = computed(() => {
	if (!selectedItem.value) return undefined
	const ctx = selectedItem.value.record.executionContext as Record<string, unknown>
	const vp = ctx?.viewport as { width?: number; height?: number } | undefined
	return {
		viewId: String(ctx?.viewId ?? ''),
		variantName: ctx?.variantName ? String(ctx.variantName) : undefined,
		locale: String(ctx?.locale ?? ''),
		viewportId: String(ctx?.viewportId ?? ''),
		viewportWidth: vp?.width ?? 0,
		viewportHeight: vp?.height ?? 0,
		themeId: String(ctx?.themeId ?? ''),
	}
})

function shortHash(hash: string): string {
	if (hash.startsWith('sha256:')) {
		return `${hash.slice(7, 19)}…`
	}
	return hash.slice(0, 12)
}

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		feedback.success(t('evidence.copied'))
	}
	catch (cause) {
		feedback.error(cause, t('evidence.copyFailed'))
	}
}

function artifactUrl(digest: string): string {
	return uiux.artifactUrl(digest)
}

async function loadEvidence() {
	loading.value = true
	loadError.value = undefined
	try {
		const items = await uiux.listEvidence<FormalEvidenceItem>()
		evidenceItems.value = items || []
		if (!selectedEvidenceDigest.value && evidenceItems.value.length > 0) {
			selectedEvidenceDigest.value = evidenceItems.value[0]?.digest
		}
	}
	catch (cause) {
		evidenceItems.value = []
		loadError.value = describeFetchError(cause, t('evidence.loadFailed'))
	}
	finally {
		loading.value = false
	}
}

function contextLabel(context: Readonly<Record<string, unknown>> | undefined): string {
	if (!context) return t('evidence.capture.unknownContext')
	const parts = [context.viewId, context.variantName, context.locale, context.viewportId, context.themeId]
		.filter(part => typeof part === 'string' && part.length > 0)
	return parts.length ? parts.join(' · ') : t('evidence.capture.unknownContext')
}

function collectFailures(results: readonly CaptureContextResult[] | undefined): CaptureFailure[] {
	const list: readonly CaptureContextResult[] = Array.isArray(results) ? results : []
	return list
		.filter(result => result.status !== 'captured')
		.map((result) => {
			const messages = [
				...(result.error ? [result.error] : []),
				...(result.diagnostics ?? []).map(item => item.message).filter(message => message && message !== result.error),
			]
			return {
				label: contextLabel(result.context),
				messages: messages.length ? messages : [t('evidence.capture.noDetails')],
			}
		})
}

function captureSummary(res: CaptureResponse | undefined): string | undefined {
	if (!res?.summary) return undefined
	const summary = t('evidence.capture.summary', {
		captured: fmt.number(res.summary.captured),
		total: fmt.number(res.summary.total),
	})
	if (!res.executedAt) return summary
	return `${summary} ${t('evidence.capture.executedAt', { time: fmt.dateTime(res.executedAt) })}`
}

function selectCapturedDigest(res: CaptureResponse) {
	const digest = res.results.find(result => result.status === 'captured' && result.evidenceDigest)?.evidenceDigest
	if (digest) selectedEvidenceDigest.value = digest
}

async function captureCurrentContext() {
	if (props.readOnly) return
	if (!props.activeContext || !props.activeContext.viewId) return
	capturing.value = true
	captureIssue.value = undefined
	try {
		// 200 → ok, 207 → incomplete (resolves), 422 → failed (throws with the result body).
		const res = await $fetch<CaptureResponse>('/api/evidence/capture', {
			method: 'POST',
			body: {
				contexts: [props.activeContext],
			},
		})
		if (res.status === 'ok') {
			await loadEvidence()
			selectCapturedDigest(res)
			feedback.success(
				t('evidence.capture.succeeded'),
				res.executedAt ? t('evidence.capture.executedAt', { time: fmt.dateTime(res.executedAt) }) : undefined,
			)
			emit('refresh')
			emit('changed')
		}
		else if (res.status === 'incomplete') {
			// Some contexts were captured: refresh the list, but do not report success.
			await loadEvidence()
			selectCapturedDigest(res)
			emit('changed')
			captureIssue.value = {
				color: 'warning',
				title: t('evidence.capture.incompleteTitle'),
				description: captureSummary(res),
				failures: collectFailures(res.results),
			}
		}
		else {
			captureIssue.value = {
				color: 'error',
				title: t('evidence.capture.failedTitle'),
				description: captureSummary(res),
				failures: collectFailures(res.results),
			}
			feedback.error({ data: res }, t('evidence.capture.failed'))
		}
	}
	catch (cause) {
		const details = feedback.error(cause, t('evidence.capture.failed'))
		const body = (cause as { data?: unknown } | undefined)?.data as CaptureResponse | undefined
		const failures = collectFailures(body?.results)
		captureIssue.value = {
			color: 'error',
			title: t('evidence.capture.failedTitle'),
			description: failures.length ? captureSummary(body) : details.message,
			failures: failures.length
				? failures
				: details.diagnostics
					.filter(item => item.message !== details.message)
					.map(item => ({ label: item.path || item.code || '', messages: [item.message] })),
		}
	}
	finally {
		capturing.value = false
	}
}

function checkStaleness(record: FormalEvidenceRecord): { isStale: boolean; reason?: string } {
	return evaluateEvidenceStaleness(record, {
		allViews: props.allViews,
		selectedView: props.selectedView ? { key: props.selectedView.key, revision: props.selectedView.revision } : undefined,
		workspace: props.workspace,
		discoveredLocales: props.discoveredLocales,
		localeRevisions: props.localeRevisions,
	})
}

/** Maps the domain staleness reasons to Workbench chrome messages; unknown reasons are shown as-is. */
function stalenessReason(reason: string | undefined): string {
	if (!reason) return t('evidence.stale.unknown')
	const fixed: Record<string, string> = {
		'Missing executionContext.viewId': t('evidence.stale.missingViewId'),
		'View no longer exists': t('evidence.stale.viewMissing'),
		'Evidence provenance missing View reference': t('evidence.stale.provenanceMissing'),
		'View revision has changed since capture': t('evidence.stale.viewRevisionChanged'),
	}
	const fixedReason = fixed[reason]
	if (fixedReason) return fixedReason
	let match = /^Locale '(.+)' is not in workspace$/.exec(reason)
	if (match) return t('evidence.stale.localeMissing', { locale: match[1] })
	match = /^Locale '(.+)' revision has changed since capture$/.exec(reason)
	if (match) return t('evidence.stale.localeRevisionChanged', { locale: match[1] })
	match = /^Viewport preset '(.+)' was removed$/.exec(reason)
	if (match) return t('evidence.stale.viewportRemoved', { viewport: match[1] })
	match = /^Viewport preset '(.+)' dimensions changed since capture$/.exec(reason)
	if (match) return t('evidence.stale.viewportChanged', { viewport: match[1] })
	match = /^Theme '(.+)' was removed$/.exec(reason)
	if (match) return t('evidence.stale.themeRemoved', { theme: match[1] })
	return reason
}

function applyItemContext(record: FormalEvidenceRecord) {
	const ctx = record.executionContext as Record<string, unknown> | undefined
	if (!ctx?.viewId) return
	emit('applyContext', {
		viewId: ctx.viewId as string,
		variantName: ctx.variantName as string | undefined,
		locale: (ctx.locale as string) || 'en-US',
		viewportId: (ctx.viewportId as string) || 'default',
		themeId: (ctx.themeId as string) || 'light',
	})
}

onMounted(() => {
	loadEvidence()
})

watch(() => props.selectedView?.key, () => {
	if (filterCurrentView.value) {
		loadEvidence()
	}
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden text-default">
    <!-- Header -->
    <div class="flex shrink-0 flex-col gap-2 border-b border-default p-3">
      <div>
        <h2 class="text-xs font-semibold text-highlighted">
          {{ t('evidence.title') }}
        </h2>
        <p class="text-xs text-muted">
          {{ t('evidence.subtitle') }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :loading="loading"
          @click="loadEvidence"
        >
          {{ t('common.refresh') }}
        </UButton>
        <UButton
          v-if="!readOnly"
          size="xs"
          color="primary"
          icon="i-lucide-camera"
          :loading="capturing"
          :disabled="!activeContext"
          @click="captureCurrentContext"
        >
          {{ t('evidence.captureActive') }}
        </UButton>
      </div>
      <p
        v-if="!readOnly && !activeContext"
        class="text-xs text-dimmed"
      >
        {{ t('evidence.captureUnavailable') }}
      </p>
    </div>

    <!-- Capture outcome (incomplete / failed) -->
    <div
      v-if="captureIssue"
      class="shrink-0 border-b border-default p-2"
    >
      <UAlert
        :color="captureIssue.color"
        variant="subtle"
        :icon="captureIssue.color === 'error' ? 'i-lucide-circle-alert' : 'i-lucide-triangle-alert'"
        :title="captureIssue.title"
        :description="captureIssue.description"
        close
        @update:open="captureIssue = undefined"
      >
        <template
          v-if="captureIssue.failures.length"
          #description
        >
          <p v-if="captureIssue.description">
            {{ captureIssue.description }}
          </p>
          <ul class="mt-1 space-y-1">
            <li
              v-for="(failure, idx) in captureIssue.failures"
              :key="idx"
              class="break-words"
            >
              <span
                v-if="failure.label"
                class="font-mono font-semibold"
              >{{ failure.label }}</span>
              <p
                v-for="(message, mIdx) in failure.messages"
                :key="mIdx"
              >
                {{ message }}
              </p>
            </li>
          </ul>
        </template>
      </UAlert>
    </div>

    <!-- Filter Toggle -->
    <div class="flex shrink-0 items-center justify-between gap-2 border-b border-default px-3 py-2">
      <UCheckbox
        v-model="filterCurrentView"
        size="xs"
        :label="t('evidence.onlyCurrentView')"
        :disabled="!selectedView"
      />
      <span class="text-xs text-muted">{{ t('evidence.recordCount', { n: fmt.number(filteredItems.length) }, filteredItems.length) }}</span>
    </div>

    <!-- Sidebar-friendly single-column list + detail flow -->
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-2">
      <UAlert
        v-if="loadError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('evidence.loadFailed')"
        :description="loadError.message"
        :actions="[{ label: t('common.retry'), color: 'error', variant: 'outline', size: 'xs', icon: 'i-lucide-rotate-cw', onClick: () => { loadEvidence() } }]"
      />

      <!-- Evidence List -->
      <UEmpty
        v-else-if="filteredItems.length === 0 && !loading"
        icon="i-lucide-camera"
        size="sm"
        variant="naked"
        :title="t('evidence.empty.title')"
        :description="readOnly ? t('evidence.empty.readOnly') : t('evidence.empty.description')"
      />

      <UListbox
        v-else-if="filteredItems.length > 0"
        v-model="selectedDigest"
        :items="listItems"
        value-key="value"
        size="sm"
        selected-icon="i-lucide-check"
        :aria-label="t('evidence.listLabel')"
        :ui="{
          content: 'max-h-72',
          itemDescription: 'whitespace-normal',
          item: 'data-[state=checked]:text-selection data-[state=checked]:before:bg-selection-subtle',
        }"
      >
        <template #item-label="{ item }">
          <span class="font-mono font-semibold">{{ item.label }}</span>
        </template>
        <template #item-description="{ item }">
          <span class="flex flex-wrap gap-x-2 gap-y-0.5 whitespace-normal text-xs">
            <span>{{ t('evidence.context.view') }} <code class="text-toned">{{ item.viewId.slice(0, 8) }}…</code></span>
            <span>{{ t('evidence.context.locale') }} <code class="text-toned">{{ item.locale }}</code></span>
            <span>{{ t('evidence.context.theme') }} <code class="text-toned">{{ item.themeId }}</code></span>
          </span>
        </template>
        <template #item-trailing="{ item }">
          <UBadge
            :color="item.isStale ? 'warning' : 'success'"
            variant="subtle"
            size="xs"
            :icon="item.isStale ? 'i-lucide-clock-alert' : 'i-lucide-circle-check'"
          >
            {{ item.isStale ? t('evidence.status.stale') : t('evidence.status.current') }}
          </UBadge>
        </template>
      </UListbox>

      <!-- Evidence Detail & Inspector -->
      <UCard
        v-if="selectedItem"
        variant="outline"
        class="min-w-0"
        :ui="{ body: 'space-y-4 p-3 sm:p-3' }"
      >
        <!-- Identity Section -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold text-muted">{{ t('evidence.identity') }}</span>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-copy"
              @click="copyText(selectedItem.digest)"
            >
              {{ t('evidence.copyDigest') }}
            </UButton>
          </div>
          <p class="break-all rounded border border-default bg-muted p-2 font-mono text-xs">
            {{ selectedItem.digest }}
          </p>
        </div>

        <!-- Staleness Warning -->
        <UAlert
          v-if="selectedStaleness?.isStale"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock-alert"
          :title="t('evidence.stale.title')"
          :description="stalenessReason(selectedStaleness.reason)"
        />

        <!-- Screenshot Preview -->
        <div
          v-if="selectedItem.record.artifactRefs.length > 0"
          class="space-y-1.5"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold text-muted">{{ t('evidence.screenshot.title') }}</span>
            <span class="font-mono text-xs text-dimmed">{{ shortHash(selectedItem.record.artifactRefs[0]!) }}</span>
          </div>
          <UButton
            color="neutral"
            variant="outline"
            block
            class="p-2"
            :aria-label="t('evidence.screenshot.enlarge')"
            @click="modalImageUrl = artifactUrl(selectedItem.record.artifactRefs[0]!)"
          >
            <img
              :src="artifactUrl(selectedItem.record.artifactRefs[0]!)"
              :alt="t('evidence.screenshot.alt')"
              class="max-h-48 rounded object-contain"
            >
          </UButton>
        </div>

        <!-- Render Context Info (definition list: no Nuxt UI equivalent) -->
        <div class="space-y-1.5 text-xs">
          <span class="font-semibold text-muted">{{ t('evidence.context.title') }}</span>
          <dl
            v-if="selectedItemContext"
            class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 rounded border border-default bg-muted p-2 text-xs"
          >
            <dt class="text-muted">
              {{ t('evidence.context.viewId') }}
            </dt>
            <dd class="break-all font-mono text-highlighted">
              {{ selectedItemContext.viewId }}
            </dd>
            <dt class="text-muted">
              {{ t('evidence.context.variant') }}
            </dt>
            <dd class="font-mono text-highlighted">
              {{ selectedItemContext.variantName ?? t('evidence.context.baseVariant') }}
            </dd>
            <dt class="text-muted">
              {{ t('evidence.context.localeLabel') }}
            </dt>
            <dd class="font-mono text-highlighted">
              {{ selectedItemContext.locale }}
            </dd>
            <dt class="text-muted">
              {{ t('evidence.context.viewport') }}
            </dt>
            <dd class="font-mono text-highlighted">
              {{ t('evidence.context.viewportValue', {
                id: selectedItemContext.viewportId,
                width: fmt.number(selectedItemContext.viewportWidth),
                height: fmt.number(selectedItemContext.viewportHeight),
              }) }}
            </dd>
            <dt class="text-muted">
              {{ t('evidence.context.themeLabel') }}
            </dt>
            <dd class="font-mono text-highlighted">
              {{ selectedItemContext.themeId }}
            </dd>
          </dl>
        </div>

        <!-- Provenance Revisions (definition list: no Nuxt UI equivalent) -->
        <div class="space-y-1.5 text-xs">
          <span class="font-semibold text-muted">{{ t('evidence.provenance.title') }}</span>
          <div class="space-y-1 rounded border border-default bg-muted p-2 text-xs">
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
              <dt class="text-muted">
                {{ t('evidence.provenance.uiuxVersion') }}
              </dt>
              <dd class="font-mono text-highlighted">
                {{ selectedItem.record.provenance.versions?.uiux || t('evidence.provenance.unknown') }}
              </dd>
              <dt class="text-muted">
                {{ t('evidence.provenance.schemaVersion') }}
              </dt>
              <dd class="font-mono text-highlighted">
                {{ selectedItem.record.provenance.workspaceSchemaVersion }}
              </dd>
            </dl>
            <p class="pt-1 text-muted">
              {{ t('evidence.provenance.resources') }}
            </p>
            <ul class="space-y-0.5 pl-2 font-mono">
              <li
                v-for="(r, idx) in selectedItem.record.provenance.resources"
                :key="idx"
                class="break-all"
              >
                {{ r.identity.type }}:{{ String(r.identity.id || '').slice(0, 8) }} → {{ r.revision }}
              </li>
            </ul>
          </div>
        </div>

        <!-- Action: Apply Context to Preview -->
        <UButton
          size="sm"
          color="neutral"
          variant="soft"
          block
          icon="i-lucide-crosshair"
          @click="applyItemContext(selectedItem.record)"
        >
          {{ t('evidence.applyContext') }}
        </UButton>
      </UCard>
      <p
        v-else-if="filteredItems.length > 0"
        class="p-6 text-center text-xs text-muted"
      >
        {{ t('evidence.selectPrompt') }}
      </p>
    </div>

    <!-- Enlarged Image Modal -->
    <UModal
      v-model:open="modalOpen"
      :title="t('evidence.screenshot.enlargedTitle')"
      close
      :ui="{ content: 'sm:max-w-5xl' }"
    >
      <template #body>
        <img
          v-if="modalImageUrl"
          :src="modalImageUrl"
          :alt="t('evidence.screenshot.enlargedAlt')"
          class="mx-auto max-h-[75vh] max-w-full rounded object-contain"
        >
      </template>
    </UModal>
  </div>
</template>
