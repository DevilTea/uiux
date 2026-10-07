<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from '#imports'
import type { FetchErrorDetails } from '../../utils/fetch-error'
import type { PromoteForm } from '../../composables/useThreadActions'

/**
 * Promote to Decision, shared by the canvas bubble and the Reviews detail. It opens on the
 * thread's title as the question; a rejected promotion shows its error inside the dialog (not
 * behind it) and takes focus there.
 */
const props = defineProps<{
	question?: string
	busy?: boolean
	error?: FetchErrorDetails
	conflict?: boolean
	submit: (form: Readonly<PromoteForm>) => Promise<boolean>
}>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const form = reactive<PromoteForm>({ question: '', summary: '', rationale: '' })
const failed = ref(false)

watch(open, (value) => {
	if (!value) return
	failed.value = false
	form.question = props.question ?? ''
	form.summary = ''
	form.rationale = ''
})

async function onSubmit(): Promise<void> {
	if (!form.question.trim() || !form.summary.trim()) return
	if (await props.submit({ ...form })) {
		open.value = false
		return
	}
	failed.value = true
	await nextTick()
	document.querySelector<HTMLElement>('[data-promote-error]')?.focus()
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('reviews.promote.title')"
    :description="t('reviews.promote.description')"
  >
    <template #body>
      <form
        class="grid gap-3"
        @submit.prevent="onSubmit"
      >
        <UAlert
          v-if="failed && (error || conflict)"
          :color="conflict ? 'warning' : 'error'"
          variant="subtle"
          :icon="conflict ? 'i-lucide-refresh-cw' : 'i-lucide-circle-alert'"
          role="alert"
          tabindex="-1"
          :title="conflict ? t('comments.conflict') : error?.message"
          :description="conflict ? t('comments.conflictHint') : undefined"
          data-promote-error
        />
        <UFormField
          :label="t('reviews.promote.questionLabel')"
          required
        >
          <UInput
            v-model="form.question"
            class="w-full"
            :placeholder="t('reviews.promote.questionPlaceholder')"
          />
        </UFormField>
        <UFormField
          :label="t('reviews.promote.summaryLabel')"
          required
        >
          <UInput
            v-model="form.summary"
            class="w-full"
            :placeholder="t('reviews.promote.summaryPlaceholder')"
          />
        </UFormField>
        <UFormField :label="t('reviews.promote.rationaleLabel')">
          <UTextarea
            v-model="form.rationale"
            class="w-full"
            :rows="2"
            :placeholder="t('reviews.promote.rationalePlaceholder')"
          />
        </UFormField>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="open = false"
          />
          <UButton
            type="submit"
            color="primary"
            variant="solid"
            :loading="busy"
            :disabled="!form.question.trim() || !form.summary.trim()"
            :label="t('reviews.promote.submit')"
          />
        </div>
      </form>
    </template>
  </UModal>
</template>
