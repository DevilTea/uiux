<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n, useToast } from '#imports'
import { isPortableAdapterModuleSpecifier } from '../../../src/domain/workspace/schema'
import type { Diagnostic } from '../../composables/workbench-types'
import type { SettingsSection } from '../../composables/useSettingsSection'
import {
	adapterIndexOf,
	adapterRepair,
	moveItem,
	nextRowUid,
	parseAdapterConfig,
	type AdapterRepair,
	type AdapterRow,
} from '../../utils/workspace-authoring'
import AuthoringConflictAlert from './AuthoringConflictAlert.vue'
import AuthoringErrorAlert from './AuthoringErrorAlert.vue'
import AuthoringSaveBar from './AuthoringSaveBar.vue'

/** What `/api/preview/adapters` reports about the saved Adapter set. */
export type AdapterResolution = Readonly<{
	state: 'valid' | 'invalid'
	diagnostics: readonly Diagnostic[]
	summaries: readonly Readonly<{
		index: number
		moduleSpecifier: string
		adapterId?: string
		apiVersion?: string
		resolvedModule?: Readonly<{ packageName?: string; packageVersion?: string }>
	}>[]
}>

/**
 * Adapters (brief g): the ordered selection, read-only package state per Adapter, and repair
 * guidance for an invalid set. The Workbench never runs a package manager (Part 8 10a); it
 * prints the command to run. Order is changed by dragging or with the Move up / Move down buttons.
 */
const props = defineProps<{
	section: SettingsSection<AdapterRow[]>
	canEdit: boolean
	resolution?: AdapterResolution
	resolutionFailed?: boolean
}>()
const emit = defineEmits<{ save: []; discard: []; reload: []; keepMine: []; retryResolution: [] }>()
const { t } = useI18n()
const toast = useToast()

const rows = computed<AdapterRow[]>(() => props.section.draft ?? [])
const showIssues = ref(false)

function specifierError(row: AdapterRow): string | undefined {
	if (!showIssues.value && row.savedIndex !== undefined) return undefined
	const value = row.moduleSpecifier.trim()
	if (!value) return showIssues.value ? t('adapters.validation.required') : undefined
	return isPortableAdapterModuleSpecifier(value) ? undefined : t('adapters.validation.specifier')
}

function configError(row: AdapterRow): string | undefined {
	return parseAdapterConfig(row.configText).ok ? undefined : t('adapters.validation.json')
}

const hasIssues = computed(() => rows.value.some(row => !isPortableAdapterModuleSpecifier(row.moduleSpecifier.trim()) || !parseAdapterConfig(row.configText).ok))

/** Diagnostics of the saved set that belong to one saved Adapter. */
function rowDiagnostics(row: AdapterRow): readonly Diagnostic[] {
	if (row.savedIndex === undefined || !props.resolution) return []
	return props.resolution.diagnostics.filter(item => adapterIndexOf(item.path) === row.savedIndex)
}

function summaryOf(row: AdapterRow) {
	if (row.savedIndex === undefined) return undefined
	return props.resolution?.summaries.find(item => item.index === row.savedIndex)
}

type RowStatus = 'loaded' | 'failed' | 'unsaved' | 'unknown'
function statusOf(row: AdapterRow): RowStatus {
	if (row.savedIndex === undefined || row.moduleSpecifier.trim() !== summaryOf(row)?.moduleSpecifier) return row.savedIndex === undefined ? 'unsaved' : (props.resolution ? 'unsaved' : 'unknown')
	if (!props.resolution) return 'unknown'
	if (rowDiagnostics(row).length) return 'failed'
	return summaryOf(row)?.adapterId ? 'loaded' : 'unknown'
}

const STATUS = {
	loaded: { color: 'success', icon: 'i-lucide-check', key: 'adapters.status.loaded' },
	failed: { color: 'error', icon: 'i-lucide-circle-alert', key: 'adapters.status.failed' },
	unsaved: { color: 'neutral', icon: 'i-lucide-circle-dashed', key: 'adapters.status.unsaved' },
	unknown: { color: 'neutral', icon: 'i-lucide-circle-help', key: 'adapters.status.unknown' },
} as const

/** Set-level diagnostics that no single Adapter row owns (e.g. registry conflicts). */
const setDiagnostics = computed(() => (props.resolution?.diagnostics ?? []).filter((item) => {
	const index = adapterIndexOf(item.path)
	return index === undefined || !rows.value.some(row => row.savedIndex === index)
}))

const repairs = computed(() => {
	const list: { key: string; repair: AdapterRepair }[] = []
	for (const diagnostic of props.resolution?.diagnostics ?? []) {
		const index = adapterIndexOf(diagnostic.path)
		const summary = props.resolution?.summaries.find(item => item.index === index)
		const repair = summary ? adapterRepair(diagnostic.code, summary.moduleSpecifier) : undefined
		if (!repair) continue
		const key = repair.kind === 'command' ? repair.command : repair.path
		if (!list.some(item => item.key === key)) list.push({ key, repair })
	}
	return list
})

async function copy(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text)
		toast.add({ title: t('adapters.copied'), color: 'success', icon: 'i-lucide-check' })
	}
	catch {
		toast.add({ title: t('adapters.copyFailed'), color: 'error', icon: 'i-lucide-circle-alert' })
	}
}

function add(): void {
	const row: AdapterRow = { uid: nextRowUid(), moduleSpecifier: '', configText: '' }
	props.section.setDraft([...rows.value, row])
	void nextTick(() => document.querySelector<HTMLInputElement>(`[data-adapter-specifier="${row.uid}"]`)?.focus())
}

function remove(row: AdapterRow): void {
	props.section.setDraft(rows.value.filter(item => item.uid !== row.uid))
}

function move(index: number, to: number, focus?: 'up' | 'down'): void {
	if (to < 0 || to >= rows.value.length) return
	const uid = rows.value[index]?.uid
	props.section.setDraft(moveItem(rows.value, index, to))
	if (!focus || !uid) return
	void nextTick(() => {
		const target = document.querySelector<HTMLButtonElement>(`[data-adapter-move="${uid}-${focus}"]:not([disabled])`)
			?? document.querySelector<HTMLButtonElement>(`[data-adapter-move="${uid}-${focus === 'up' ? 'down' : 'up'}"]`)
		target?.focus()
	})
}

// Pointer drag. The Move up / Move down buttons are the keyboard alternative.
const dragFrom = ref<number>()
const dragOver = ref<number>()
function onDragStart(index: number, event: DragEvent): void {
	dragFrom.value = index
	event.dataTransfer?.setData('text/plain', String(index))
	if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onDrop(index: number): void {
	if (dragFrom.value !== undefined) move(dragFrom.value, index)
	dragFrom.value = undefined
	dragOver.value = undefined
}
function onDragEnd(): void {
	dragFrom.value = undefined
	dragOver.value = undefined
}

function save(): void {
	showIssues.value = true
	if (hasIssues.value) {
		void nextTick(() => document.querySelector<HTMLElement>('#settings-adapters [aria-invalid="true"]')?.focus())
		return
	}
	emit('save')
}

function displayName(row: AdapterRow): string {
	return row.moduleSpecifier.trim() || t('adapters.unnamed')
}

defineExpose({ save })
</script>

<template>
  <section
    id="settings-adapters"
    aria-labelledby="settings-adapters-title"
    class="flex scroll-mt-6 flex-col gap-4"
    data-settings-section
  >
    <header class="flex items-start justify-between gap-4">
      <div class="min-w-0 space-y-1">
        <h2
          id="settings-adapters-title"
          tabindex="-1"
          class="text-title font-semibold text-highlighted focus:outline-none"
        >
          {{ t('settings.adapters') }}
        </h2>
        <p class="text-sm text-muted">
          {{ t('adapters.description') }}
        </p>
      </div>
      <UButton
        v-if="canEdit"
        icon="i-lucide-plus"
        class="shrink-0"
        @click="add"
      >
        {{ t('adapters.add') }}
      </UButton>
    </header>

    <AuthoringConflictAlert
      v-if="section.conflict"
      :title="t('settings.conflict')"
      :theirs="section.theirs"
      :yours="section.draftPayload"
      @reload="emit('reload')"
      @keep-mine="emit('keepMine')"
    />
    <AuthoringErrorAlert
      v-else-if="section.error"
      :title="t('settings.saveFailed')"
      :error="section.error"
      @close="section.clearError()"
    />

    <UAlert
      v-if="resolution?.state === 'invalid'"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      role="alert"
      data-adapters-invalid
      :title="t('adapters.invalid')"
    >
      <template #description>
        <ul
          v-if="setDiagnostics.length"
          class="mb-2 space-y-1"
        >
          <li
            v-for="diagnostic in setDiagnostics"
            :key="diagnostic.code + diagnostic.path"
            class="break-words"
          >
            <code class="me-1 font-mono text-xs">{{ diagnostic.path || diagnostic.code }}</code>{{ diagnostic.message }}
          </li>
        </ul>
        <template v-if="repairs.length">
          <p>{{ t('adapters.repair') }}</p>
          <ul class="mt-1.5 flex flex-col gap-1.5">
            <li
              v-for="item in repairs"
              :key="item.key"
              class="flex items-center gap-2"
            >
              <template v-if="item.repair.kind === 'command'">
                <code class="min-w-0 flex-1 truncate rounded-md border border-default bg-default px-2 py-1 font-mono text-xs text-highlighted">{{ item.repair.command }}</code>
                <UButton
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-copy"
                  :aria-label="t('adapters.copyCommand', { command: item.repair.command })"
                  @click="copy(item.repair.command)"
                />
              </template>
              <i18n-t
                v-else
                keypath="adapters.repairFile"
                scope="global"
                tag="span"
              >
                <template #path>
                  <code class="font-mono text-xs">{{ item.repair.path }}</code>
                </template>
              </i18n-t>
            </li>
          </ul>
        </template>
        <p class="mt-2 text-xs">
          {{ t('adapters.noInstall') }}
        </p>
      </template>
    </UAlert>
    <UAlert
      v-else-if="resolutionFailed"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('adapters.resolutionUnknown')"
      :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => emit('retryResolution') }]"
    />

    <ol
      v-if="rows.length"
      class="flex flex-col divide-y divide-default border-y border-default"
      :aria-label="t('adapters.orderLabel')"
    >
      <li
        v-for="(row, index) in rows"
        :key="row.uid"
        class="flex gap-3 py-3"
        :class="dragOver === index && dragFrom !== index ? 'bg-muted' : ''"
        :draggable="canEdit"
        data-adapter-row
        @dragstart="onDragStart(index, $event)"
        @dragover.prevent="dragOver = index"
        @dragleave="dragOver = undefined"
        @drop.prevent="onDrop(index)"
        @dragend="onDragEnd"
      >
        <div class="flex shrink-0 flex-col items-center gap-1 pt-1.5">
          <UIcon
            v-if="canEdit"
            name="i-lucide-grip-vertical"
            class="size-4 cursor-grab text-dimmed"
            aria-hidden="true"
          />
          <span class="font-mono text-xs text-muted">{{ index + 1 }}</span>
        </div>

        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="flex flex-wrap items-start gap-2">
            <UFormField
              v-if="canEdit"
              :label="t('adapters.moduleSpecifier')"
              :error="specifierError(row)"
              :ui="{ label: 'sr-only' }"
              class="min-w-0 flex-1"
            >
              <UInput
                v-model="row.moduleSpecifier"
                placeholder="@scope/adapter"
                :data-adapter-specifier="row.uid"
                :aria-invalid="!!specifierError(row) || undefined"
                class="w-full"
                :ui="{ base: 'font-mono' }"
              />
            </UFormField>
            <code
              v-else
              class="min-w-0 flex-1 truncate py-1 font-mono text-xs text-highlighted"
            >{{ row.moduleSpecifier }}</code>
            <UBadge
              :color="STATUS[statusOf(row)].color"
              variant="subtle"
              size="sm"
              :icon="STATUS[statusOf(row)].icon"
              class="mt-1.5 shrink-0"
            >
              {{ t(STATUS[statusOf(row)].key) }}
            </UBadge>
          </div>

          <dl
            v-if="summaryOf(row)?.adapterId"
            class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"
          >
            <div class="flex gap-1">
              <dt>{{ t('adapters.adapterId') }}</dt>
              <dd class="font-mono text-default">
                {{ summaryOf(row)?.adapterId }}
              </dd>
            </div>
            <div
              v-if="summaryOf(row)?.resolvedModule?.packageVersion"
              class="flex gap-1"
            >
              <dt>{{ t('adapters.version') }}</dt>
              <dd class="font-mono text-default">
                {{ summaryOf(row)?.resolvedModule?.packageVersion }}
              </dd>
            </div>
            <div
              v-if="summaryOf(row)?.apiVersion"
              class="flex gap-1"
            >
              <dt>{{ t('adapters.apiVersion') }}</dt>
              <dd class="font-mono text-default">
                {{ summaryOf(row)?.apiVersion }}
              </dd>
            </div>
          </dl>

          <ul
            v-if="rowDiagnostics(row).length"
            class="flex flex-col gap-1 text-xs text-error"
          >
            <li
              v-for="diagnostic in rowDiagnostics(row)"
              :key="diagnostic.code + diagnostic.path"
              class="flex items-start gap-1 break-words"
            >
              <UIcon
                name="i-lucide-circle-alert"
                class="mt-0.5 size-3.5 shrink-0"
              />
              <span><code class="me-1 font-mono">{{ diagnostic.code }}</code>{{ diagnostic.message }}</span>
            </li>
          </ul>

          <UCollapsible
            v-if="canEdit || row.configText"
            :default-open="!!row.configText"
          >
            <UButton
              color="neutral"
              variant="link"
              trailing-icon="i-lucide-chevron-down"
              class="px-0"
              :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
            >
              {{ t('adapters.config') }}
            </UButton>
            <template #content>
              <UFormField
                :label="t('adapters.configLabel', { name: displayName(row) })"
                :help="t('adapters.configHelp')"
                :error="configError(row)"
                :ui="{ label: 'sr-only' }"
                class="pt-1"
              >
                <UTextarea
                  v-if="canEdit"
                  v-model="row.configText"
                  :rows="2"
                  autoresize
                  :maxrows="12"
                  placeholder="{}"
                  :aria-invalid="!!configError(row) || undefined"
                  class="w-full"
                  :ui="{ base: 'font-mono text-xs' }"
                />
                <pre
                  v-else
                  class="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs"
                >{{ row.configText }}</pre>
              </UFormField>
            </template>
          </UCollapsible>
        </div>

        <div
          v-if="canEdit"
          class="flex shrink-0 items-start gap-0.5"
        >
          <UTooltip :text="t('adapters.moveUp')">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-up"
              :disabled="index === 0"
              :aria-label="t('adapters.moveUpLabel', { name: displayName(row) })"
              :data-adapter-move="`${row.uid}-up`"
              @click="move(index, index - 1, 'up')"
            />
          </UTooltip>
          <UTooltip :text="t('adapters.moveDown')">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-down"
              :disabled="index === rows.length - 1"
              :aria-label="t('adapters.moveDownLabel', { name: displayName(row) })"
              :data-adapter-move="`${row.uid}-down`"
              @click="move(index, index + 1, 'down')"
            />
          </UTooltip>
          <UTooltip :text="t('common.remove')">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-trash-2"
              :aria-label="t('adapters.removeLabel', { name: displayName(row) })"
              @click="remove(row)"
            />
          </UTooltip>
        </div>
      </li>
    </ol>
    <p
      v-else
      class="rounded-md border border-dashed border-default px-3 py-4 text-sm text-muted"
    >
      {{ t('adapters.empty') }}
    </p>

    <AuthoringSaveBar
      v-if="canEdit && section.dirty"
      :count="section.changeCount"
      :saving="section.saving"
      :disabled="section.conflict"
      :note="t('adapters.saveNote')"
      @discard="emit('discard')"
      @save="save"
    />
  </section>
</template>
