<script setup lang="ts">
import { computed, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { useAuthoringAccess } from '../../composables/useAuthoringAccess'
import { useUnsavedGuard } from '../../composables/useUnsavedGuard'
import type { Diagnostic } from '../../composables/workbench-types'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import {
	countMessageChanges,
	isReminder,
	localeCellState,
	localeKeyDiff,
	localeTableKeys,
	type LocaleCellState,
} from '../../utils/workspace-authoring'
import WorkbenchPage from '../workbench/WorkbenchPage.vue'
import AuthoringAccessNotice from './AuthoringAccessNotice.vue'
import AuthoringConflictAlert from './AuthoringConflictAlert.vue'
import AuthoringErrorAlert from './AuthoringErrorAlert.vue'
import AuthoringSaveBar from './AuthoringSaveBar.vue'
import NewLocaleModal from './NewLocaleModal.vue'
import UnsavedLeaveModal from './UnsavedLeaveModal.vue'

/**
 * Locales as a key × Locale table (brief g). Every key of every Locale is one row; the primary
 * Locale (the Workspace default) leads. Empty and whitespace-only values are reminders, and the
 * key diff names what each Locale lacks or adds against the primary. Edits stay per Locale and
 * save through `update_locale` (`PUT /api/locales/:locale`) with that Locale's revision.
 */
type LocaleRead = Readonly<{ key: string; revision: string; diagnostics: readonly Diagnostic[]; resource: Record<string, string> }>
type LocaleSummary = Readonly<{ key: string; revision: string }>

type LocaleState = {
	key: string
	revision: string
	saved: Record<string, string>
	draft: Record<string, string>
	diagnostics: readonly Diagnostic[]
	conflict: boolean
	theirs?: { revision: string; messages: Record<string, string> }
	saving: boolean
	error?: FetchErrorDetails
}

const { t } = useI18n()
const workbench = useWorkbench()
const { workspace } = workbench
const uiux = useUiuxClient()
const feedback = useWorkbenchFeedback()
const { access, canEdit, isMobile } = useAuthoringAccess()

const primary = computed(() => workspace.value?.resource?.i18n?.defaultLocale ?? 'en-US')
const states = ref<LocaleState[]>([])
const loading = ref(true)
const loadError = ref<FetchErrorDetails>()

const ordered = computed(() => [...states.value].sort((a, b) => (a.key === primary.value ? -1 : b.key === primary.value ? 1 : a.key.localeCompare(b.key))))
const localeKeys = computed(() => ordered.value.map(state => state.key))
const byKey = computed(() => new Map(states.value.map(state => [state.key, state])))
const primaryState = computed(() => byKey.value.get(primary.value))
const drafts = computed(() => Object.fromEntries(states.value.map(state => [state.key, state.draft])))

async function readLocale(key: string): Promise<LocaleRead | undefined> {
	return await uiux.readResource<LocaleRead>('locale', key)
}

async function load(): Promise<void> {
	loading.value = true
	loadError.value = undefined
	try {
		const list = await uiux.listResources<LocaleSummary>(['locale'], { limit: 100 })
		const reads = await Promise.all(list.items.map(item => readLocale(item.key)))
		const next: LocaleState[] = []
		for (const read of reads) {
			if (!read) continue
			const existing = byKey.value.get(read.key)
			// Keep a draft across reloads; only a clean Locale adopts the newer file.
			if (existing && countMessageChanges(existing.saved, existing.draft) > 0) {
				if (existing.revision !== read.revision) {
					existing.conflict = true
					existing.theirs = { revision: read.revision, messages: { ...read.resource } }
				}
				next.push(existing)
				continue
			}
			next.push(reactive({ key: read.key, revision: read.revision, saved: { ...read.resource }, draft: { ...read.resource }, diagnostics: read.diagnostics ?? [], conflict: false, saving: false }))
		}
		states.value = next
	}
	catch (cause) {
		loadError.value = describeFetchError(cause, t('locales.loadListFailed'))
	}
	finally {
		loading.value = false
	}
}

onMounted(load)

// Filters
type Filter = 'all' | 'reminders' | 'missing' | 'extra'
const filter = ref<Filter>('all')
const query = ref('')

const allKeys = computed(() => localeTableKeys(primary.value, drafts.value))
const others = computed(() => ordered.value.filter(state => state.key !== primary.value))

function rowHasReminder(key: string): boolean {
	return states.value.some(state => isReminder(state.draft[key]))
}
function rowHasMissing(key: string): boolean {
	return !!primaryState.value && Object.hasOwn(primaryState.value.draft, key) && others.value.some(state => !Object.hasOwn(state.draft, key))
}
function rowIsExtra(key: string): boolean {
	return !!primaryState.value && !Object.hasOwn(primaryState.value.draft, key)
}

const counts = computed(() => ({
	all: allKeys.value.length,
	reminders: allKeys.value.filter(rowHasReminder).length,
	missing: allKeys.value.filter(rowHasMissing).length,
	extra: allKeys.value.filter(rowIsExtra).length,
}))

const filterItems = computed(() => (['all', 'reminders', 'missing', 'extra'] as const).map(value => ({
	label: t(`locales.filter.${value}`),
	value,
	badge: { label: String(counts.value[value]), color: 'neutral' as const, variant: 'soft' as const, size: 'sm' as const },
})))

type Row = { key: string }
const rows = computed<Row[]>(() => {
	const q = query.value.trim().toLowerCase()
	return allKeys.value
		.filter((key) => {
			if (filter.value === 'reminders' && !rowHasReminder(key)) return false
			if (filter.value === 'missing' && !rowHasMissing(key)) return false
			if (filter.value === 'extra' && !rowIsExtra(key)) return false
			if (!q) return true
			return key.toLowerCase().includes(q) || states.value.some(state => (state.draft[key] ?? '').toLowerCase().includes(q))
		})
		.map(key => ({ key }))
})

const diffs = computed(() => others.value.map(state => ({
	locale: state.key,
	...localeKeyDiff(primaryState.value?.draft ?? {}, state.draft),
	total: Object.keys(state.draft).length,
})))

const MARKERS: Record<Exclude<LocaleCellState, 'value'>, { icon: string; key: string; variant: 'subtle' | 'outline' }> = {
	missing: { icon: 'i-lucide-circle-off', key: 'locales.missing', variant: 'outline' },
	empty: { icon: 'i-lucide-circle-dashed', key: 'locales.empty', variant: 'subtle' },
	whitespace: { icon: 'i-lucide-space', key: 'locales.whitespace', variant: 'subtle' },
}

function isEdited(state: LocaleState, key: string): boolean {
	return state.saved[key] !== state.draft[key]
}

const columns = computed<TableColumn<Row>[]>(() => [
	{ id: 'key', header: t('locales.keyColumn'), meta: { class: { th: 'w-64 min-w-48', td: 'align-top' } } },
	...localeKeys.value.map(locale => ({ id: locale, header: () => h('span', locale), meta: { class: { th: 'min-w-56', td: 'align-top p-0' } } })),
])

// Cell editing: Enter or a click edits, Enter commits, Escape cancels, Tab commits and moves on.
const editing = ref<{ key: string; locale: string; value: string }>()

function cellId(row: number, col: number): string {
	return `${row}:${col}`
}
function focusCell(row: number, col: number): void {
	void nextTick(() => document.querySelector<HTMLElement>(`[data-locale-cell="${cellId(row, col)}"]`)?.focus())
}
function startEdit(key: string, locale: string): void {
	if (!canEdit.value) return
	const state = byKey.value.get(locale)
	if (!state || state.saving) return
	editing.value = { key, locale, value: state.draft[key] ?? '' }
	void nextTick(() => document.querySelector<HTMLTextAreaElement>('[data-locale-editor] textarea')?.focus())
}
function commit(): void {
	const current = editing.value
	if (!current) return
	const state = byKey.value.get(current.locale)
	if (state) state.draft = { ...state.draft, [current.key]: current.value }
	editing.value = undefined
}
function position(key: string, locale: string): { row: number; col: number } {
	return { row: rows.value.findIndex(row => row.key === key), col: localeKeys.value.indexOf(locale) }
}
function onEditorKeydown(event: KeyboardEvent): void {
	const current = editing.value
	if (!current) return
	const { row, col } = position(current.key, current.locale)
	if (event.key === 'Escape') {
		event.preventDefault()
		event.stopPropagation()
		editing.value = undefined
		focusCell(row, col)
	}
	else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
		event.preventDefault()
		commit()
		focusCell(row, col)
	}
	else if (event.key === 'Tab') {
		event.preventDefault()
		commit()
		const step = event.shiftKey ? -1 : 1
		let nextCol = col + step
		let nextRow = row
		if (nextCol >= localeKeys.value.length) { nextCol = 0; nextRow += 1 }
		if (nextCol < 0) { nextCol = localeKeys.value.length - 1; nextRow -= 1 }
		focusCell(Math.max(0, Math.min(rows.value.length - 1, nextRow)), nextCol)
	}
}
function onCellKeydown(event: KeyboardEvent, key: string, locale: string): void {
	const { row, col } = position(key, locale)
	const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
	const move = moves[event.key]
	if (move) {
		event.preventDefault()
		focusCell(Math.max(0, Math.min(rows.value.length - 1, row + move[0])), Math.max(0, Math.min(localeKeys.value.length - 1, col + move[1])))
	}
	else if (event.key === 'F2') {
		event.preventDefault()
		startEdit(key, locale)
	}
}

// Keys
const addingKey = ref(false)
const newKey = ref('')
const newKeyTouched = ref(false)
const newKeyError = computed(() => {
	if (!newKeyTouched.value) return undefined
	const key = newKey.value.trim()
	if (!key) return t('locales.addKeyRequired')
	if (allKeys.value.includes(key)) return t('locales.addKeyTaken', { key })
	return undefined
})
function openAddKey(): void {
	addingKey.value = true
	newKey.value = ''
	newKeyTouched.value = false
	void nextTick(() => document.querySelector<HTMLInputElement>('[data-new-key-input]')?.focus())
}
function addKey(): void {
	newKeyTouched.value = true
	if (newKeyError.value) return
	const key = newKey.value.trim()
	for (const state of states.value) state.draft = { ...state.draft, [key]: '' }
	addingKey.value = false
	filter.value = 'all'
	query.value = ''
	void nextTick(() => startEdit(key, primary.value))
}
function removeKey(key: string): void {
	for (const state of states.value) {
		if (!Object.hasOwn(state.draft, key)) continue
		state.draft = Object.fromEntries(Object.entries(state.draft).filter(([existing]) => existing !== key))
	}
}
function addMissing(locale: string): void {
	const state = byKey.value.get(locale)
	const diff = diffs.value.find(item => item.locale === locale)
	if (!state || !diff) return
	state.draft = { ...state.draft, ...Object.fromEntries(diff.missing.map(key => [key, ''])) }
}
function removeExtra(locale: string): void {
	const state = byKey.value.get(locale)
	const diff = diffs.value.find(item => item.locale === locale)
	if (!state || !diff) return
	state.draft = Object.fromEntries(Object.entries(state.draft).filter(([key]) => !diff.extra.includes(key)))
}

// Saving, per Locale
const dirtyStates = computed(() => ordered.value.filter(state => countMessageChanges(state.saved, state.draft) > 0))
const dirtyCount = computed(() => dirtyStates.value.reduce((sum, state) => sum + countMessageChanges(state.saved, state.draft), 0))
const guard = useUnsavedGuard(() => dirtyCount.value > 0)

async function save(state: LocaleState): Promise<void> {
	if (!canEdit.value || state.saving || state.conflict) return
	commit()
	state.saving = true
	state.error = undefined
	try {
		await $fetch(`/api/locales/${encodeURIComponent(state.key)}`, {
			method: 'PUT',
			body: { expectedRevision: state.revision, messages: state.draft },
		})
		const read = await readLocale(state.key)
		if (read) {
			state.revision = read.revision
			state.saved = { ...read.resource }
			state.draft = { ...read.resource }
			state.diagnostics = read.diagnostics ?? []
		}
		feedback.success(t('locales.saved', { locale: state.key }))
		void workbench.refreshAll()
	}
	catch (cause) {
		const details = describeFetchError(cause, t('locales.saveFailed'))
		if (details.statusCode === 409 || details.status === 'conflict') {
			state.conflict = true
			const read = await readLocale(state.key).catch(() => undefined)
			if (read) state.theirs = { revision: read.revision, messages: { ...read.resource } }
		}
		else {
			state.error = details
		}
	}
	finally {
		state.saving = false
	}
}

function discard(state: LocaleState): void {
	if (editing.value?.locale === state.key) editing.value = undefined
	state.draft = { ...state.saved }
	state.error = undefined
}

async function reloadTheirs(state: LocaleState): Promise<void> {
	const read = state.theirs ?? await readLocale(state.key).then(value => value && { revision: value.revision, messages: { ...value.resource } })
	if (!read) return
	state.revision = read.revision
	state.saved = { ...read.messages }
	state.draft = { ...read.messages }
	state.conflict = false
	state.theirs = undefined
}

function keepMine(state: LocaleState): void {
	if (!state.theirs) return
	state.revision = state.theirs.revision
	state.saved = { ...state.theirs.messages }
	state.conflict = false
	state.theirs = undefined
}

function pathLabel(path: string): string {
	return path.slice(1).replaceAll('~1', '/').replaceAll('~0', '~')
}

/** ⌘S / Ctrl+S saves the Locale being edited, or the only Locale with a draft. */
function onKeydown(event: KeyboardEvent): void {
	if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || event.shiftKey || event.altKey) return
	event.preventDefault()
	if (!canEdit.value) return
	const focusedLocale = editing.value?.locale ?? (document.activeElement as HTMLElement | null)?.dataset?.locale
	commit()
	const target = (focusedLocale && dirtyStates.value.find(state => state.key === focusedLocale)) || (dirtyStates.value.length === 1 ? dirtyStates.value[0] : undefined)
	if (target) void save(target)
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// New Locale
const creating = ref(false)
const createTag = ref<string>()
function openCreate(tag?: string): void {
	createTag.value = tag
	creating.value = true
}
async function onCreated(locale: string): Promise<void> {
	feedback.success(t('locales.create.created', { locale }))
	await load()
	void workbench.refreshAll()
}

watch(canEdit, (value) => { if (!value) editing.value = undefined })

const conflictStates = computed(() => ordered.value.filter(state => state.conflict))
const errorStates = computed(() => ordered.value.filter(state => state.error))
const diagnosticStates = computed(() => ordered.value.filter(state => state.diagnostics.length))
</script>

<template>
  <WorkbenchPage
    id="workspace-locales"
    :title="t('locales.pageTitle')"
  >
    <div class="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-4 sm:px-6">
      <header class="flex shrink-0 flex-col gap-4 pt-6 pb-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 space-y-1">
            <h1 class="text-headline font-semibold text-highlighted">
              {{ t('locales.pageTitle') }}
            </h1>
            <p class="text-sm text-muted">
              {{ t('locales.pageSubtitle') }}
            </p>
          </div>
          <div
            v-if="canEdit"
            class="flex shrink-0 gap-2"
          >
            <UButton
              icon="i-lucide-plus"
              :disabled="!states.length"
              @click="openAddKey"
            >
              {{ t('locales.addKey') }}
            </UButton>
            <UButton
              icon="i-lucide-plus"
              @click="openCreate()"
            >
              {{ t('locales.newLocale') }}
            </UButton>
          </div>
        </div>
        <AuthoringAccessNotice :access="access" />

        <UAlert
          v-if="!loading && !loadError && states.length && !primaryState"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t('locales.defaultMissing.title')"
          :actions="canEdit ? [{ label: t('locales.defaultMissing.action'), color: 'neutral', variant: 'outline', onClick: () => openCreate(primary) }] : []"
        >
          <template #description>
            <i18n-t
              keypath="locales.defaultMissing.description"
              tag="span"
              scope="global"
            >
              <template #locale>
                <code class="font-mono">{{ primary }}</code>
              </template>
            </i18n-t>
          </template>
        </UAlert>

        <AuthoringConflictAlert
          v-for="state in conflictStates"
          :key="`conflict-${state.key}`"
          :title="t('locales.conflictTitle', { locale: state.key })"
          :theirs="state.theirs?.messages ?? state.saved"
          :yours="state.draft"
          :format-path="pathLabel"
          @reload="reloadTheirs(state)"
          @keep-mine="keepMine(state)"
        />
        <AuthoringErrorAlert
          v-for="state in errorStates"
          :key="`error-${state.key}`"
          :title="t('locales.saveFailedLocale', { locale: state.key })"
          :error="state.error!"
          @close="state.error = undefined"
        />
        <UAlert
          v-for="state in diagnosticStates"
          :key="`diagnostics-${state.key}`"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t('locales.diagnosticsTitle', { locale: state.key, n: state.diagnostics.length }, state.diagnostics.length)"
        >
          <template #description>
            <ul class="space-y-1">
              <li
                v-for="diagnostic in state.diagnostics"
                :key="diagnostic.code + diagnostic.path"
              >
                <code class="me-1 font-mono text-xs">{{ diagnostic.path || diagnostic.code }}</code>{{ diagnostic.message }}
              </li>
            </ul>
          </template>
        </UAlert>

        <section
          v-if="primaryState && diffs.length"
          class="flex flex-col gap-2"
          aria-labelledby="locale-diff-title"
          data-locale-diff
        >
          <h2
            id="locale-diff-title"
            class="text-xs font-medium text-muted"
          >
            <i18n-t
              keypath="locales.diff.title"
              scope="global"
              tag="span"
            >
              <template #locale>
                <code class="font-mono">{{ primary }}</code>
              </template>
            </i18n-t>
          </h2>
          <ul class="flex flex-col divide-y divide-default rounded-lg border border-default">
            <li
              v-for="diff in diffs"
              :key="diff.locale"
              class="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2"
              :data-locale-diff-row="diff.locale"
            >
              <code class="w-16 shrink-0 font-mono text-xs text-highlighted">{{ diff.locale }}</code>
              <span
                v-if="!diff.missing.length && !diff.extra.length"
                class="flex items-center gap-1.5 text-sm text-muted"
              >
                <UIcon
                  name="i-lucide-check"
                  class="size-4 text-success"
                />{{ t('locales.diff.match', { n: primaryState ? Object.keys(primaryState.draft).length : 0 }) }}
              </span>
              <template v-else>
                <UBadge
                  v-if="diff.missing.length"
                  color="warning"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-circle-off"
                >
                  {{ t('locales.diff.missing', { n: diff.missing.length }, diff.missing.length) }}
                </UBadge>
                <UBadge
                  v-if="diff.extra.length"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  icon="i-lucide-circle-plus"
                >
                  {{ t('locales.diff.extra', { n: diff.extra.length }, diff.extra.length) }}
                </UBadge>
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted">{{ [...diff.missing, ...diff.extra].slice(0, 4).join(', ') }}{{ diff.missing.length + diff.extra.length > 4 ? '…' : '' }}</span>
                <div
                  v-if="canEdit"
                  class="flex gap-1"
                >
                  <UButton
                    v-if="diff.missing.length"
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    @click="addMissing(diff.locale)"
                  >
                    {{ t('locales.diff.addMissing') }}
                  </UButton>
                  <UButton
                    v-if="diff.extra.length"
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    @click="removeExtra(diff.locale)"
                  >
                    {{ t('locales.diff.removeExtra') }}
                  </UButton>
                </div>
              </template>
            </li>
          </ul>
        </section>

        <div
          v-if="states.length"
          class="flex flex-wrap items-center gap-3"
        >
          <UInput
            v-model="query"
            icon="i-lucide-search"
            :placeholder="t('locales.filterPlaceholder')"
            :aria-label="t('locales.filterLabel')"
            class="w-full sm:w-64"
          />
          <UTabs
            v-model="filter"
            :items="filterItems"
            :content="false"
            variant="link"
            color="primary"
            size="sm"
            :aria-label="t('locales.filterLabel')"
            :ui="{ root: 'w-full sm:w-auto', list: 'overflow-x-auto' }"
          />
        </div>

        <form
          v-if="addingKey && canEdit"
          class="flex flex-wrap items-start gap-2"
          novalidate
          @submit.prevent="addKey"
        >
          <UFormField
            :label="t('locales.newKeyLabel')"
            :error="newKeyError"
            :help="t('locales.newKeyHelp')"
            class="w-full max-w-sm"
          >
            <UInput
              v-model="newKey"
              placeholder="checkout.title"
              data-new-key-input
              :aria-invalid="!!newKeyError || undefined"
              class="w-full"
              :ui="{ base: 'font-mono' }"
              @keydown.escape.stop="addingKey = false"
            />
          </UFormField>
          <div class="flex gap-2 pt-6">
            <UButton
              type="submit"
              color="neutral"
            >
              {{ t('common.add') }}
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              @click="addingKey = false"
            >
              {{ t('common.cancel') }}
            </UButton>
          </div>
        </form>
      </header>

      <UAlert
        v-if="loadError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        role="alert"
        class="mb-4"
        :title="t('locales.loadListFailed')"
        :description="loadError.message"
        :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void load() } }]"
      />

      <div
        v-if="loading && !states.length"
        class="flex flex-col gap-2 pb-6"
        aria-hidden="true"
      >
        <USkeleton
          v-for="n in 12"
          :key="n"
          class="h-8 w-full"
        />
      </div>

      <UEmpty
        v-else-if="!states.length && !loadError"
        icon="i-lucide-globe"
        :title="t('locales.emptyTitle')"
        :description="canEdit ? t('locales.emptyDescription') : t('locales.emptyDescriptionReadOnly')"
        :actions="canEdit ? [{ label: t('locales.emptyAction'), icon: 'i-lucide-plus', color: 'primary', onClick: () => openCreate(primary) }] : []"
        class="my-8"
      />

      <!-- Mobile: one read-only card per key -->
      <ul
        v-else-if="isMobile"
        class="flex min-h-0 flex-1 flex-col divide-y divide-default overflow-y-auto border-t border-default pb-6"
        data-locale-list
      >
        <li
          v-for="row in rows"
          :key="row.key"
          class="flex flex-col gap-1.5 py-3"
        >
          <span class="flex items-center gap-2">
            <code class="min-w-0 truncate font-mono text-xs text-highlighted">{{ row.key }}</code>
            <UBadge
              v-if="rowIsExtra(row.key)"
              color="neutral"
              variant="outline"
              size="sm"
            >{{ t('locales.extraBadge', { locale: primary }) }}</UBadge>
          </span>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <template
              v-for="state in ordered"
              :key="state.key"
            >
              <dt class="font-mono text-xs leading-5 text-muted">
                {{ state.key }}
              </dt>
              <dd class="min-w-0 break-words">
                <UBadge
                  v-if="localeCellState(state.draft[row.key]) !== 'value'"
                  color="warning"
                  :variant="MARKERS[localeCellState(state.draft[row.key]) as Exclude<LocaleCellState, 'value'>].variant"
                  size="sm"
                  :icon="MARKERS[localeCellState(state.draft[row.key]) as Exclude<LocaleCellState, 'value'>].icon"
                >
                  {{ t(MARKERS[localeCellState(state.draft[row.key]) as Exclude<LocaleCellState, 'value'>].key) }}
                </UBadge>
                <span v-else>{{ state.draft[row.key] }}</span>
              </dd>
            </template>
          </dl>
        </li>
        <li
          v-if="!rows.length"
          class="py-6 text-sm text-muted"
        >
          {{ t('locales.noMatches') }}
        </li>
      </ul>

      <!-- Tablet and desktop: the key × Locale table -->
      <UTable
        v-else
        :data="rows"
        :columns="columns"
        :get-row-id="(row: Row) => row.key"
        sticky
        :empty="t('locales.noMatches')"
        class="min-h-0 flex-1 border-t border-default"
        :ui="{ base: 'table-fixed', th: 'text-xs font-medium text-muted bg-default', td: 'text-sm py-0 px-0', tr: 'group' }"
        data-locale-table
      >
        <template
          v-for="locale in localeKeys"
          :key="`header-${locale}`"
          #[`${locale}-header`]
        >
          <span class="flex items-center gap-2">
            <code class="font-mono text-xs text-highlighted">{{ locale }}</code>
            <UBadge
              v-if="locale === primary"
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-star"
            >{{ t('locales.primary') }}</UBadge>
            <UBadge
              v-if="byKey.get(locale) && countMessageChanges(byKey.get(locale)!.saved, byKey.get(locale)!.draft)"
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-pencil"
            >{{ t('locales.editedCount', { n: countMessageChanges(byKey.get(locale)!.saved, byKey.get(locale)!.draft) }) }}</UBadge>
          </span>
        </template>

        <template #key-cell="{ row }">
          <div class="flex min-w-0 items-start gap-1 px-4 py-2">
            <div class="flex min-w-0 flex-1 flex-col items-start gap-1">
              <code class="max-w-full font-mono text-xs break-all text-highlighted">{{ row.original.key }}</code>
              <UBadge
                v-if="rowIsExtra(row.original.key)"
                color="neutral"
                variant="outline"
                size="sm"
              >
                {{ t('locales.extraBadge', { locale: primary }) }}
              </UBadge>
            </div>
            <UTooltip
              v-if="canEdit"
              :text="t('locales.removeKey')"
            >
              <UButton
                color="neutral"
                variant="ghost"
                size="sm"
                icon="i-lucide-x"
                class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                :aria-label="t('locales.removeKeyLabel', { key: row.original.key })"
                @click="removeKey(row.original.key)"
              />
            </UTooltip>
          </div>
        </template>

        <template
          v-for="locale in localeKeys"
          :key="`cell-${locale}`"
          #[`${locale}-cell`]="{ row }"
        >
          <div
            v-if="editing && editing.key === row.original.key && editing.locale === locale"
            class="px-2 py-1"
            data-locale-editor
          >
            <UTextarea
              v-model="editing.value"
              autoresize
              :rows="1"
              :maxrows="8"
              :aria-label="t('locales.cellLabel', { key: row.original.key, locale })"
              class="w-full"
              @keydown="onEditorKeydown"
              @blur="commit"
            />
          </div>
          <component
            :is="canEdit ? 'button' : 'div'"
            v-else
            :type="canEdit ? 'button' : undefined"
            class="flex min-h-10 w-full items-start gap-2 px-4 py-2 text-start"
            :class="canEdit ? 'hover:bg-muted' : ''"
            :data-locale-cell="canEdit ? cellId(row.index, localeKeys.indexOf(locale)) : undefined"
            :data-locale="locale"
            :aria-label="canEdit ? t('locales.editCell', { key: row.original.key, locale }) : undefined"
            @click="startEdit(row.original.key, locale)"
            @keydown="canEdit && onCellKeydown($event, row.original.key, locale)"
          >
            <UBadge
              v-if="localeCellState(byKey.get(locale)?.draft[row.original.key]) !== 'value'"
              color="warning"
              :variant="MARKERS[localeCellState(byKey.get(locale)?.draft[row.original.key]) as Exclude<LocaleCellState, 'value'>].variant"
              size="sm"
              :icon="MARKERS[localeCellState(byKey.get(locale)?.draft[row.original.key]) as Exclude<LocaleCellState, 'value'>].icon"
            >
              {{ t(MARKERS[localeCellState(byKey.get(locale)?.draft[row.original.key]) as Exclude<LocaleCellState, 'value'>].key) }}
            </UBadge>
            <span
              v-else
              class="min-w-0 flex-1 break-words whitespace-pre-wrap text-default"
            >{{ byKey.get(locale)?.draft[row.original.key] }}</span>
            <UIcon
              v-if="byKey.get(locale) && isEdited(byKey.get(locale)!, row.original.key)"
              name="i-lucide-pencil"
              class="mt-0.5 ms-auto size-3.5 shrink-0 text-muted"
              :aria-label="t('locales.edited')"
            />
          </component>
        </template>
      </UTable>

      <footer
        v-if="canEdit && dirtyStates.length"
        class="flex shrink-0 flex-col gap-2 border-t border-default py-3"
      >
        <AuthoringSaveBar
          v-for="state in dirtyStates"
          :key="state.key"
          :count="countMessageChanges(state.saved, state.draft)"
          :saving="state.saving"
          :disabled="state.conflict"
          :note="t('locales.savePerFile', { locale: state.key })"
          :save-label="t('locales.saveLocale', { locale: state.key })"
          @discard="discard(state)"
          @save="save(state)"
        />
      </footer>
    </div>

    <NewLocaleModal
      v-if="canEdit"
      v-model:open="creating"
      :existing="localeKeys"
      :keys-of="(locale: string) => Object.keys(byKey.get(locale)?.draft ?? {})"
      :initial-tag="createTag"
      @created="onCreated"
    />
    <UnsavedLeaveModal
      v-model:open="guard.open.value"
      :count="dirtyCount"
      @leave="guard.leave"
      @stay="guard.stay"
    />
  </WorkbenchPage>
</template>
