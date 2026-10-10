<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import type { HandoffRoot } from '../../../src/domain/handoff/schema'
import { useReadiness, type ExportOutcome } from '../../composables/useReadiness'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { copyText } from '../../utils/copy-text'
import type { FetchErrorDetails } from '../../utils/fetch-error'
import { splitReadinessDiagnostics } from '../../utils/readiness'
import HandoffDiagnosticList from './HandoffDiagnosticList.vue'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'

/**
 * Export handoff (brief f, section 5): explicit roots (the whole Workspace, or chosen Views,
 * UX Flows and Assets), the readiness assessment of exactly those roots, then a snapshot. A
 * snapshot that is not `implementation-ready` is labelled a diagnostic snapshot and is never
 * shown in success green (R9 acceptance 3). Viewers can assess; exporting needs Editor.
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
	/** Roots to start from; a View's Readiness tab passes that View. */
	initialRoots?: readonly HandoffRoot[]
}>()

const { t } = useI18n()
const workbench = useWorkbench()
const { views, flows, authorReadOnly } = workbench
const readiness = useReadiness()
const uiux = useUiuxClient()
const feedback = useWorkbenchFeedback()

const mode = ref<'workspace' | 'selected'>('workspace')
const selected = ref<string[]>([])
const assets = shallowRef<readonly Readonly<{ key: string; summary: { name?: string } }>[]>([])
const exporting = ref(false)
const result = shallowRef<ExportOutcome>()
const exportError = shallowRef<FetchErrorDetails>()

const modeItems = computed(() => [
	{ label: t('handoff.roots.workspace'), value: 'workspace' as const },
	{ label: t('handoff.roots.selected'), value: 'selected' as const },
])

type RootOption = Readonly<{ label: string; value: string; icon: string }>
const rootOptions = computed<RootOption[][]>(() => {
	const groups: RootOption[][] = [
		views.value.map(view => ({ label: view.summary.name || t('common.unnamed'), value: `view:${view.key}`, icon: 'i-lucide-app-window' })),
		flows.value.map(flow => ({ label: flow.summary.name || t('common.unnamed'), value: `flow:${flow.key}`, icon: 'i-lucide-workflow' })),
		assets.value.map(asset => ({ label: asset.summary.name || t('common.unnamed'), value: `asset:${asset.key}`, icon: 'i-lucide-image' })),
	]
	return groups.filter(group => group.length)
})

const roots = computed<HandoffRoot[]>(() => {
	if (mode.value === 'workspace') return [{ type: 'workspace' }]
	return selected.value.map((value) => {
		const [kind, id] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)]
		if (kind === 'view') return { type: 'view', viewId: id }
		if (kind === 'flow') return { type: 'flow', flowId: id }
		return { type: 'asset', assetId: id }
	})
})

const entry = computed(() => roots.value.length ? readiness.assessmentFor(roots.value) : undefined)
const split = computed(() => splitReadinessDiagnostics(entry.value?.readiness?.blockingDiagnostics))
const ready = computed(() => entry.value?.status === 'ok' && entry.value.readiness?.implementationReady === true)
const canExport = computed(() => !authorReadOnly.value)
const exportedReady = computed(() => result.value?.readiness?.implementationReady === true && (result.value.manifest?.resources.length ?? 0) > 0)

function seed(): void {
	result.value = undefined
	exportError.value = undefined
	const initial = props.initialRoots ?? []
	if (!initial.length || initial.some(root => root.type === 'workspace')) {
		mode.value = 'workspace'
		selected.value = []
		return
	}
	mode.value = 'selected'
	selected.value = initial.map(root => root.type === 'view' ? `view:${root.viewId}` : root.type === 'flow' ? `flow:${root.flowId}` : root.type === 'asset' ? `asset:${root.assetId}` : '').filter(Boolean)
}

async function loadAssets(): Promise<void> {
	try {
		const page = await uiux.listResources<{ key: string; summary: { name?: string } }>(['asset'], { limit: 100 })
		assets.value = page.items
	}
	catch { assets.value = [] }
}

watch(open, (isOpen) => {
	if (!isOpen) return
	seed()
	void loadAssets()
}, { immediate: true })

// Assess whenever the roots change while the dialog is open.
watch([open, roots, readiness.signature], ([isOpen]) => {
	if (!isOpen || !roots.value.length) return
	if (readiness.isOutdated(readiness.assessmentFor(roots.value))) void readiness.assess(roots.value)
}, { immediate: true, deep: true })

async function runExport(): Promise<void> {
	if (!canExport.value || !roots.value.length || exporting.value) return
	exporting.value = true
	exportError.value = undefined
	try {
		const outcome = await readiness.exportHandoff(roots.value)
		if (outcome.status === 'exported') {
			result.value = outcome
			feedback.success(t('handoff.exported'))
		}
		else {
			exportError.value = outcome.error
		}
	}
	finally {
		exporting.value = false
	}
}

async function copy(value: string | undefined): Promise<void> {
	if (!value) return
	if (await copyText(value)) feedback.success(t('handoff.copied'))
	else feedback.error(undefined, t('handoff.copyFailed'))
}

function downloadManifest(): void {
	const manifest = result.value?.manifest
	if (!manifest) return
	const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }))
	const link = document.createElement('a')
	link.href = url
	link.download = `handoff-${(result.value?.bundleIdentity ?? 'manifest').replace(/^sha256:/, '').slice(0, 16)}.json`
	link.click()
	URL.revokeObjectURL(url)
}

function middle(value: string | undefined): string {
	if (!value) return ''
	const bare = value.replace(/^sha256:/, '')
	return bare.length > 20 ? `${bare.slice(0, 10)}…${bare.slice(-6)}` : bare
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="result ? t('handoff.exported') : t('handoff.title')"
    :description="result ? undefined : t('handoff.description')"
    :ui="{ content: 'sm:max-w-xl', body: 'space-y-5' }"
  >
    <template #body>
      <div
        v-if="result"
        class="space-y-4"
        data-handoff-result
      >
        <div class="flex flex-wrap items-center gap-2">
          <UBadge
            v-if="exportedReady"
            color="success"
            variant="subtle"
            icon="i-lucide-badge-check"
            data-handoff-claim="ready"
            translate="no"
          >
            implementation-ready
          </UBadge>
          <UBadge
            v-else
            color="neutral"
            variant="subtle"
            icon="i-lucide-file-search"
            data-handoff-claim="diagnostic"
          >
            {{ t('handoff.diagnostic') }}
          </UBadge>
          <span class="text-sm text-muted">{{ exportedReady ? t('handoff.result.readyNote') : t('handoff.result.diagnosticNote') }}</span>
        </div>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm">
          <dt class="text-muted">
            {{ t('handoff.result.bundle') }}
          </dt>
          <dd class="truncate font-mono text-xs text-highlighted">
            {{ middle(result.bundleIdentity) }}
          </dd>
          <dd>
            <UButton
              size="xs"
              variant="ghost"
              icon="i-lucide-copy"
              :aria-label="t('handoff.result.copyBundle')"
              @click="copy(result.bundleIdentity)"
            />
          </dd>
          <dt class="text-muted">
            {{ t('handoff.result.manifest') }}
          </dt>
          <dd class="truncate font-mono text-xs text-highlighted">
            {{ middle(result.manifestArtifactDigest) }}
          </dd>
          <dd>
            <UButton
              size="xs"
              variant="ghost"
              icon="i-lucide-copy"
              :aria-label="t('handoff.result.copyManifest')"
              @click="copy(result.manifestArtifactDigest)"
            />
          </dd>
        </dl>
      </div>

      <template v-else>
        <UAlert
          v-if="exportError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="t('handoff.exportFailed')"
          role="alert"
          data-handoff-export-error
        >
          <template #description>
            <WbErrorDescription
              :headline="t('handoff.exportFailed')"
              :lead="exportError.message"
              :diagnostics="exportError.diagnostics"
              :status-code="exportError.statusCode"
            />
          </template>
        </UAlert>
        <URadioGroup
          v-model="mode"
          :legend="t('handoff.roots.legend')"
          :items="modeItems"
          orientation="horizontal"
          :ui="{ legend: 'text-sm font-medium text-highlighted mb-2' }"
        />
        <UFormField
          v-if="mode === 'selected'"
          :label="t('handoff.roots.pick')"
          :error="selected.length ? undefined : t('handoff.roots.none')"
        >
          <USelectMenu
            v-model="selected"
            :items="rootOptions"
            value-key="value"
            multiple
            :placeholder="t('handoff.roots.placeholder')"
            :search-input="{ placeholder: t('handoff.roots.search') }"
            class="w-full"
            data-handoff-roots
          />
        </UFormField>

        <section
          :aria-label="t('handoff.assessment')"
          aria-live="polite"
          class="space-y-3"
          data-handoff-assessment
        >
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-title font-semibold text-highlighted">
              {{ t('handoff.assessment') }}
            </h3>
            <UButton
              size="xs"
              variant="ghost"
              icon="i-lucide-refresh-cw"
              :loading="entry?.status === 'loading'"
              :disabled="!roots.length"
              @click="readiness.assess(roots, { force: true })"
            >
              {{ t('ready.recheck') }}
            </UButton>
          </div>

          <div
            v-if="!entry || entry.status === 'loading' && !entry.readiness"
            class="space-y-2"
          >
            <USkeleton
              class="h-5 w-48"
              :aria-label="t('common.loading')"
            />
            <USkeleton
              class="h-4 w-full"
              :aria-label="t('common.loading')"
            />
            <USkeleton
              class="h-4 w-2/3"
              :aria-label="t('common.loading')"
            />
          </div>

          <UAlert
            v-else-if="entry.status === 'failed'"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="t('handoff.assessFailed')"
          >
            <template
              v-if="entry.error"
              #description
            >
              <WbErrorDescription
                :headline="t('handoff.assessFailed')"
                :lead="entry.error.message"
                :diagnostics="entry.error.diagnostics"
                :status-code="entry.error.statusCode"
              />
            </template>
          </UAlert>

          <template v-else>
            <p
              class="flex items-center gap-2 text-sm font-medium"
              :class="ready ? 'text-success' : 'text-warning'"
              data-handoff-state
              :data-ready="ready"
            >
              <UIcon
                :name="ready ? 'i-lucide-badge-check' : 'i-lucide-triangle-alert'"
                class="size-4"
              />
              {{ ready ? 'implementation-ready' : t('ready.notReady') }}
            </p>
            <div
              v-if="split.blocking.length"
              class="space-y-1.5"
            >
              <h4 class="text-xs font-medium text-muted">
                {{ t('ready.blockingTitle', split.blocking.length) }}
              </h4>
              <HandoffDiagnosticList
                :diagnostics="split.blocking"
                tone="blocking"
              />
            </div>
            <div
              v-if="split.advisory.length"
              class="space-y-1.5"
            >
              <h4 class="text-xs font-medium text-muted">
                {{ t('ready.advisoryTitle', split.advisory.length) }}
              </h4>
              <HandoffDiagnosticList
                :diagnostics="split.advisory"
                tone="advisory"
              />
            </div>
            <p
              v-if="!ready && canExport"
              class="text-sm text-muted"
            >
              {{ t('handoff.diagnosticNote') }}
            </p>
          </template>
        </section>
      </template>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-end gap-2">
        <p
          v-if="!canExport && !result"
          class="me-auto flex items-center gap-1.5 text-sm text-muted"
          data-access-notice
        >
          <UIcon
            name="i-lucide-user-lock"
            class="size-4"
          />
          {{ t('access.requiresRole', { role: t('access.role.editor') }) }}
        </p>
        <template v-if="result">
          <UButton
            icon="i-lucide-download"
            :disabled="!result.manifest"
            @click="downloadManifest"
          >
            {{ t('handoff.result.download') }}
          </UButton>
          <UButton
            color="primary"
            variant="solid"
            @click="open = false"
          >
            {{ t('common.close') }}
          </UButton>
        </template>
        <template v-else>
          <UButton @click="open = false">
            {{ canExport ? t('common.cancel') : t('common.close') }}
          </UButton>
          <UButton
            v-if="canExport"
            color="primary"
            variant="solid"
            icon="i-lucide-package"
            :loading="exporting"
            :disabled="!roots.length || entry?.status !== 'ok'"
            data-handoff-export
            @click="runExport"
          >
            {{ ready ? t('handoff.exportReady') : t('handoff.exportSnapshot') }}
          </UButton>
        </template>
      </div>
    </template>
  </UModal>
</template>
