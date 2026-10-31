<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n, useToast } from '#imports'
import KitBadge from '~/components/kit/ui/Badge.vue'
import KitButton from '~/components/kit/ui/Button.vue'
import KitIcon from '~/components/kit/ui/Icon.vue'
import type { ProductKit } from '../../../src/domain/product-kit/schema'
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
import { diagnosticText } from '../../utils/diagnostic-copy'
import AuthoringConflictAlert from './AuthoringConflictAlert.vue'
import AuthoringErrorAlert from './AuthoringErrorAlert.vue'
import AuthoringSaveBar from './AuthoringSaveBar.vue'
import WbErrorDetails from '../workbench/WbErrorDetails.vue'
import { copyText } from '../../utils/copy-text'

/** What `/api/preview/adapters` reports about the saved Adapter set. */
export type AdapterResolution = Readonly<{
	state: 'valid' | 'invalid'
	diagnostics: readonly Diagnostic[]
	/** A valid set whose server-side Adapter check could not run (Clause 01a116f0-cae2-7c64-9c76-d472f252789a). */
	warnings?: readonly Diagnostic[]
	summaries: readonly Readonly<{
		index: number
		moduleSpecifier: string
		adapterId?: string
		apiVersion?: string
		resolvedModule?: Readonly<{ packageName?: string; packageVersion?: string }>
		/** For an Adapter that declares theme support: the Workspace themes it does not support. */
		unsupportedThemeIds?: readonly string[]
	}>[]
	/**
	 * The theme support of a valid set (Rule 01a11add-f46d-7e92-8f5a-9d10dba6473d); `diagnostics` are the
	 * predicates that could not answer, which leave the set valid.
	 */
	themeSupport?: Readonly<{ unsupportedThemeIds: readonly string[]; diagnostics: readonly Diagnostic[] }>
}>

/**
 * Adapters, in the Overview section of the Product Kit page (Rules 01a116f0-8a46-76bc-a29f-affaa302c44c
 * and 01a115cd-af57-781e-9493-89d037e41b06): the ordered selection, read-only package state per Adapter
 * (resolution, package, identity, API, config) and the set's collision diagnostics, with repair
 * guidance for an invalid set. The Workbench never runs a package manager (Part 8 10a); it
 * prints the command to run. Order is changed by dragging or with the Move up / Move down buttons.
 *
 * The selection is the Product Kit file's: the page saves it through the Product Kit operations.
 * Adding, removing, reordering or re-pointing an Adapter needs `product-kit.compose` (Clause
 * 01a11bb1-b35a-7e69-bba5-978e3f47c4fa): without it (`canCompose`) only an Adapter's config stays
 * editable, and the section names the missing key. A `./` specifier names a module in the
 * Workspace's `kit/` directory.
 */
const props = defineProps<{
	section: SettingsSection<AdapterRow[], ProductKit>
	canEdit: boolean
	canCompose: boolean
	resolution?: AdapterResolution
	resolutionFailed?: boolean
	/** The key the signed-in member lacks to edit this section, when it is not the page's own. */
	missingKey?: string
	/** The last save wrote the specifiers but not their `config`, which the draft still holds. */
	partlySaved?: boolean
}>()
const emit = defineEmits<{ save: []; discard: []; reload: []; keepMine: []; retryResolution: [] }>()
const { t } = useI18n()
const toast = useToast()

const rows = computed<AdapterRow[]>(() => props.section.draft ?? [])
/** The selection itself (which Adapters, in which order) is editable here. */
const canComposeHere = computed(() => props.canEdit && props.canCompose)
const showIssues = ref(false)

function specifierError(row: AdapterRow): string | undefined {
	if (!showIssues.value && row.savedIndex !== undefined) return undefined
	const value = row.moduleSpecifier.trim()
	if (!value) return showIssues.value ? t('adapters.validation.required') : undefined
	return isPortableAdapterModuleSpecifier(value) ? undefined : t('adapters.validation.kitSpecifier')
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

/**
 * The theme-support predicate failures of one saved Adapter (Rule 01a11a5a-555f-7b4c-8fcc-311c31a99b7a):
 * non-blocking, each making its theme unsupported.
 */
function rowThemeSupportDiagnostics(row: AdapterRow): readonly Diagnostic[] {
	if (row.savedIndex === undefined || statusOf(row) !== 'loaded') return []
	return (props.resolution?.themeSupport?.diagnostics ?? []).filter(item => adapterIndexOf(item.path) === row.savedIndex)
}

/**
 * The Workspace themes a saved Adapter does not support (Rule 01a11a5a-5769-721b-ad33-d068c7edeb41),
 * or `undefined` for an Adapter that declares no theme support, which supports every theme.
 */
function unsupportedThemesOf(row: AdapterRow): readonly string[] | undefined {
	if (statusOf(row) !== 'loaded') return undefined
	return summaryOf(row)?.unsupportedThemeIds
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
	loaded: { tone: 'success', icon: 'check', key: 'adapters.status.loaded' },
	failed: { tone: 'danger', icon: 'circle-alert', key: 'adapters.status.failed' },
	unsaved: { tone: 'neutral', icon: 'circle-dashed', key: 'adapters.status.unsaved' },
	unknown: { tone: 'neutral', icon: 'circle-help', key: 'adapters.status.unknown' },
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
		const found = summary ? adapterRepair(diagnostic.code, summary.moduleSpecifier) : undefined
		if (!found) continue
		// A ./ specifier resolves from kit/.
		const repair: AdapterRepair = found.kind === 'file' ? { kind: 'file', path: `kit/${found.path.slice(2)}` } : found
		const key = repair.kind === 'command' ? repair.command : repair.path
		if (!list.some(item => item.key === key)) list.push({ key, repair })
	}
	return list
})

/** Known fixes first, then commands that may help (`suggestion`), each under its own heading. */
const repairGroups = computed(() => [
	{ heading: 'adapters.repair', items: repairs.value.filter(item => !(item.repair.kind === 'command' && item.repair.suggestion)) },
	{ heading: 'adapters.repairSuggestion', items: repairs.value.filter(item => item.repair.kind === 'command' && item.repair.suggestion) },
].filter(group => group.items.length > 0))

async function copy(text: string): Promise<void> {
	if (await copyText(text)) toast.add({ title: t('adapters.copied'), color: 'success', icon: 'i-lucide-check' })
	else toast.add({ title: t('adapters.copyFailed'), color: 'error', icon: 'i-lucide-circle-alert', duration: 0 })
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
	if (dragFrom.value !== undefined && canComposeHere.value) move(dragFrom.value, index)
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
		void nextTick(() => document.querySelector<HTMLElement>('#product-kit-adapters [aria-invalid="true"]')?.focus())
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
    id="product-kit-adapters"
    aria-labelledby="product-kit-adapters-title"
    class="flex scroll-mt-6 flex-col gap-4"
    data-product-kit-section="adapters"
  >
    <header class="flex items-start justify-between gap-4">
      <div class="min-w-0 space-y-1">
        <h2
          id="product-kit-adapters-title"
          tabindex="-1"
          class="text-title font-semibold text-highlighted focus:outline-none"
        >
          {{ t('productKit.adapters') }}
        </h2>
        <p class="text-sm text-muted">
          {{ t('adapters.kitDescription') }}
        </p>
        <p
          v-if="missingKey"
          class="flex items-center gap-1.5 text-xs text-muted"
          data-access-notice="adapters"
          :data-missing-key="missingKey"
        >
          <KitIcon
            name="user-lock"
            :size="14"
            class="shrink-0"
          />
          {{ t('access.requiresKey', { key: missingKey }) }}
        </p>
        <p
          v-else-if="canEdit && !canCompose"
          class="flex items-center gap-1.5 text-xs text-muted"
          data-access-notice="compose"
          data-missing-key="product-kit.compose"
        >
          <KitIcon
            name="user-lock"
            :size="14"
            class="shrink-0"
          />
          {{ t('access.requiresKey', { key: 'product-kit.compose' }) }}
        </p>
      </div>
      <KitButton
        v-if="canComposeHere"
        icon="plus"
        @click="add"
      >
        {{ t('adapters.add') }}
      </KitButton>
    </header>

    <AuthoringConflictAlert
      v-if="section.conflict"
      :title="t('productKit.conflict')"
      :theirs="section.theirs"
      :yours="section.draftPayload"
      @reload="emit('reload')"
      @keep-mine="emit('keepMine')"
    />
    <AuthoringErrorAlert
      v-else-if="section.error"
      :title="partlySaved ? t('productKit.adaptersPartlySaved') : t('productKit.saveFailed')"
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
            <code class="me-1 font-mono text-xs">{{ diagnostic.path || diagnostic.code }}</code>{{ diagnosticText(diagnostic) }}
          </li>
        </ul>
        <template
          v-for="group in repairGroups"
          :key="group.heading"
        >
          <p class="mt-2 first:mt-0">
            {{ t(group.heading) }}
          </p>
          <ul class="mt-1.5 flex flex-col gap-1.5">
            <li
              v-for="item in group.items"
              :key="item.key"
              class="flex items-center gap-2"
            >
              <template v-if="item.repair.kind === 'command'">
                <code class="min-w-0 flex-1 truncate rounded-md border border-default bg-default px-2 py-1 font-mono text-xs text-highlighted">{{ item.repair.command }}</code>
                <KitButton
                  variant="ghost"
                  icon="copy"
                  icon-only
                  :label="t('adapters.copyCommand', { command: item.repair.command })"
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
      v-else-if="resolution?.warnings?.length"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      data-adapters-unchecked
      :title="t('adapters.checkUnchecked')"
    >
      <template #description>
        <WbErrorDetails :diagnostics="resolution?.warnings ?? []" />
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
        :draggable="canComposeHere"
        data-adapter-row
        @dragstart="onDragStart(index, $event)"
        @dragover.prevent="dragOver = index"
        @dragleave="dragOver = undefined"
        @drop.prevent="onDrop(index)"
        @dragend="onDragEnd"
      >
        <div class="flex shrink-0 flex-col items-center gap-1 pt-1.5">
          <KitIcon
            v-if="canComposeHere"
            name="grip-vertical"
            class="cursor-grab text-dimmed"
            aria-hidden="true"
          />
          <span class="font-mono text-xs text-muted">{{ index + 1 }}</span>
        </div>

        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="flex flex-wrap items-start gap-2">
            <UFormField
              v-if="canComposeHere"
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
            <KitBadge
              :tone="STATUS[statusOf(row)].tone"
              :icon="STATUS[statusOf(row)].icon"
              class="mt-1.5"
            >
              {{ t(STATUS[statusOf(row)].key) }}
            </KitBadge>
          </div>

          <dl
            v-if="summaryOf(row)?.adapterId"
            class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"
          >
            <div class="flex gap-1">
              <dt>{{ t('adapters.adapterId') }}</dt>
              <dd
                class="font-mono text-default"
                translate="no"
              >
                {{ summaryOf(row)?.adapterId }}
              </dd>
            </div>
            <div
              v-if="summaryOf(row)?.resolvedModule?.packageName"
              class="flex gap-1"
            >
              <dt>{{ t('adapters.package') }}</dt>
              <dd
                class="font-mono text-default"
                translate="no"
                data-adapter-package
              >
                {{ summaryOf(row)?.resolvedModule?.packageName }}
              </dd>
            </div>
            <div
              v-if="summaryOf(row)?.resolvedModule?.packageVersion"
              class="flex gap-1"
            >
              <dt>{{ t('adapters.version') }}</dt>
              <dd
                class="font-mono text-default"
                translate="no"
              >
                {{ summaryOf(row)?.resolvedModule?.packageVersion }}
              </dd>
            </div>
            <div
              v-if="summaryOf(row)?.apiVersion"
              class="flex gap-1"
            >
              <dt>{{ t('adapters.apiVersion') }}</dt>
              <dd
                class="font-mono text-default"
                translate="no"
              >
                {{ summaryOf(row)?.apiVersion }}
              </dd>
            </div>
            <div
              v-if="unsupportedThemesOf(row)"
              class="flex gap-1"
              data-adapter-unsupported-themes
            >
              <dt>{{ t('adapters.unsupportedThemes') }}</dt>
              <dd
                v-if="unsupportedThemesOf(row)?.length"
                class="font-mono text-warning"
                translate="no"
              >
                {{ unsupportedThemesOf(row)?.join(', ') }}
              </dd>
              <dd
                v-else
                class="text-default"
              >
                {{ t('adapters.noUnsupportedThemes') }}
              </dd>
            </div>
          </dl>

          <ul
            v-if="rowThemeSupportDiagnostics(row).length"
            class="flex flex-col gap-1 text-xs text-warning"
            data-adapter-theme-support-warnings
          >
            <li
              v-for="(diagnostic, diagnosticIndex) in rowThemeSupportDiagnostics(row)"
              :key="diagnostic.code + diagnosticIndex"
              class="flex items-start gap-1 break-words"
            >
              <KitIcon
                name="triangle-alert"
                :size="14"
                class="mt-0.5 shrink-0"
              />
              <span><code class="me-1 font-mono">{{ diagnostic.code }}</code>{{ diagnosticText(diagnostic) }}</span>
            </li>
          </ul>

          <ul
            v-if="rowDiagnostics(row).length"
            class="flex flex-col gap-1 text-xs text-error"
          >
            <li
              v-for="diagnostic in rowDiagnostics(row)"
              :key="diagnostic.code + diagnostic.path"
              class="flex items-start gap-1 break-words"
            >
              <KitIcon
                name="circle-alert"
                :size="14"
                class="mt-0.5 shrink-0"
              />
              <span><code class="me-1 font-mono">{{ diagnostic.code }}</code>{{ diagnosticText(diagnostic) }}</span>
            </li>
          </ul>

          <UCollapsible
            v-if="canEdit || row.configText"
            :default-open="!!row.configText"
          >
            <template #default="{ open }">
              <KitButton
                variant="link-muted"
                trailing-icon="chevron-down"
                :expanded="open"
              >
                {{ t('adapters.config') }}
              </KitButton>
            </template>
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
          v-if="canComposeHere"
          class="flex shrink-0 items-start gap-0.5"
        >
          <UTooltip :text="t('adapters.moveUp')">
            <KitButton
              variant="ghost"
              icon="arrow-up"
              icon-only
              :label="t('adapters.moveUpLabel', { name: displayName(row) })"
              title=""
              :disabled="index === 0"
              :data-adapter-move="`${row.uid}-up`"
              @click="move(index, index - 1, 'up')"
            />
          </UTooltip>
          <UTooltip :text="t('adapters.moveDown')">
            <KitButton
              variant="ghost"
              icon="arrow-down"
              icon-only
              :label="t('adapters.moveDownLabel', { name: displayName(row) })"
              title=""
              :disabled="index === rows.length - 1"
              :data-adapter-move="`${row.uid}-down`"
              @click="move(index, index + 1, 'down')"
            />
          </UTooltip>
          <UTooltip :text="t('common.remove')">
            <KitButton
              variant="ghost"
              icon="trash-2"
              icon-only
              :label="t('adapters.removeLabel', { name: displayName(row) })"
              title=""
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
