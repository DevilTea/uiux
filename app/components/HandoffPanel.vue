<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useUiuxClient } from '../composables/useUiuxClient'
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

const props = defineProps<{
	readOnly?: boolean
	views: readonly ViewSummary[]
}>()

const uiux = useUiuxClient()

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
const errorMessage = ref<string>()

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

async function loadFlowsAndAssets() {
	try {
		const [flowRes, assetRes] = await Promise.all([
			uiux.listResources<FlowSummary>(['flow'], { limit: 100 }).catch(() => ({ items: [] })),
			uiux.listResources<AssetSummary>(['asset'], { limit: 100 }).catch(() => ({ items: [] })),
		])
		availableFlows.value = flowRes.items || []
		availableAssets.value = assetRes.items || []
	}
	catch {
		// ignore
	}
}

async function runAssessment() {
	if (computedRoots.value.length === 0) {
		readiness.value = undefined
		assessment.value = undefined
		return
	}
	assessing.value = true
	errorMessage.value = undefined
	try {
		const res = await uiux.assessHandoff<{
			status: string
			readiness?: HandoffReadiness
			assessment?: HandoffReadinessAssessment
			diagnostics?: Array<{ code: string; message: string }>
		}>(computedRoots.value)
		if (res.status === 'ok') {
			readiness.value = res.readiness
			assessment.value = res.assessment
		}
		else {
			errorMessage.value = res.diagnostics?.map(d => d.message).join('; ') || 'Assessment failed'
		}
	}
	catch (cause) {
		errorMessage.value = cause instanceof Error ? cause.message : 'Readiness assessment failed'
	}
	finally {
		assessing.value = false
	}
}

async function runExport() {
	if (props.readOnly || computedRoots.value.length === 0) return
	exporting.value = true
	errorMessage.value = undefined
	try {
		const res = await $fetch<{
			status: string
			manifest?: HandoffManifest
			manifestArtifactDigest?: string
			bundleIdentity?: string
			readiness?: HandoffReadiness
			diagnostics?: Array<{ code: string; message: string }>
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
		}
		else {
			errorMessage.value = res.diagnostics?.map(d => d.message).join('; ') || 'Export failed'
		}
	}
	catch (cause) {
		errorMessage.value = cause instanceof Error ? cause.message : 'Handoff export failed'
	}
	finally {
		exporting.value = false
	}
}

function copyText(text: string) {
	void navigator.clipboard?.writeText(text)
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

onMounted(async () => {
	await loadFlowsAndAssets()
	await runAssessment()
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-neutral-950 text-neutral-200">
    <!-- Header -->
    <div class="flex shrink-0 flex-col gap-2 border-b border-neutral-800 p-3">
      <div>
        <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-300">
          Handoff & Closure
        </h2>
        <p class="text-[11px] text-neutral-500">
          Deterministic dependency closure, readiness claim & immutable export
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
          :loading="assessing"
          class="justify-center"
          @click="runAssessment"
        >
          Re-Assess
        </UButton>
        <UButton
          size="xs"
          color="primary"
          :loading="exporting"
          :disabled="computedRoots.length === 0"
          class="justify-center"
          @click="runExport"
        >
          Export Snapshot
        </UButton>
      </div>
    </div>

    <!-- Error message if any -->
    <div
      v-if="errorMessage"
      class="border-b border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300"
    >
      {{ errorMessage }}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div
        v-if="readOnly"
        class="border-b border-violet-500/20 bg-violet-500/10 p-3 text-[11px] text-violet-200"
      >
        Published Workspace readiness · precomputed from the canonical snapshot at publish time.
      </div>
      <!-- Left: Root Picker -->
      <div
        v-if="!readOnly"
        class="space-y-4 border-b border-neutral-800 p-3"
      >
        <!-- Root Boundary Selection Mode -->
        <div class="space-y-2">
          <span class="text-xs font-semibold text-neutral-400">Export Scope Roots</span>
          <div class="flex items-center gap-4 text-xs">
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input
                v-model="rootMode"
                type="radio"
                value="workspace"
                class="text-primary"
              >
              <span>Full Workspace</span>
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input
                v-model="rootMode"
                type="radio"
                value="custom"
                class="text-primary"
              >
              <span>Selected Roots</span>
            </label>
          </div>
        </div>

        <!-- Custom Roots Selector -->
        <div
          v-if="rootMode === 'custom'"
          class="space-y-3"
        >
          <!-- Views Selection -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-neutral-300">Views</span>
              <span class="text-[10px] text-neutral-500">{{ selectedViewIds.length }} selected</span>
            </div>
            <div class="max-h-36 overflow-y-auto rounded border border-neutral-800 bg-neutral-900/50 p-2 space-y-1">
              <label
                v-for="v in views"
                :key="v.key"
                class="flex items-center gap-2 text-xs text-neutral-300 hover:text-white cursor-pointer"
              >
                <input
                  v-model="selectedViewIds"
                  type="checkbox"
                  :value="v.key"
                  class="rounded text-primary"
                >
                <span class="truncate">{{ v.summary.name || v.key }}</span>
              </label>
            </div>
          </div>

          <!-- Flows Selection -->
          <div
            v-if="availableFlows.length > 0"
            class="space-y-1.5"
          >
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-neutral-300">UX Flows</span>
              <span class="text-[10px] text-neutral-500">{{ selectedFlowIds.length }} selected</span>
            </div>
            <div class="max-h-28 overflow-y-auto rounded border border-neutral-800 bg-neutral-900/50 p-2 space-y-1">
              <label
                v-for="f in availableFlows"
                :key="f.key"
                class="flex items-center gap-2 text-xs text-neutral-300 hover:text-white cursor-pointer"
              >
                <input
                  v-model="selectedFlowIds"
                  type="checkbox"
                  :value="f.key"
                  class="rounded text-primary"
                >
                <span class="truncate">{{ f.summary.name || f.key }}</span>
              </label>
            </div>
          </div>

          <!-- Assets Selection -->
          <div
            v-if="availableAssets.length > 0"
            class="space-y-1.5"
          >
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-neutral-300">Assets</span>
              <span class="text-[10px] text-neutral-500">{{ selectedAssetIds.length }} selected</span>
            </div>
            <div class="max-h-28 overflow-y-auto rounded border border-neutral-800 bg-neutral-900/50 p-2 space-y-1">
              <label
                v-for="a in availableAssets"
                :key="a.key"
                class="flex items-center gap-2 text-xs text-neutral-300 hover:text-white cursor-pointer"
              >
                <input
                  v-model="selectedAssetIds"
                  type="checkbox"
                  :value="a.key"
                  class="rounded text-primary"
                >
                <span class="truncate">{{ a.summary.name || a.key }}</span>
              </label>
            </div>
          </div>
        </div>

        <div class="text-[11px] text-neutral-500 border-t border-neutral-800/60 pt-3">
          Transitive canonical dependencies (referenced Assets, default Locale, flow target Views, and required Adapters) are automatically resolved into the closure.
        </div>
      </div>

      <!-- Right: Readiness & Export Outcome -->
      <div class="space-y-4 p-3">
        <!-- Readiness Assessment Banner -->
        <div
          v-if="readiness"
          class="rounded border p-3 space-y-2"
          :class="[
            readiness.implementationReady
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-200',
          ]"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider">
              {{ readiness.implementationReady ? 'Implementation Ready' : 'Draft / Not Ready' }}
            </span>
            <UBadge
              :color="readiness.implementationReady ? 'success' : 'warning'"
              variant="subtle"
              size="xs"
            >
              {{ readiness.implementationReady ? 'Claim Verified' : 'Unsubstantiated' }}
            </UBadge>
          </div>
          <p class="text-xs leading-relaxed">
            {{ readiness.implementationReady
              ? 'All roots are readable, closure is valid, required formal evidence is complete, and review coverage has no unresolved threads.'
              : 'A coherent snapshot may still be exported for inspection, but implementation-ready claims cannot be made due to blocking diagnostics.'
            }}
          </p>

          <!-- Coverage Checklist -->
          <div class="grid grid-cols-3 gap-2 pt-2 text-[11px] font-mono">
            <div class="rounded bg-black/20 p-1.5 text-center">
              <div>Validation</div>
              <div :class="assessment?.closureValid ? 'text-emerald-400' : 'text-red-400'">
                {{ assessment?.closureValid ? 'Passed' : 'Issues' }}
              </div>
            </div>
            <div class="rounded bg-black/20 p-1.5 text-center">
              <div>Evidence</div>
              <div :class="assessment?.requiredEvidenceComplete ? 'text-emerald-400' : 'text-amber-400'">
                {{ assessment?.requiredEvidenceComplete ? 'Complete' : 'Missing' }}
              </div>
            </div>
            <div class="rounded bg-black/20 p-1.5 text-center">
              <div>Reviews</div>
              <div :class="assessment?.reviewCoverageComplete ? 'text-emerald-400' : 'text-amber-400'">
                {{ assessment?.reviewCoverageComplete ? 'Resolved' : 'Open' }}
              </div>
            </div>
          </div>
        </div>

        <!-- Blocking Diagnostics -->
        <div
          v-if="readiness?.blockingDiagnostics && readiness.blockingDiagnostics.length > 0"
          class="space-y-1.5"
        >
          <span class="text-xs font-semibold text-neutral-400">Blocking Diagnostics ({{ readiness.blockingDiagnostics.length }})</span>
          <ul class="max-h-40 overflow-y-auto space-y-1 text-xs">
            <li
              v-for="(diag, idx) in readiness.blockingDiagnostics"
              :key="idx"
              class="rounded border border-red-500/30 bg-red-500/10 p-2 text-red-300 font-mono text-[11px]"
            >
              <div class="font-semibold text-red-200">
                [{{ diag.code }}]
              </div>
              <div>
                {{ diag.message }}
              </div>
              <div
                v-if="diag.path"
                class="text-[10px] text-neutral-400"
              >
                Path: {{ diag.path }}
              </div>
            </li>
          </ul>
        </div>

        <!-- Exported Snapshot Card -->
        <div
          v-if="exportedResult"
          class="rounded border border-primary/40 bg-primary/10 p-3 space-y-3"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-primary-300">Exported Handoff Bundle</span>
            <UBadge
              :color="exportedResult.readiness?.implementationReady ? 'success' : 'neutral'"
              size="xs"
            >
              {{ exportedResult.readiness?.implementationReady ? 'implementationReady: true' : 'implementationReady: false' }}
            </UBadge>
          </div>

          <div class="space-y-1.5 text-xs font-mono text-[11px]">
            <div>
              <span class="text-neutral-400">Bundle Identity:</span>
              <div class="flex items-center justify-between rounded bg-black/40 p-1.5 mt-0.5 border border-neutral-800">
                <span class="truncate">{{ exportedResult.bundleIdentity }}</span>
                <button
                  type="button"
                  class="ml-2 text-primary hover:underline shrink-0"
                  @click="copyText(exportedResult.bundleIdentity || '')"
                >
                  Copy
                </button>
              </div>
            </div>

            <div>
              <span class="text-neutral-400">Manifest Artifact Digest:</span>
              <div class="flex items-center justify-between rounded bg-black/40 p-1.5 mt-0.5 border border-neutral-800">
                <span class="truncate">{{ exportedResult.manifestArtifactDigest }}</span>
                <button
                  type="button"
                  class="ml-2 text-primary hover:underline shrink-0"
                  @click="copyText(exportedResult.manifestArtifactDigest || '')"
                >
                  Copy
                </button>
              </div>
            </div>
          </div>

          <UButton
            size="xs"
            color="primary"
            variant="solid"
            class="w-full justify-center"
            @click="downloadManifest"
          >
            Download Manifest JSON
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>
