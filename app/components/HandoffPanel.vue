<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { useUiuxClient } from '../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../composables/useWorkbenchFeedback'
import { useWorkbenchFormat } from '../composables/useWorkbenchFormat'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import type {
	HandoffManifest,
	HandoffReadiness,
	HandoffReadinessAssessment,
	HandoffRoot,
} from '../../src/domain/handoff/schema'

type ViewSummary = Readonly<{
	kind: 'view'
	key: string
	revision: string
	summary: { name?: string; feature?: string }
}>
type FlowSummary = Readonly<{
	kind: 'flow'
	key: string
	revision: string
	summary: { name?: string }
}>
type AssetSummary = Readonly<{
	kind: 'asset'
	key: string
	revision: string
	summary: { name?: string; mediaType?: string }
}>
type ResultDiagnostic = Readonly<{ code?: string; path?: string; message: string }>

const props = defineProps<{
	readOnly?: boolean
	views: readonly ViewSummary[]
}>()

const emit = defineEmits<{
	(e: 'changed'): void
}>()

const uiux = useUiuxClient()
const { t } = useI18n()
const feedback = useWorkbenchFeedback()
const fmt = useWorkbenchFormat()

const rootMode = ref<'workspace' | 'custom'>('workspace')
const selectedViewIds = ref<string[]>([])
const selectedFlowIds = ref<string[]>([])
const selectedAssetIds = ref<string[]>([])

const availableFlows = ref<readonly FlowSummary[]>([])
const availableAssets = ref<readonly AssetSummary[]>([])

const assessing = ref(false)
const exporting = ref(false)
const assessment = ref<HandoffReadinessAssessment>()
const readiness = ref<HandoffReadiness>()
const exportedResult = ref<{
	manifest?: HandoffManifest
	manifestArtifactDigest?: string
	bundleIdentity?: string
	readiness?: HandoffReadiness
}>()
const operationError = shallowRef<Readonly<{ title: string; details: FetchErrorDetails }>>()

const hasViews = computed(() => props.views.length > 0)

const rootModeItems = computed(() => [
	{ label: t('handoff.scope.workspace'), value: 'workspace' as const },
	{ label: t('handoff.scope.custom'), value: 'custom' as const },
])
const viewItems = computed(() => props.views.map(v => ({ label: v.summary.name || v.key, value: v.key })))
const flowItems = computed(() => availableFlows.value.map(f => ({ label: f.summary.name || f.key, value: f.key })))
const assetItems = computed(() => availableAssets.value.map(a => ({ label: a.summary.name || a.key, value: a.key })))

const computedRoots = computed<readonly HandoffRoot[]>(() => {
	if (rootMode.value === 'workspace') {
		return [{ type: 'workspace' }]
	}
	const roots: HandoffRoot[] = []
	for (const viewId of selectedViewIds.value) {
		roots.push({ type: 'view', viewId })
	}
	for (const flowId of selectedFlowIds.value) {
		roots.push({ type: 'flow', flowId })
	}
	for (const assetId of selectedAssetIds.value) {
		roots.push({ type: 'asset', assetId })
	}
	return roots
})

/** There is something to hand off: at least one View exists and at least one root is selected. */
const canAssess = computed(() => hasViews.value && computedRoots.value.length > 0)

/** Never claim readiness for an empty Workspace or an empty root selection. */
const isReady = computed(() => canAssess.value && readiness.value?.implementationReady === true)

const exportedReady = computed(() => {
	const result = exportedResult.value
	if (!result?.readiness?.implementationReady) return false
	return (result.manifest?.resources.length ?? 0) > 0
})

async function loadFlowsAndAssets() {
	const [flowRes, assetRes] = await Promise.all([
		uiux.listResources<FlowSummary>(['flow'], { limit: 100 }).catch(() => ({ items: [] as FlowSummary[] })),
		uiux.listResources<AssetSummary>(['asset'], { limit: 100 }).catch(() => ({ items: [] as AssetSummary[] })),
	])
	availableFlows.value = flowRes.items || []
	availableAssets.value = assetRes.items || []
}

function diagnosticsDetails(diagnostics: readonly ResultDiagnostic[] | undefined, fallback: string): FetchErrorDetails {
	return describeFetchError({ data: { diagnostics: diagnostics ?? [] } }, fallback)
}

async function runAssessment() {
	if (!canAssess.value) {
		readiness.value = undefined
		assessment.value = undefined
		return
	}
	assessing.value = true
	operationError.value = undefined
	try {
		const res = await uiux.assessHandoff<{
			status: string
			readiness?: HandoffReadiness
			assessment?: HandoffReadinessAssessment
			diagnostics?: readonly ResultDiagnostic[]
		}>(computedRoots.value)
		if (res.status === 'ok') {
			readiness.value = res.readiness
			assessment.value = res.assessment
		}
		else {
			readiness.value = undefined
			assessment.value = undefined
			operationError.value = {
				title: t('handoff.assessFailed'),
				details: diagnosticsDetails(res.diagnostics, t('handoff.assessFailed')),
			}
		}
	}
	catch (cause) {
		readiness.value = undefined
		assessment.value = undefined
		operationError.value = {
			title: t('handoff.assessFailed'),
			details: describeFetchError(cause, t('handoff.assessFailed')),
		}
	}
	finally {
		assessing.value = false
	}
}

async function runExport() {
	if (props.readOnly || !canAssess.value) return
	exporting.value = true
	operationError.value = undefined
	try {
		const res = await $fetch<{
			status: string
			manifest?: HandoffManifest
			manifestArtifactDigest?: string
			bundleIdentity?: string
			readiness?: HandoffReadiness
			diagnostics?: readonly ResultDiagnostic[]
		}>('/api/handoff/export', {
			method: 'POST',
			body: { roots: computedRoots.value },
		})
		if (res.status === 'exported') {
			exportedResult.value = {
				manifest: res.manifest,
				manifestArtifactDigest: res.manifestArtifactDigest,
				bundleIdentity: res.bundleIdentity,
				readiness: res.readiness,
			}
			feedback.success(t('handoff.exportSucceeded'))
			emit('changed')
		}
		else {
			const details = feedback.error({ data: { diagnostics: res.diagnostics ?? [] } }, t('handoff.exportFailed'))
			operationError.value = { title: t('handoff.exportFailed'), details }
		}
	}
	catch (cause) {
		const details = feedback.error(cause, t('handoff.exportFailed'))
		operationError.value = { title: t('handoff.exportFailed'), details }
	}
	finally {
		exporting.value = false
	}
}

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		feedback.success(t('handoff.copied'))
	}
	catch (cause) {
		feedback.error(cause, t('handoff.copyFailed'))
	}
}

function downloadManifest() {
	if (!exportedResult.value?.manifest) return
	const json = JSON.stringify(exportedResult.value.manifest, null, 2)
	const blob = new Blob([json], { type: 'application/json' })
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = `handoff-${exportedResult.value.bundleIdentity?.slice(0, 16) || 'manifest'}.json`
	a.click()
	URL.revokeObjectURL(url)
}

watch(computedRoots, () => {
	runAssessment()
}, { deep: true })

watch(hasViews, () => {
	runAssessment()
})

onMounted(async () => {
	await loadFlowsAndAssets()
	await runAssessment()
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden text-default">
    <!-- Header -->
    <div class="flex shrink-0 flex-col gap-2 border-b border-default p-3">
      <div>
        <h2 class="text-xs font-semibold text-highlighted">
          {{ t('handoff.title') }}
        </h2>
        <p class="text-xs text-muted">
          {{ t('handoff.subtitle') }}
        </p>
      </div>
      <div
        v-if="!readOnly"
        class="grid grid-cols-2 gap-2"
      >
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          :loading="assessing"
          :disabled="!canAssess"
          class="justify-center"
          @click="runAssessment"
        >
          {{ t('handoff.reassess') }}
        </UButton>
        <UButton
          size="xs"
          color="primary"
          icon="i-lucide-package"
          :loading="exporting"
          :disabled="!canAssess"
          class="justify-center"
          @click="runExport"
        >
          {{ t('handoff.export') }}
        </UButton>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <!-- Nothing to hand off yet -->
      <UEmpty
        v-if="!hasViews"
        icon="i-lucide-package-open"
        size="sm"
        variant="naked"
        class="p-3"
        :title="t('handoff.empty.title')"
      >
        <template #description>
          <p v-if="readOnly">
            {{ t('handoff.empty.readOnly') }}
          </p>
          <i18n-t
            v-else
            keypath="handoff.empty.description"
            tag="p"
            scope="global"
          >
            <template #tool>
              <code class="rounded bg-elevated px-1 font-mono text-highlighted">create_view</code>
            </template>
          </i18n-t>
        </template>
      </UEmpty>

      <template v-else>
        <div
          v-if="operationError"
          class="border-b border-default p-2"
        >
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="operationError.title"
            close
            @update:open="operationError = undefined"
          >
            <template #description>
              <p>{{ operationError.details.message }}</p>
              <ul
                v-if="operationError.details.diagnostics.length > 1"
                class="mt-1 list-disc space-y-0.5 pl-4"
              >
                <li
                  v-for="(diag, idx) in operationError.details.diagnostics"
                  :key="idx"
                  class="break-words"
                >
                  <code
                    v-if="diag.code"
                    class="font-mono"
                  >{{ diag.code }}</code>
                  {{ diag.message }}
                </li>
              </ul>
            </template>
          </UAlert>
        </div>

        <div
          v-if="readOnly"
          class="border-b border-default p-3"
        >
          <UAlert
            color="info"
            variant="subtle"
            icon="i-lucide-lock"
            :description="t('handoff.readOnlyNotice')"
          />
        </div>

        <!-- Root Picker -->
        <div
          v-if="!readOnly"
          class="space-y-4 border-b border-default p-3"
        >
          <URadioGroup
            v-model="rootMode"
            :legend="t('handoff.scope.legend')"
            :items="rootModeItems"
            orientation="horizontal"
            size="xs"
          />

          <!-- Custom Roots Selector -->
          <div
            v-if="rootMode === 'custom'"
            class="space-y-3"
          >
            <div class="space-y-1.5">
              <div class="flex items-center justify-between text-xs">
                <span class="font-medium text-toned">{{ t('handoff.roots.views') }}</span>
                <UBadge
                  color="neutral"
                  variant="subtle"
                  size="xs"
                >
                  {{ t('handoff.roots.selected', { n: fmt.number(selectedViewIds.length) }, selectedViewIds.length) }}
                </UBadge>
              </div>
              <UCheckboxGroup
                v-model="selectedViewIds"
                :items="viewItems"
                :aria-label="t('handoff.roots.views')"
                size="xs"
                class="max-h-36 overflow-y-auto rounded border border-default bg-muted p-2"
                :ui="{ label: 'truncate' }"
              />
            </div>

            <div
              v-if="flowItems.length > 0"
              class="space-y-1.5"
            >
              <div class="flex items-center justify-between text-xs">
                <span class="font-medium text-toned">{{ t('handoff.roots.flows') }}</span>
                <UBadge
                  color="neutral"
                  variant="subtle"
                  size="xs"
                >
                  {{ t('handoff.roots.selected', { n: fmt.number(selectedFlowIds.length) }, selectedFlowIds.length) }}
                </UBadge>
              </div>
              <UCheckboxGroup
                v-model="selectedFlowIds"
                :items="flowItems"
                :aria-label="t('handoff.roots.flows')"
                size="xs"
                class="max-h-28 overflow-y-auto rounded border border-default bg-muted p-2"
                :ui="{ label: 'truncate' }"
              />
            </div>

            <div
              v-if="assetItems.length > 0"
              class="space-y-1.5"
            >
              <div class="flex items-center justify-between text-xs">
                <span class="font-medium text-toned">{{ t('handoff.roots.assets') }}</span>
                <UBadge
                  color="neutral"
                  variant="subtle"
                  size="xs"
                >
                  {{ t('handoff.roots.selected', { n: fmt.number(selectedAssetIds.length) }, selectedAssetIds.length) }}
                </UBadge>
              </div>
              <UCheckboxGroup
                v-model="selectedAssetIds"
                :items="assetItems"
                :aria-label="t('handoff.roots.assets')"
                size="xs"
                class="max-h-28 overflow-y-auto rounded border border-default bg-muted p-2"
                :ui="{ label: 'truncate' }"
              />
            </div>

            <p
              v-if="computedRoots.length === 0"
              class="text-xs text-warning"
            >
              {{ t('handoff.roots.noneSelected') }}
            </p>
          </div>

          <USeparator />
          <p class="text-xs text-muted">
            {{ t('handoff.closureNote') }}
          </p>
        </div>

        <!-- Readiness & Export Outcome -->
        <div class="space-y-4 p-3">
          <UEmpty
            v-if="assessing && !readiness"
            loading
            size="xs"
            variant="naked"
            :title="t('handoff.assessing')"
          />

          <!-- Readiness Assessment Banner -->
          <UAlert
            v-else-if="readiness && canAssess"
            :color="isReady ? 'success' : 'warning'"
            variant="subtle"
            :icon="isReady ? 'i-lucide-badge-check' : 'i-lucide-triangle-alert'"
            :title="isReady ? t('handoff.readiness.ready') : t('handoff.readiness.notReady')"
          >
            <template #description>
              <p class="leading-relaxed">
                {{ isReady ? t('handoff.readiness.readyDescription') : t('handoff.readiness.notReadyDescription') }}
              </p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <UBadge
                  :color="assessment?.closureValid ? 'success' : 'error'"
                  variant="subtle"
                  size="xs"
                  :icon="assessment?.closureValid ? 'i-lucide-check' : 'i-lucide-x'"
                >
                  {{ t('handoff.coverage.validation') }} · {{ assessment?.closureValid ? t('handoff.coverage.passed') : t('handoff.coverage.issues') }}
                </UBadge>
                <UBadge
                  :color="assessment?.requiredEvidenceComplete ? 'success' : 'warning'"
                  variant="subtle"
                  size="xs"
                  :icon="assessment?.requiredEvidenceComplete ? 'i-lucide-check' : 'i-lucide-x'"
                >
                  {{ t('handoff.coverage.evidence') }} · {{ assessment?.requiredEvidenceComplete ? t('handoff.coverage.complete') : t('handoff.coverage.missing') }}
                </UBadge>
                <UBadge
                  :color="assessment?.reviewCoverageComplete ? 'success' : 'warning'"
                  variant="subtle"
                  size="xs"
                  :icon="assessment?.reviewCoverageComplete ? 'i-lucide-check' : 'i-lucide-x'"
                >
                  {{ t('handoff.coverage.reviews') }} · {{ assessment?.reviewCoverageComplete ? t('handoff.coverage.resolved') : t('handoff.coverage.open') }}
                </UBadge>
              </div>
            </template>
          </UAlert>

          <!-- Blocking Diagnostics -->
          <div
            v-if="canAssess && readiness?.blockingDiagnostics && readiness.blockingDiagnostics.length > 0"
            class="space-y-1.5"
          >
            <span class="text-xs font-semibold text-muted">
              {{ t('handoff.blocking.title', { n: fmt.number(readiness.blockingDiagnostics.length) }, readiness.blockingDiagnostics.length) }}
            </span>
            <ul class="max-h-40 space-y-1 overflow-y-auto">
              <li
                v-for="(diag, idx) in readiness.blockingDiagnostics"
                :key="idx"
              >
                <UAlert
                  :color="diag.blocking ? 'error' : 'warning'"
                  variant="subtle"
                  :title="diag.code"
                  :ui="{ title: 'font-mono text-xs', description: 'text-xs' }"
                >
                  <template #description>
                    <p>{{ diag.message }}</p>
                    <p
                      v-if="diag.path"
                      class="font-mono text-xs text-muted"
                    >
                      {{ t('handoff.blocking.path', { path: diag.path }) }}
                    </p>
                  </template>
                </UAlert>
              </li>
            </ul>
          </div>

          <!-- Exported Snapshot Card -->
          <UCard
            v-if="exportedResult"
            variant="subtle"
            :ui="{ header: 'p-3 sm:px-3', body: 'space-y-3 p-3 sm:p-3' }"
          >
            <template #header>
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-semibold text-highlighted">{{ t('handoff.exported.title') }}</span>
                <UBadge
                  :color="exportedReady ? 'success' : 'neutral'"
                  variant="subtle"
                  size="xs"
                >
                  {{ exportedReady ? t('handoff.readiness.ready') : t('handoff.readiness.notReady') }}
                </UBadge>
              </div>
              <p
                v-if="exportedResult.manifest?.exportedAt"
                class="mt-0.5 text-xs text-muted"
              >
                {{ t('handoff.exported.at', { time: fmt.dateTime(exportedResult.manifest.exportedAt) }) }}
              </p>
            </template>

            <div class="space-y-2 text-xs">
              <div>
                <span class="text-muted">{{ t('handoff.exported.bundleIdentity') }}</span>
                <div class="mt-0.5 flex items-center justify-between gap-1 rounded border border-default bg-default p-1.5">
                  <span class="truncate font-mono">{{ exportedResult.bundleIdentity }}</span>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-copy"
                    :aria-label="t('handoff.exported.copyBundleIdentity')"
                    @click="copyText(exportedResult.bundleIdentity || '')"
                  />
                </div>
              </div>

              <div>
                <span class="text-muted">{{ t('handoff.exported.manifestDigest') }}</span>
                <div class="mt-0.5 flex items-center justify-between gap-1 rounded border border-default bg-default p-1.5">
                  <span class="truncate font-mono">{{ exportedResult.manifestArtifactDigest }}</span>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-copy"
                    :aria-label="t('handoff.exported.copyManifestDigest')"
                    @click="copyText(exportedResult.manifestArtifactDigest || '')"
                  />
                </div>
              </div>
            </div>

            <UButton
              size="xs"
              color="primary"
              variant="solid"
              icon="i-lucide-download"
              block
              :disabled="!exportedResult.manifest"
              @click="downloadManifest"
            >
              {{ t('handoff.exported.download') }}
            </UButton>
          </UCard>
        </div>
      </template>
    </div>
  </div>
</template>
