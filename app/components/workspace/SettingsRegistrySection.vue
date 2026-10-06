<script setup lang="ts">
import { computed, h, nextTick, ref } from 'vue'
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import { useI18n } from '#imports'
import type { Diagnostic } from '../../composables/workbench-types'
import type { SettingsSection } from '../../composables/useSettingsSection'
import { nextRowUid, registryRowIssues, type RegistryKind, type RegistryRow, type RegistryRowIssue } from '../../utils/workspace-authoring'
import { diagnosticText } from '../../utils/diagnostic-copy'
import AuthoringConflictAlert from './AuthoringConflictAlert.vue'
import AuthoringErrorAlert from './AuthoringErrorAlert.vue'
import AuthoringSaveBar from './AuthoringSaveBar.vue'
import RegistryKeyModal from './RegistryKeyModal.vue'

/**
 * The Viewport or theme registry (brief g): keys are opaque identities (mono), labels are
 * what people read. Viewports list widest first. Renaming or removing a saved key goes
 * through the reference-impact check; rows added on this page edit their key inline.
 */
const props = defineProps<{
	kind: RegistryKind
	section: SettingsSection<RegistryRow[]>
	canEdit: boolean
	diagnostics: readonly Diagnostic[]
	/** Counts Evidence records captured with a saved key. */
	countEvidence: (key: string) => Promise<number>
}>()
const emit = defineEmits<{ save: []; discard: []; reload: []; keepMine: [] }>()
const { t } = useI18n()

const rows = computed<RegistryRow[]>(() => props.section.draft ?? [])
const issues = computed(() => registryRowIssues(rows.value, props.kind))
const hasIssues = computed(() => issues.value.size > 0)
const showIssues = ref(false)

const ids = computed(() => ({
	section: `settings-${props.kind}`,
	title: `settings-${props.kind}-title`,
}))

function issueText(issue: RegistryRowIssue, row: RegistryRow): string {
	switch (issue) {
		case 'keyRequired': return t('settings.validation.keyRequired')
		case 'keyWhitespace': return t('settings.validation.keyWhitespace')
		case 'keyTaken': return t('settings.validation.keyTaken', { key: row.key.trim() })
		case 'dimensionRequired': return t('settings.validation.dimensionRequired')
	}
}

function rowIssues(row: RegistryRow): string[] {
	if (!showIssues.value && row.savedKey !== undefined) return []
	const list = issues.value.get(row.uid) ?? []
	return list.filter(issue => showIssues.value || issue !== 'keyRequired').map(issue => issueText(issue, row))
}

function add(): void {
	const row: RegistryRow = { uid: nextRowUid(), key: '', label: '', width: props.kind === 'viewports' ? 1280 : null, height: props.kind === 'viewports' ? 800 : null, extra: {}, dimensionExtra: {} }
	props.section.setDraft([...rows.value, row])
	void nextTick(() => document.querySelector<HTMLInputElement>(`[data-registry-key-input="${row.uid}"]`)?.focus())
}

function save(): void {
	showIssues.value = true
	if (hasIssues.value) {
		void nextTick(() => document.querySelector<HTMLElement>(`#${ids.value.section} [aria-invalid="true"]`)?.focus())
		return
	}
	emit('save')
}

// Rename / remove through the reference-impact check (Part 10).
const modalOpen = ref(false)
const modalMode = ref<'rename' | 'remove'>('rename')
const modalRow = ref<RegistryRow>()
const evidenceCount = ref<number>()
const evidenceFailed = ref(false)

async function openKeyModal(row: RegistryRow, mode: 'rename' | 'remove'): Promise<void> {
	modalRow.value = row
	modalMode.value = mode
	evidenceCount.value = undefined
	evidenceFailed.value = false
	modalOpen.value = true
	try { evidenceCount.value = await props.countEvidence(row.savedKey ?? row.key) }
	catch { evidenceFailed.value = true }
}

function remove(row: RegistryRow): void {
	if (row.savedKey === undefined) {
		props.section.setDraft(rows.value.filter(item => item.uid !== row.uid))
		return
	}
	void openKeyModal(row, 'remove')
}

function confirmKeyChange(newKey?: string): void {
	const row = modalRow.value
	if (!row) return
	if (modalMode.value === 'remove') props.section.setDraft(rows.value.filter(item => item.uid !== row.uid))
	else if (newKey) row.key = newKey
}

const takenKeys = computed(() => rows.value.filter(row => row.uid !== modalRow.value?.uid).map(row => row.key.trim()))

function rowActions(row: RegistryRow): DropdownMenuItem[] {
	return [
		...(row.savedKey !== undefined ? [{ label: t('settings.registry.rename'), icon: 'i-lucide-pencil-line', onSelect: () => { void openKeyModal(row, 'rename') } }] : []),
		{ label: t('common.remove'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => remove(row) },
	]
}

const columns = computed<TableColumn<RegistryRow>[]>(() => [
	{ id: 'key', header: t('settings.registry.key'), meta: { class: { th: 'w-48', td: 'align-top' } } },
	{ id: 'label', header: t('settings.registry.label'), meta: { class: { td: 'align-top' } } },
	...(props.kind === 'viewports' ? [{ id: 'size', header: t('settings.registry.size'), meta: { class: { th: 'w-56', td: 'align-top' } } }] : []),
	...(props.canEdit ? [{ id: 'actions', header: () => h('span', { class: 'sr-only' }, t('settings.registry.actions')), meta: { class: { th: 'w-10', td: 'align-top text-end' } } }] : []),
])

const sectionDiagnostics = computed(() => props.diagnostics.filter(item => item.path === `/${props.kind}` || item.path.startsWith(`/${props.kind}/`)))

defineExpose({ save })
</script>

<template>
  <section
    :id="ids.section"
    :aria-labelledby="ids.title"
    class="flex scroll-mt-6 flex-col gap-4"
    data-settings-section
  >
    <header class="flex items-start justify-between gap-4">
      <div class="min-w-0 space-y-1">
        <h2
          :id="ids.title"
          tabindex="-1"
          class="text-title font-semibold text-highlighted focus:outline-none"
        >
          {{ kind === 'viewports' ? t('settings.viewports') : t('settings.themes') }}
        </h2>
        <p class="text-sm text-muted">
          {{ kind === 'viewports' ? t('settings.registry.viewportsDescription') : t('settings.registry.themesDescription') }}
        </p>
      </div>
      <UButton
        v-if="canEdit"
        icon="i-lucide-plus"
        class="shrink-0"
        @click="add"
      >
        {{ kind === 'viewports' ? t('settings.registry.addViewport') : t('settings.registry.addTheme') }}
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
      v-for="diagnostic in sectionDiagnostics"
      :key="diagnostic.code + diagnostic.path"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="diagnosticText(diagnostic)"
      :description="diagnostic.path"
      :ui="{ description: 'font-mono text-xs' }"
    />

    <UTable
      :data="rows"
      :columns="columns"
      :get-row-id="(row: RegistryRow) => row.uid"
      :empty="kind === 'viewports' ? t('settings.registry.viewportsEmpty') : t('settings.registry.themesEmpty')"
      :ui="{ th: 'text-xs font-medium text-muted', td: 'text-sm py-2' }"
      :data-registry="kind"
    >
      <template #key-cell="{ row }">
        <div class="flex min-w-0 flex-col gap-1">
          <UInput
            v-if="canEdit && row.original.savedKey === undefined"
            v-model="row.original.key"
            :placeholder="t(kind === 'viewports' ? 'settings.registry.keyPlaceholderViewport' : 'settings.registry.keyPlaceholderTheme')"
            :aria-label="t('settings.registry.key')"
            :aria-invalid="rowIssues(row.original).length > 0 || undefined"
            :data-registry-key-input="row.original.uid"
            class="w-full"
            :ui="{ base: 'font-mono' }"
          />
          <span
            v-else
            class="flex min-h-8 min-w-0 items-center gap-2"
          >
            <span class="truncate font-mono text-xs text-highlighted">{{ row.original.key }}</span>
            <UBadge
              v-if="row.original.savedKey !== undefined && row.original.savedKey !== row.original.key"
              color="warning"
              variant="subtle"
              size="sm"
              icon="i-lucide-pencil-line"
            >{{ t('settings.registry.renamedFrom', { key: row.original.savedKey }) }}</UBadge>
          </span>
          <UBadge
            v-if="canEdit && row.original.savedKey === undefined"
            color="neutral"
            variant="outline"
            size="sm"
            class="self-start"
          >
            {{ t('settings.registry.new') }}
          </UBadge>
          <p
            v-for="message in rowIssues(row.original)"
            :key="message"
            class="flex items-center gap-1 text-xs text-error"
          >
            <UIcon
              name="i-lucide-circle-alert"
              class="size-3.5 shrink-0"
            />{{ message }}
          </p>
        </div>
      </template>

      <template #label-cell="{ row }">
        <UInput
          v-if="canEdit"
          v-model="row.original.label"
          :placeholder="t('settings.registry.labelPlaceholder')"
          :aria-label="t('settings.registry.labelFor', { key: row.original.key || t('settings.registry.new') })"
          class="w-full"
        />
        <span
          v-else
          class="flex min-h-8 items-center"
          :class="row.original.label ? 'text-default' : 'text-dimmed'"
        >{{ row.original.label || t('settings.registry.noLabel') }}</span>
      </template>

      <template #size-cell="{ row }">
        <div
          v-if="canEdit"
          class="flex items-center gap-1.5"
        >
          <UInputNumber
            v-model="row.original.width"
            :min="1"
            :format-options="{ useGrouping: false, maximumFractionDigits: 0 }"
            :increment="false"
            :decrement="false"
            :aria-label="t('settings.registry.widthFor', { key: row.original.key || t('settings.registry.new') })"
            :aria-invalid="(!row.original.width && showIssues) || undefined"
            :aria-roledescription="t('common.numberField')"
            class="w-24"
            :ui="{ base: 'font-mono' }"
          />
          <span
            class="text-muted"
            aria-hidden="true"
          >×</span>
          <UInputNumber
            v-model="row.original.height"
            :min="1"
            :format-options="{ useGrouping: false, maximumFractionDigits: 0 }"
            :increment="false"
            :decrement="false"
            :aria-label="t('settings.registry.heightFor', { key: row.original.key || t('settings.registry.new') })"
            :aria-invalid="(!row.original.height && showIssues) || undefined"
            :aria-roledescription="t('common.numberField')"
            class="w-24"
            :ui="{ base: 'font-mono' }"
          />
        </div>
        <span
          v-else
          class="flex min-h-8 items-center font-mono text-xs"
        >{{ row.original.width ?? '?' }} × {{ row.original.height ?? '?' }}</span>
      </template>

      <template #actions-cell="{ row }">
        <UDropdownMenu
          :items="rowActions(row.original)"
          :content="{ align: 'end' }"
        >
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-ellipsis"
            :aria-label="t('settings.registry.actionsFor', { key: row.original.key || t('settings.registry.new') })"
          />
        </UDropdownMenu>
      </template>
    </UTable>

    <p
      v-if="canEdit"
      class="flex items-start gap-2 text-xs text-muted"
    >
      <UIcon
        name="i-lucide-info"
        class="mt-0.5 size-3.5 shrink-0"
      />{{ t('settings.keyChange') }}
    </p>
    <p
      v-if="kind === 'themes'"
      class="text-xs text-muted"
    >
      {{ t('settings.registry.notAppearance') }}
    </p>

    <AuthoringSaveBar
      v-if="canEdit && section.dirty"
      :count="section.changeCount"
      :saving="section.saving"
      :disabled="section.conflict"
      @discard="emit('discard')"
      @save="save"
    />

    <RegistryKeyModal
      v-if="modalRow"
      v-model:open="modalOpen"
      :mode="modalMode"
      :registry-key="modalRow.key"
      :taken-keys="takenKeys"
      :evidence-count="evidenceCount"
      :evidence-failed="evidenceFailed"
      @confirm="confirmKeyChange"
    />
  </section>
</template>
