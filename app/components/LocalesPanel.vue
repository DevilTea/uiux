<script setup lang="ts">
import { computed, ref, watch } from 'vue'

interface LocaleSummary {
	kind: 'locale'
	key: string
	revision: string
	diagnosticCount: number
	summary: { messageCount?: number }
}

interface LocaleDiscoveryPage {
	items: readonly LocaleSummary[]
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
}>()

const emit = defineEmits<{
	(e: 'localesChanged'): void
}>()

const locales = ref<readonly LocaleSummary[]>([])
const selectedLocaleKey = ref<string>('')
const selectedLocaleData = ref<LocaleRead>()
const loadingList = ref(false)
const loadingDetail = ref(false)
const localeLoadSequence = ref(0)
const error = ref<string>()

const searchQuery = ref('')
const saving = ref(false)
const conflict = ref(false)
const saveSuccess = ref(false)

// In-progress edit state: array of { key: string, value: string }
const localMessages = ref<Array<{ key: string; value: string }>>([])
const newKeyInput = ref('')
const newValueInput = ref('')

// Create locale modal / form
const isCreatingLocale = ref(false)
const newLocaleTag = ref('')
const createError = ref<string>()
const creating = ref(false)

const isDefaultLocaleMissing = computed(() => {
	if (!props.defaultLocale) return false
	return !locales.value.some(l => l.key === props.defaultLocale)
})

const filteredMessages = computed(() => {
	const q = searchQuery.value.trim().toLowerCase()
	if (!q) return localMessages.value
	return localMessages.value.filter(m => m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q))
})

async function fetchLocales() {
	loadingList.value = true
	error.value = undefined
	try {
		const res = await $fetch<LocaleDiscoveryPage>('/api/resources/list', {
			method: 'POST',
			body: { kinds: ['locale'], limit: 100 },
		})
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
		error.value = err instanceof Error ? err.message : 'Failed to fetch locales'
	}
	finally {
		loadingList.value = false
	}
}

async function selectLocale(key: string) {
	selectedLocaleKey.value = key
	conflict.value = false
	saveSuccess.value = false
	error.value = undefined
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
	try {
		const data = await $fetch<LocaleRead>(`/api/resources/locale/${encodeURIComponent(key)}`)
		if (localeLoadSequence.value !== currentSeq) return
		selectedLocaleData.value = data
		localMessages.value = Object.entries(data.resource || {}).map(([k, v]) => ({ key: k, value: String(v) }))
	}
	catch (err: unknown) {
		if (localeLoadSequence.value !== currentSeq) return
		error.value = err instanceof Error ? err.message : 'Failed to load locale detail'
		selectedLocaleData.value = undefined
		localMessages.value = []
	}
	finally {
		if (localeLoadSequence.value === currentSeq)
			loadingDetail.value = false
	}
}

function addMessageRow() {
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

function removeMessageRow(index: number) {
	localMessages.value.splice(index, 1)
}

async function handleSaveLocale() {
	if (!selectedLocaleData.value) return
	saving.value = true
	error.value = undefined
	conflict.value = false
	saveSuccess.value = false

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
		saveSuccess.value = true
		await fetchLocales()
		emit('localesChanged')
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number; data?: { message?: string } }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) {
			conflict.value = true
		}
		else {
			error.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to save locale')
		}
	}
	finally {
		saving.value = false
	}
}

async function handleCreateLocale() {
	const tag = newLocaleTag.value.trim()
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
		newLocaleTag.value = ''
		isCreatingLocale.value = false
		await fetchLocales()
		await selectLocale(tag)
		emit('localesChanged')
	}
	catch (err: unknown) {
		const errorObj = err as { data?: { message?: string } }
		createError.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to create locale')
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
  <div class="flex h-full flex-col overflow-hidden text-xs text-neutral-200">
    <!-- Panel Header -->
    <div class="flex items-center justify-between border-b border-neutral-800 p-3">
      <div>
        <h2 class="text-sm font-semibold text-white">
          Locales
        </h2>
        <p class="text-[11px] text-neutral-400">
          Flat canonical i18n translation catalogs
        </p>
      </div>
      <UButton
        color="primary"
        variant="solid"
        size="xs"
        @click="isCreatingLocale = !isCreatingLocale"
      >
        + New Locale
      </UButton>
    </div>

    <!-- Missing Primary Default Locale Warning Banner -->
    <div
      v-if="isDefaultLocaleMissing"
      class="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-300 flex items-center justify-between"
    >
      <span class="text-[11px]">
        ⚠ Workspace defaultLocale "<span class="font-mono font-semibold">{{ defaultLocale }}</span>" is not yet authored!
      </span>
      <UButton
        color="warning"
        variant="soft"
        size="xs"
        @click="newLocaleTag = defaultLocale || ''; isCreatingLocale = true"
      >
        Create Now
      </UButton>
    </div>

    <!-- Create Locale inline form -->
    <div
      v-if="isCreatingLocale"
      class="border-b border-neutral-800 bg-neutral-900/80 p-3 space-y-2"
    >
      <div class="flex items-center justify-between">
        <span class="font-semibold text-white">Create New Locale</span>
        <button
          type="button"
          class="text-neutral-500 hover:text-neutral-300"
          @click="isCreatingLocale = false"
        >
          ✕
        </button>
      </div>
      <p class="text-[11px] text-neutral-400">
        Must be a canonical BCP 47 language tag (e.g. en-US, zh-TW, ja-JP).
      </p>
      <div class="flex gap-2">
        <UInput
          v-model="newLocaleTag"
          size="xs"
          placeholder="zh-TW"
          class="flex-1 font-mono"
        />
        <UButton
          color="primary"
          variant="solid"
          size="xs"
          :loading="creating"
          @click="handleCreateLocale"
        >
          Create
        </UButton>
      </div>
      <p
        v-if="createError"
        class="text-[11px] text-red-400"
      >
        {{ createError }}
      </p>
    </div>

    <!-- Locales list bar -->
    <div class="border-b border-neutral-800 bg-neutral-950 p-2">
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="loc in locales"
          :key="loc.key"
          type="button"
          class="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition"
          :class="selectedLocaleKey === loc.key ? 'bg-primary text-white font-medium shadow-sm' : 'bg-neutral-900 text-neutral-300 hover:bg-neutral-800'"
          @click="selectLocale(loc.key)"
        >
          <span class="font-mono">{{ loc.key }}</span>
          <span
            v-if="loc.key === defaultLocale"
            class="rounded bg-black/30 px-1 text-[9px] text-amber-300"
            title="Workspace default locale"
          >
            default
          </span>
          <span class="text-[10px] opacity-70">({{ loc.summary.messageCount || 0 }})</span>
        </button>
      </div>
      <div
        v-if="!locales.length && !loadingList"
        class="py-2 text-center text-xs text-neutral-500"
      >
        No authored locales. Click "+ New Locale" above.
      </div>
    </div>

    <!-- Active Locale Details & Flat Key/Value Editor -->
    <div
      v-if="selectedLocaleData"
      class="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <!-- Sub-header: Revision & Search -->
      <div class="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/40 p-2.5">
        <div class="flex items-center gap-2">
          <span class="font-mono font-semibold text-white">{{ selectedLocaleData.key }}</span>
          <span class="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
            Rev: {{ selectedLocaleData.revision.slice(0, 12) }}…
          </span>
        </div>
        <div class="w-48">
          <UInput
            v-model="searchQuery"
            size="xs"
            placeholder="Search keys/values…"
          />
        </div>
      </div>

      <!-- Conflict Banner -->
      <div
        v-if="conflict"
        class="border-b border-amber-500/30 bg-amber-500/10 p-2 text-amber-300 text-[11px] flex items-center justify-between"
      >
        <span>⚠ Stale revision conflict: This locale was modified by another operation.</span>
        <UButton
          color="warning"
          variant="soft"
          size="xs"
          @click="loadSelectedLocaleDetail"
        >
          Reload
        </UButton>
      </div>

      <div
        v-else-if="saveSuccess"
        class="border-b border-emerald-500/30 bg-emerald-500/10 p-2 text-emerald-300 text-[11px]"
      >
        ✓ Saved successfully.
      </div>

      <div
        v-else-if="error"
        class="border-b border-red-500/30 bg-red-500/10 p-2 text-red-300 text-[11px]"
      >
        {{ error }}
      </div>

      <!-- Messages Table / Flat Key-Value list -->
      <div class="flex-1 overflow-y-auto p-3 space-y-2">
        <div
          v-if="filteredMessages.length"
          class="space-y-1.5"
        >
          <div
            v-for="(msg, idx) in filteredMessages"
            :key="msg.key"
            class="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/60 p-1.5"
          >
            <div
              class="w-2/5 truncate font-mono text-[11px] text-neutral-300"
              :title="msg.key"
            >
              {{ msg.key }}
            </div>
            <div class="flex-1">
              <UInput
                v-model="msg.value"
                size="xs"
                placeholder="Translated text"
                class="w-full"
              />
            </div>
            <button
              type="button"
              class="text-neutral-500 hover:text-red-400 text-xs px-1"
              title="Delete key"
              @click="removeMessageRow(idx)"
            >
              ✕
            </button>
          </div>
        </div>

        <div
          v-else
          class="py-6 text-center text-xs text-neutral-500"
        >
          {{ searchQuery.trim() ? 'No matching keys found.' : 'No messages authored in this locale yet.' }}
        </div>
      </div>

      <!-- Add New Key Row & Save Actions -->
      <div class="border-t border-neutral-800 bg-neutral-950 p-3 space-y-2">
        <div class="flex items-center gap-2">
          <UInput
            v-model="newKeyInput"
            size="xs"
            placeholder="new.translation.key"
            class="w-2/5 font-mono"
            @keyup.enter="addMessageRow"
          />
          <UInput
            v-model="newValueInput"
            size="xs"
            placeholder="Translation text"
            class="flex-1"
            @keyup.enter="addMessageRow"
          />
          <UButton
            color="neutral"
            variant="outline"
            size="xs"
            @click="addMessageRow"
          >
            + Add
          </UButton>
        </div>

        <div class="flex items-center justify-between pt-1">
          <span class="text-[11px] text-neutral-500">
            Total {{ localMessages.length }} messages
          </span>
          <UButton
            color="primary"
            variant="solid"
            size="xs"
            :loading="saving"
            @click="handleSaveLocale"
          >
            Save Changes
          </UButton>
        </div>
      </div>
    </div>

    <!-- Empty Detail State -->
    <div
      v-else-if="!loadingList"
      class="flex flex-1 items-center justify-center p-6 text-center text-xs text-neutral-500"
    >
      Select a locale to inspect and edit messages.
    </div>
  </div>
</template>
