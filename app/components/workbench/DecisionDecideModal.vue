<script setup lang="ts">
import { reactive, watch } from 'vue'
import { useI18n } from '#imports'
import type { DecideForm } from '../../composables/useDecisionActions'

/**
 * Decide a Decision (issue #86): the outcome `{ summary, rationale }` the View Spec records. The
 * summary is required; an empty rationale repeats it, as promoting a thread does. A refusal is
 * reported by the caller and the dialog stays open with the entries kept.
 */
const props = defineProps<{
	question: string
	busy?: boolean
	lang?: string
	submit: (form: Readonly<DecideForm>) => Promise<boolean>
}>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const form = reactive<{ summary: string; rationale: string }>({ summary: '', rationale: '' })

watch(open, (value) => {
	if (!value) return
	form.summary = ''
	form.rationale = ''
})

async function onSubmit(): Promise<void> {
	// Enter in a field submits the form too; while a decision is in flight it must not start a second.
	if (props.busy || !form.summary.trim()) return
	if (await props.submit({ ...form })) open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('decision.decide.title')"
    :description="t('decision.decide.description')"
  >
    <template #body>
      <form
        class="grid gap-3"
        data-decide-form
        @submit.prevent="onSubmit"
      >
        <p
          class="text-sm font-medium text-highlighted"
          :lang="lang"
        >
          <span class="sr-only">{{ `${t('decision.decide.questionLabel')}: ` }}</span>{{ question }}
        </p>
        <UFormField
          :label="t('decision.decide.summaryLabel')"
          required
        >
          <UInput
            v-model="form.summary"
            class="w-full"
            autofocus
            :placeholder="t('decision.decide.summaryPlaceholder')"
            data-decide-summary
          />
        </UFormField>
        <UFormField :label="t('decision.decide.rationaleLabel')">
          <UTextarea
            v-model="form.rationale"
            class="w-full"
            :rows="2"
            :placeholder="t('decision.decide.rationalePlaceholder')"
            data-decide-rationale
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
            :disabled="!form.summary.trim()"
            :label="t('decision.decide.submit')"
            data-decide-submit
          />
        </div>
      </form>
    </template>
  </UModal>
</template>
