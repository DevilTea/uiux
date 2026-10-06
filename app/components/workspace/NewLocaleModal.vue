<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { isCanonicalLocaleTag } from '../../../src/domain/validation'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import AuthoringErrorAlert from './AuthoringErrorAlert.vue'
import { focusFirstProblem } from '../../utils/focus-problem'

/**
 * New Locale (brief g): a BCP 47 code and, optionally, the keys of an existing Locale to
 * start from. Copied keys start empty, so each one shows as a translation reminder.
 * Creates the file through `create_locale` (`POST /api/locales`).
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
	existing: readonly string[]
	/** Keys per existing Locale, for "Start with keys from". */
	keysOf: (locale: string) => readonly string[]
	initialTag?: string
}>()
const emit = defineEmits<{ created: [locale: string] }>()
const { t } = useI18n()

const NONE = '__none__'
const tag = ref('')
const source = ref(NONE)
const touched = ref(false)
const creating = ref(false)
const error = ref<FetchErrorDetails>()

watch(open, (value) => {
	if (!value) return
	tag.value = props.initialTag ?? ''
	source.value = props.existing[0] ?? NONE
	touched.value = false
	error.value = undefined
})

const tagError = computed(() => {
	if (!touched.value) return undefined
	const value: string = tag.value.trim()
	if (!value) return t('locales.create.tagRequired')
	if (!isCanonicalLocaleTag(value as unknown)) {
		let suggestion: string | undefined
		try { suggestion = Intl.getCanonicalLocales(value.replaceAll('_', '-'))[0] }
		catch { suggestion = undefined }
		return suggestion && suggestion !== value ? t('locales.create.tagSuggest', { tag: suggestion }) : t('locales.create.tagInvalid')
	}
	if (props.existing.includes(value)) return t('locales.create.tagExists', { tag: value })
	return undefined
})

const sourceItems = computed(() => [
	{ label: t('locales.create.startEmpty'), value: NONE },
	...props.existing.map(locale => ({ label: t('locales.create.keysFrom', { locale, n: props.keysOf(locale).length }, props.keysOf(locale).length), value: locale })),
])

async function create(): Promise<void> {
	touched.value = true
	if (tagError.value) void focusFirstProblem('[role="dialog"]')
	if (tagError.value || creating.value) return
	const locale = tag.value.trim()
	const messages: Record<string, string> = {}
	if (source.value !== NONE) for (const key of props.keysOf(source.value)) messages[key] = ''
	creating.value = true
	error.value = undefined
	try {
		await $fetch('/api/locales', { method: 'POST', body: { locale, messages } })
		open.value = false
		emit('created', locale)
	}
	catch (cause) {
		error.value = describeFetchError(cause, t('locales.create.failed'))
		void focusFirstProblem('[role="dialog"]')
	}
	finally {
		creating.value = false
	}
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('locales.create.title')"
    :description="t('locales.create.description')"
  >
    <template #body>
      <form
        class="flex flex-col gap-4"
        novalidate
        @submit.prevent="create"
      >
        <UFormField
          :label="t('locales.create.tagLabel')"
          :help="t('locales.create.tagHelp')"
          :error="tagError"
          required
        >
          <UInput
            v-model="tag"
            placeholder="zh-TW"
            autofocus
            :aria-invalid="!!tagError || undefined"
            class="w-full"
            :ui="{ base: 'font-mono' }"
            @blur="touched = true"
            @keydown.enter.prevent="create"
          />
        </UFormField>
        <UFormField
          v-if="existing.length"
          :label="t('locales.create.sourceLabel')"
          :help="t('locales.create.sourceHelp')"
        >
          <USelect
            v-model="source"
            :items="sourceItems"
            class="w-full"
          />
        </UFormField>
        <AuthoringErrorAlert
          v-if="error"
          :title="t('locales.create.failed')"
          :error="error"
          @close="error = undefined"
        />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          @click="open = false"
        >
          {{ t('common.cancel') }}
        </UButton>
        <UButton
          color="primary"
          variant="solid"
          :loading="creating"
          @click="create"
        >
          {{ t('locales.create.submit') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
