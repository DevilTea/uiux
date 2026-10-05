<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import { useI18n } from '#imports'
import { computed, reactive, ref, watch } from 'vue'
import { useUiuxClient } from '../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../composables/useWorkbenchFeedback'
import { useWorkbenchFormat } from '../composables/useWorkbenchFormat'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'

interface LocaleSummary {
	kind: 'locale'
	key: string
	revision: string
	diagnosticCount: number
	summary: { messageCount?: number }
}

interface LocaleRead {
	kind: 'locale'
	key: string
	revision: string
	diagnostics: ReadonlyArray<{ code: string; path: string; message: string }>
	resource: Record<string, string>
}

const props = defineProps<{
	defaultLocale?: string
	readOnly?: boolean
}>()

const emit = defineEmits<{
	localesChanged: []
	changed: []
}>()

const { t } = useI18n()
const uiux = useUiuxClient()
const feedback = useWorkbenchFeedback()
const fmt = useWorkbenchFormat()

const locales = ref<readonly LocaleSummary[]>([])
const selectedLocaleKey = ref<string>('')
const selectedLocaleData = ref<LocaleRead>()
const loadingList = ref(false)
const loadingDetail = ref(false)
const localeLoadSequence = ref(0)
const listError = ref<FetchErrorDetails>()
const detailError = ref<FetchErrorDetails>()

const searchQuery = ref('')
const saving = ref(false)
const conflict = ref(false)

// In-progress edit state: array of { key: string, value: string }
const localMessages = ref<Array<{ key: string; value: string }>>([])
const newKeyInput = ref('')
const newValueInput = ref('')

// Create locale modal
const isCreatingLocale = ref(false)
const createState = reactive({ tag: '' })
const createError = ref<FetchErrorDetails>()
const creating = ref(false)

const isDefaultLocaleMissing = computed(() => {
	if (!props.defaultLocale) return false
	if (loadingList.value && !locales.value.length) return false
	return !locales.value.some(l => l.key === props.defaultLocale)
})

const localeItems = computed(() => locales.value.map(loc => ({
	label: loc.key,
	description: t('locales.stringCount', loc.summary.messageCount || 0),
	value: loc.key,
	isDefault: loc.key === props.defaultLocale,
	diagnosticCount: loc.diagnosticCount,
})))

const filteredMessages = computed(() => {
	const q = searchQuery.value.trim().toLowerCase()
	if (!q) return localMessages.value
	return localMessages.value.filter(m => m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q))
})

const isDirty = computed(() => {
	const saved = selectedLocaleData.value?.resource ?? {}
	const savedKeys = Object.keys(saved)
	if (savedKeys.length !== localMessages.value.length) return true
	return localMessages.value.some(m => saved[m.key] === undefined || String(saved[m.key]) !== m.value)
})

async function fetchLocales() {
	loadingList.value = true
	listError.value = undefined
	try {
		const res = await uiux.listResources<LocaleSummary>(['locale'], { limit: 100 })
		locales.value = res.items
		if (!selectedLocaleKey.value && res.items.length > 0) {
			const preferred = props.defaultLocale && res.items.some(l => l.key === props.defaultLocale)
				? props.defaultLocale
				: res.items[0]!.key
			await selectLocale(preferred)
		}
		else if (selectedLocaleKey.value) {
			await loadSelectedLocaleDetail()
		}
	}
	catch (err: unknown) {
		listError.value = describeFetchError(err, t('locales.loadListFailed'))
	}
	finally {
		loadingList.value = false
	}
}

function onSelectLocale(value: unknown) {
	if (typeof value === 'string' && value && value !== selectedLocaleKey.value) void selectLocale(value)
}

async function selectLocale(key: string) {
	selectedLocaleKey.value = key
	conflict.value = false
	detailError.value = undefined
	await loadSelectedLocaleDetail()
}

async function loadSelectedLocaleDetail() {
	const currentSeq = ++localeLoadSequence.value
	const key = selectedLocaleKey.value
	if (!key) {
		selectedLocaleData.value = undefined
		localMessages.value = []
		return
	}

	loadingDetail.value = true
	detailError.value = undefined
	try {
		const data = await uiux.readResource<LocaleRead>('locale', key)
		if (!data) throw new Error(t('locales.unavailable'))
		if (localeLoadSequence.value !== currentSeq) return
		selectedLocaleData.value = data
		localMessages.value = Object.entries(data.resource || {}).map(([k, v]) => ({ key: k, value: String(v) }))
	}
	catch (err: unknown) {
		if (localeLoadSequence.value !== currentSeq) return
		detailError.value = describeFetchError(err, t('locales.loadDetailFailed'))
		selectedLocaleData.value = undefined
		localMessages.value = []
	}
	finally {
		if (localeLoadSequence.value === currentSeq)
			loadingDetail.value = false
	}
}

async function reloadAfterConflict() {
	conflict.value = false
	await loadSelectedLocaleDetail()
}

function addMessageRow() {
	if (props.readOnly) return
	const key = newKeyInput.value.trim()
	if (!key) return
	const existing = localMessages.value.find(m => m.key === key)
	if (existing) {
		existing.value = newValueInput.value
	}
	else {
		localMessages.value.push({ key, value: newValueInput.value })
	}
	newKeyInput.value = ''
	newValueInput.value = ''
}

function removeMessageRow(key: string) {
	if (props.readOnly) return
	// Remove by key: the rendered list may be filtered, so its indices do not match localMessages.
	const index = localMessages.value.findIndex(m => m.key === key)
	if (index !== -1) localMessages.value.splice(index, 1)
}

async function handleSaveLocale() {
	if (props.readOnly) return
	if (!selectedLocaleData.value) return
	saving.value = true
	conflict.value = false

	const messagesRecord: Record<string, string> = {}
	for (const m of localMessages.value) {
		if (m.key.trim()) {
			messagesRecord[m.key.trim()] = m.value
		}
	}

	try {
		await $fetch(`/api/locales/${encodeURIComponent(selectedLocaleData.value.key)}`, {
			method: 'PUT',
			body: {
				expectedRevision: selectedLocaleData.value.revision,
				messages: messagesRecord,
			},
		})
		feedback.success(t('locales.saved', { locale: selectedLocaleData.value.key }))
		await fetchLocales()
		emit('localesChanged')
		emit('changed')
	}
	catch (err: unknown) {
		const details = describeFetchError(err, t('locales.saveFailed'))
		if (details.statusCode === 409 || details.status === 'conflict') {
			conflict.value = true
		}
		else {
			feedback.error(err, t('locales.saveFailed'))
		}
	}
	finally {
		saving.value = false
	}
}

function openCreate(tag = '') {
	createState.tag = tag
	createError.value = undefined
	isCreatingLocale.value = true
}

function validateCreate(state: Partial<typeof createState>): FormError[] {
	return state.tag?.trim() ? [] : [{ name: 'tag', message: t('locales.create.tagRequired') }]
}

async function handleCreateLocale() {
	if (props.readOnly) return
	const tag = createState.tag.trim()
	if (!tag) return
	creating.value = true
	createError.value = undefined

	try {
		await $fetch('/api/locales', {
			method: 'POST',
			body: {
				locale: tag,
				messages: {},
			},
		})
		createState.tag = ''
		isCreatingLocale.value = false
		feedback.success(t('locales.create.created', { locale: tag }))
		await fetchLocales()
		await selectLocale(tag)
		emit('localesChanged')
		emit('changed')
	}
	catch (err: unknown) {
		createError.value = feedback.error(err, t('locales.create.failed'))
	}
	finally {
		creating.value = false
	}
}

watch(() => props.defaultLocale, () => {
	fetchLocales()
}, { immediate: true })
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden text-xs text-default">
    <!-- Panel header -->
    <div class="flex items-center justify-between gap-2 border-b border-default p-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ t('locales.title') }}
        </h2>
        <p class="text-xs text-muted">
          {{ t('locales.subtitle') }}
        </p>
      </div>
      <UButton
        v-if="!readOnly"
        color="primary"
        variant="solid"
        size="xs"
        icon="i-lucide-plus"
        @click="openCreate()"
      >
        {{ t('locales.newLocale') }}
      </UButton>
    </div>

    <!-- Missing Workspace default locale -->
    <div
      v-if="isDefaultLocaleMissing"
      class="border-b border-default p-2"
    >
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="t('locales.defaultMissing.title')"
        :actions="readOnly ? [] : [{ label: t('locales.defaultMissing.action'), color: 'warning', variant: 'outline', size: 'xs', onClick: () => openCreate(defaultLocale || '') }]"
      >
        <template #description>
          <i18n-t
            keypath="locales.defaultMissing.description"
            tag="span"
            scope="global"
          >
            <template #locale>
              <code class="font-mono font-semibold">{{ defaultLocale }}</code>
            </template>
          </i18n-t>
        </template>
      </UAlert>
    </div>

    <!-- List load failure -->
    <div
      v-if="listError"
      class="border-b border-default p-2"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('locales.loadListFailed')"
        :description="listError.message"
        :actions="[{ label: t('common.retry'), color: 'error', variant: 'outline', size: 'xs', icon: 'i-lucide-refresh-cw', onClick: () => fetchLocales() }]"
      />
    </div>

    <!-- Workspace locale list -->
    <div class="border-b border-default p-2">
      <UListbox
        v-if="localeItems.length"
        :model-value="selectedLocaleKey || undefined"
        :items="localeItems"
        value-key="value"
        size="sm"
        :aria-label="t('locales.listLabel')"
        :ui="{
          content: 'max-h-36',
          item: 'data-[state=checked]:text-selection data-[state=checked]:before:bg-selection-subtle',
          itemLabel: 'font-mono font-medium',
          itemDescription: 'text-xs',
        }"
        @update:model-value="onSelectLocale"
      >
        <template #item-trailing="{ item }">
          <UBadge
            v-if="item.diagnosticCount"
            color="warning"
            variant="subtle"
            size="xs"
            icon="i-lucide-triangle-alert"
            :aria-label="t('locales.diagnosticCount', item.diagnosticCount)"
          >
            {{ fmt.number(item.diagnosticCount) }}
          </UBadge>
          <UBadge
            v-if="item.isDefault"
            color="neutral"
            variant="subtle"
            size="xs"
          >
            {{ t('locales.defaultBadge') }}
          </UBadge>
        </template>
      </UListbox>
      <UEmpty
        v-else-if="loadingList"
        size="sm"
        variant="naked"
        loading
        :title="t('common.loading')"
      />
      <UEmpty
        v-else-if="!listError"
        size="sm"
        variant="naked"
        icon="i-lucide-languages"
        :title="t('locales.emptyTitle')"
        :description="readOnly ? t('locales.emptyDescriptionReadOnly') : t('locales.emptyDescription')"
      />
    </div>

    <!-- Detail load failure -->
    <div
      v-if="detailError"
      class="p-3"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('locales.loadDetailFailed')"
        :description="detailError.message"
        :actions="[{ label: t('common.retry'), color: 'error', variant: 'outline', size: 'xs', icon: 'i-lucide-refresh-cw', onClick: () => loadSelectedLocaleDetail() }]"
      />
    </div>

    <!-- Active locale: flat key/value editor -->
    <div
      v-if="selectedLocaleData"
      class="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <!-- Sub-header: locale, revision and search -->
      <div class="flex flex-col gap-2 border-b border-default bg-muted/40 p-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate font-mono font-semibold text-highlighted">{{ selectedLocaleData.key }}</span>
            <UTooltip :text="selectedLocaleData.revision">
              <UBadge
                color="neutral"
                variant="subtle"
                size="xs"
                class="shrink-0 font-mono"
              >
                {{ t('common.revision') }} {{ selectedLocaleData.revision.slice(0, 12) }}…
              </UBadge>
            </UTooltip>
          </div>
          <UBadge
            v-if="!readOnly && isDirty"
            color="warning"
            variant="subtle"
            size="xs"
            icon="i-lucide-pencil"
            class="shrink-0"
          >
            {{ t('locales.unsaved') }}
          </UBadge>
        </div>
        <UInput
          v-model="searchQuery"
          size="xs"
          icon="i-lucide-search"
          :placeholder="t('locales.searchPlaceholder')"
          :aria-label="t('locales.searchLabel')"
          class="w-full"
        />
      </div>

      <!-- Stale revision conflict -->
      <div
        v-if="conflict"
        class="border-b border-default p-2"
      >
        <UAlert
          color="error"
          variant="subtle"
          icon="i-lucide-git-compare"
          :title="t('locales.conflict.title')"
          :description="t('locales.conflict.description')"
          :actions="[{ label: t('common.reload'), color: 'error', variant: 'outline', size: 'xs', icon: 'i-lucide-refresh-cw', onClick: () => reloadAfterConflict() }]"
        />
      </div>

      <!-- Messages -->
      <div class="flex-1 overflow-y-auto p-3">
        <div
          v-if="filteredMessages.length"
          class="flex flex-col gap-2.5"
        >
          <UFormField
            v-for="msg in filteredMessages"
            :key="msg.key"
            :label="msg.key"
            size="xs"
            :ui="{ label: 'block truncate font-mono text-xs text-toned', labelWrapper: 'gap-1' }"
          >
            <template
              v-if="!readOnly"
              #hint
            >
              <UTooltip :text="t('locales.removeKey')">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-x"
                  :aria-label="t('locales.removeKeyLabel', { key: msg.key })"
                  @click="removeMessageRow(msg.key)"
                />
              </UTooltip>
            </template>
            <UTextarea
              v-model="msg.value"
              :readonly="readOnly"
              size="xs"
              autoresize
              :rows="1"
              :maxrows="6"
              :placeholder="t('locales.valuePlaceholder')"
              class="w-full"
            />
          </UFormField>
        </div>

        <UEmpty
          v-else
          size="sm"
          variant="naked"
          :icon="searchQuery.trim() ? 'i-lucide-search-x' : 'i-lucide-file-text'"
          :title="searchQuery.trim() ? t('locales.noMatches') : t('locales.noMessages')"
        />
      </div>

      <!-- Add key and save -->
      <div class="flex flex-col gap-2 border-t border-default bg-muted/40 p-3">
        <div
          v-if="!readOnly"
          class="grid grid-cols-2 gap-2"
        >
          <UFormField
            :label="t('locales.newKeyLabel')"
            size="xs"
          >
            <UInput
              v-model="newKeyInput"
              size="xs"
              placeholder="new.translation.key"
              class="w-full font-mono"
              @keydown.enter.prevent="addMessageRow"
            />
          </UFormField>
          <UFormField
            :label="t('locales.newValueLabel')"
            size="xs"
          >
            <UInput
              v-model="newValueInput"
              size="xs"
              :placeholder="t('locales.valuePlaceholder')"
              class="w-full"
              @keydown.enter.prevent="addMessageRow"
            />
          </UFormField>
        </div>

        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-muted">
            {{ t('locales.stringCount', localMessages.length) }}
          </span>
          <div
            v-if="!readOnly"
            class="flex items-center gap-1.5"
          >
            <UButton
              color="neutral"
              variant="outline"
              size="xs"
              icon="i-lucide-plus"
              :disabled="!newKeyInput.trim()"
              @click="addMessageRow"
            >
              {{ t('locales.addKey') }}
            </UButton>
            <UButton
              color="primary"
              variant="solid"
              size="xs"
              icon="i-lucide-save"
              :loading="saving"
              @click="handleSaveLocale"
            >
              {{ saving ? t('common.saving') : t('common.save') }}
            </UButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty detail state -->
    <div
      v-else-if="!loadingList && !detailError && localeItems.length"
      class="flex flex-1 items-center justify-center p-6"
    >
      <UEmpty
        size="sm"
        variant="naked"
        icon="i-lucide-mouse-pointer-click"
        :title="t('locales.selectPrompt')"
        :loading="loadingDetail"
      />
    </div>

    <!-- Create Workspace locale -->
    <UModal
      v-if="!readOnly"
      v-model:open="isCreatingLocale"
      :title="t('locales.create.title')"
      :description="t('locales.create.description')"
    >
      <template #body>
        <UForm
          :state="createState"
          :validate="validateCreate"
          class="flex flex-col gap-3"
          @submit="handleCreateLocale"
        >
          <UFormField
            name="tag"
            :label="t('locales.create.tagLabel')"
            :help="t('locales.create.tagHelp')"
            required
          >
            <UInput
              v-model="createState.tag"
              size="sm"
              placeholder="zh-TW"
              class="w-full font-mono"
            />
          </UFormField>

          <UAlert
            v-if="createError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="t('locales.create.failed')"
            :description="createError.message"
          >
            <template
              v-if="createError.diagnostics.length"
              #description
            >
              <p>{{ createError.message }}</p>
              <ul class="mt-1 list-disc ps-4">
                <li
                  v-for="(diag, index) in createError.diagnostics"
                  :key="index"
                >
                  <span
                    v-if="diag.path"
                    class="font-mono"
                  >{{ diag.path }}: </span>{{ diag.message }}
                </li>
              </ul>
            </template>
          </UAlert>

          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              @click="isCreatingLocale = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              color="primary"
              variant="solid"
              size="sm"
              :loading="creating"
            >
              {{ t('common.create') }}
            </UButton>
          </div>
        </UForm>
      </template>
    </UModal>
  </div>
</template>
