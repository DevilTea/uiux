<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useUiuxClient } from '../composables/useUiuxClient'
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

const emit = defineEmits<{
	(e: 'applyContext', context: {
		viewId: string
		variantName?: string
		locale: string
		viewportId: string
		themeId: string
	}): void
	(e: 'refresh'): void
}>()

const evidenceItems = shallowRef<readonly FormalEvidenceItem[]>([])
const loading = ref(false)
const capturing = ref(false)
const captureMessage = ref<string>()
const filterCurrentView = ref(false)
const selectedEvidenceDigest = ref<string>()
const modalImageUrl = ref<string>()

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

const selectedItemContext = computed(() => {
	if (!selectedItem.value) return undefined
	const ctx = selectedItem.value.record.executionContext as Record<string, unknown>
	const vp = ctx?.viewport as { width?: number; height?: number } | undefined
	return {
		viewId: String(ctx?.viewId ?? ''),
		variantName: ctx?.variantName ? String(ctx.variantName) : '(base)',
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

function copyText(text: string) {
	void navigator.clipboard?.writeText(text)
}

function artifactUrl(digest: string): string {
	return uiux.artifactUrl(digest)
}

async function loadEvidence() {
	loading.value = true
	try {
		const items = await uiux.listEvidence<FormalEvidenceItem>()
		evidenceItems.value = items || []
		if (!selectedEvidenceDigest.value && evidenceItems.value.length > 0) {
			selectedEvidenceDigest.value = evidenceItems.value[0]?.digest
		}
	}
	catch {
		evidenceItems.value = []
	}
	finally {
		loading.value = false
	}
}

async function captureCurrentContext() {
	if (props.readOnly) return
	if (!props.activeContext || !props.activeContext.viewId) return
	capturing.value = true
	captureMessage.value = undefined
	try {
		const res = await $fetch<{
			status: string
			results: Array<{ status: string; evidenceDigest?: string; error?: string }>
		}>('/api/evidence/capture', {
			method: 'POST',
			body: {
				contexts: [props.activeContext],
			},
		})
		if (res.status === 'ok') {
			captureMessage.value = 'Capture completed successfully.'
			await loadEvidence()
			if (res.results[0]?.evidenceDigest) {
				selectedEvidenceDigest.value = res.results[0].evidenceDigest
			}
			emit('refresh')
		}
		else {
			captureMessage.value = `Capture reported status: ${res.status}. ${res.results[0]?.error || ''}`
		}
	}
	catch (cause) {
		captureMessage.value = cause instanceof Error ? cause.message : 'Capture failed'
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
  <div class="flex h-full flex-col overflow-hidden bg-neutral-950 text-neutral-200">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-neutral-800 p-3 shrink-0">
      <div>
        <h2 class="text-xs font-semibold uppercase tracking-wider text-neutral-300">
          Formal Evidence
        </h2>
        <p class="text-[11px] text-neutral-500">
          Deterministic screenshot artifacts & formal execution records
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          :loading="loading"
          @click="loadEvidence"
        >
          Refresh
        </UButton>
        <UButton
          v-if="!readOnly"
          size="xs"
          color="primary"
          :loading="capturing"
          :disabled="!activeContext"
          @click="captureCurrentContext"
        >
          Capture Active
        </UButton>
      </div>
    </div>

    <!-- Active Capture Notification -->
    <div
      v-if="captureMessage"
      class="border-b border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-primary"
    >
      {{ captureMessage }}
    </div>

    <!-- Filter Toggle -->
    <div class="flex items-center justify-between border-b border-neutral-800/60 px-3 py-2 text-xs shrink-0">
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1.5 cursor-pointer text-neutral-400 hover:text-neutral-200">
          <input
            v-model="filterCurrentView"
            type="checkbox"
            class="rounded border-neutral-700 bg-neutral-900 text-primary"
          >
          <span>Only current view</span>
        </label>
      </div>
      <span class="text-[11px] text-neutral-500">{{ filteredItems.length }} records</span>
    </div>

    <!-- Sidebar-friendly single-column list + detail flow -->
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-2">
      <!-- Evidence List -->
      <div class="max-h-72 space-y-1.5 overflow-y-auto">
        <div
          v-if="filteredItems.length === 0"
          class="py-8 text-center text-xs text-neutral-500"
        >
          {{ readOnly ? 'No formal evidence was included in this published snapshot.' : 'No formal evidence captured yet. Click "Capture Active" to record deterministic evidence for the current render context.' }}
        </div>

        <button
          v-for="item in filteredItems"
          :key="item.digest"
          type="button"
          class="w-full rounded border p-2 text-left text-xs transition space-y-1"
          :class="[
            selectedItem?.digest === item.digest
              ? 'border-primary/50 bg-primary/10 text-white'
              : 'border-neutral-800/80 bg-neutral-900/60 text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900',
          ]"
          @click="selectedEvidenceDigest = item.digest"
        >
          <div class="flex items-center justify-between">
            <span class="font-mono text-[11px] font-semibold text-primary-400">{{ shortHash(item.digest) }}</span>
            <UBadge
              :color="checkStaleness(item.record).isStale ? 'warning' : 'success'"
              variant="subtle"
              size="xs"
            >
              {{ checkStaleness(item.record).isStale ? 'Stale / Missing' : 'Verified' }}
            </UBadge>
          </div>

          <!-- Context summary -->
          <div class="text-[11px] text-neutral-400 flex flex-wrap gap-x-2 gap-y-0.5">
            <span>View: <code class="text-neutral-300">{{ String((item.record.executionContext as Record<string, unknown>)?.viewId || '').slice(0, 8) }}…</code></span>
            <span>Locale: <code class="text-neutral-300">{{ String((item.record.executionContext as Record<string, unknown>)?.locale || '') }}</code></span>
            <span>Theme: <code class="text-neutral-300">{{ String((item.record.executionContext as Record<string, unknown>)?.themeId || '') }}</code></span>
          </div>
        </button>
      </div>

      <!-- Evidence Detail & Inspector -->
      <div
        v-if="selectedItem"
        class="min-w-0 space-y-4 rounded border border-neutral-800 bg-neutral-950/40 p-3"
      >
        <!-- Identity Section -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-neutral-400">Evidence Identity</span>
            <button
              type="button"
              class="text-[11px] text-primary hover:underline"
              @click="copyText(selectedItem.digest)"
            >
              Copy SHA-256
            </button>
          </div>
          <p class="rounded bg-black/40 p-2 font-mono text-[11px] break-all border border-neutral-800">
            {{ selectedItem.digest }}
          </p>
        </div>

        <!-- Staleness Warning -->
        <div
          v-if="checkStaleness(selectedItem.record).isStale"
          class="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300"
        >
          <span class="font-semibold">Notice:</span> {{ checkStaleness(selectedItem.record).reason }}
        </div>

        <!-- Screenshot Preview -->
        <div
          v-if="selectedItem.record.artifactRefs.length > 0"
          class="space-y-1.5"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-neutral-400">Screenshot Artifact</span>
            <span class="font-mono text-[10px] text-neutral-500">{{ shortHash(selectedItem.record.artifactRefs[0]!) }}</span>
          </div>
          <div class="rounded border border-neutral-800 bg-black/60 p-2 flex justify-center">
            <img
              :src="artifactUrl(selectedItem.record.artifactRefs[0]!)"
              alt="Formal Capture Screenshot"
              class="max-h-48 rounded object-contain cursor-pointer hover:opacity-90 transition"
              @click="modalImageUrl = artifactUrl(selectedItem.record.artifactRefs[0]!)"
            >
          </div>
        </div>

        <!-- Render Context Info -->
        <div class="space-y-1.5 text-xs">
          <span class="font-semibold text-neutral-400">Render Context</span>
          <div
            v-if="selectedItemContext"
            class="rounded border border-neutral-800 bg-neutral-900/50 p-2 space-y-1 font-mono text-[11px]"
          >
            <div>
              View ID: <span class="break-all text-neutral-200">{{ selectedItemContext.viewId }}</span>
            </div>
            <div>
              Variant: <span class="text-neutral-200">{{ selectedItemContext.variantName }}</span>
            </div>
            <div>
              Locale: <span class="text-neutral-200">{{ selectedItemContext.locale }}</span>
            </div>
            <div>
              Viewport: <span class="text-neutral-200">{{ selectedItemContext.viewportId }} ({{ selectedItemContext.viewportWidth }}×{{ selectedItemContext.viewportHeight }})</span>
            </div>
            <div>
              Theme: <span class="text-neutral-200">{{ selectedItemContext.themeId }}</span>
            </div>
          </div>
        </div>

        <!-- Provenance Revisions -->
        <div class="space-y-1.5 text-xs">
          <span class="font-semibold text-neutral-400">Provenance Revisions</span>
          <div class="rounded border border-neutral-800 bg-neutral-900/50 p-2 space-y-1 font-mono text-[11px]">
            <div>
              UIUX Version: <span class="text-neutral-200">{{ selectedItem.record.provenance.versions?.uiux || 'unknown' }}</span>
            </div>
            <div>
              Schema Version: <span class="text-neutral-200">{{ selectedItem.record.provenance.workspaceSchemaVersion }}</span>
            </div>
            <div class="pt-1 text-neutral-400">
              Resources:
            </div>
            <ul class="pl-2 space-y-0.5">
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
        <div class="pt-2">
          <UButton
            size="sm"
            color="primary"
            variant="soft"
            class="w-full"
            @click="applyItemContext(selectedItem.record)"
          >
            Apply Context to Preview
          </UButton>
        </div>
      </div>
      <div
        v-else
        class="rounded border border-neutral-800 p-6 text-center text-xs text-neutral-500"
      >
        Select an evidence record to inspect.
      </div>
    </div>

    <!-- Enlarged Image Modal -->
    <div
      v-if="modalImageUrl"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      @click="modalImageUrl = undefined"
    >
      <div
        class="relative max-h-full max-w-full overflow-auto rounded bg-neutral-900 p-2"
        @click.stop
      >
        <button
          type="button"
          class="absolute top-2 right-2 rounded bg-black/60 px-2 py-1 text-xs text-white"
          @click="modalImageUrl = undefined"
        >
          ✕ Close
        </button>
        <img
          :src="modalImageUrl"
          alt="Enlarged Screenshot"
          class="max-h-[85vh] max-w-[85vw] object-contain rounded"
        >
      </div>
    </div>
  </div>
</template>
