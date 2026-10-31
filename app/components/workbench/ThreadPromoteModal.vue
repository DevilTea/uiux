<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from '#imports'
import KitButton from '~/components/kit/ui/Button.vue'
import KitField from '~/components/kit/ui/Field.vue'
import type { FetchErrorDetails } from '../../utils/fetch-error'
import type { PromoteForm } from '../../composables/useThreadActions'
import { promoteConflictTitleKey, type PromoteMoved } from '../../utils/promote-conflict'

/**
 * Promote to Decision, shared by the canvas bubble and the Reviews detail. It opens on the
 * thread's title as the question; a rejected promotion shows its error inside the dialog (not
 * behind it) and takes focus there. A conflict names what moved, the thread or the View, and keeps
 * the form for the user to confirm again (Rule 01a11544-611c-73e0-990b-c094b48b3eb6).
 */
const props = defineProps<{
	question?: string
	busy?: boolean
	error?: FetchErrorDetails
	conflict?: boolean
	/** Creating another Decision from a thread that already has one (`create_decision_from_review`). */
	another?: boolean
	/** The resources the conflict named, when the server listed them. */
	moved?: readonly PromoteMoved[]
	submit: (form: Readonly<PromoteForm>) => Promise<boolean>
}>()
const open = defineModel<boolean>('open', { required: true })

const { t } = useI18n()
const form = reactive<PromoteForm>({ question: '', summary: '', rationale: '' })
const failed = ref(false)
const movedTitleKey = computed(() => promoteConflictTitleKey(props.moved))
const conflictTitle = computed(() => movedTitleKey.value ? t(movedTitleKey.value) : t('comments.conflict'))
const conflictHint = computed(() => movedTitleKey.value ? t('reviews.promote.conflict.hint') : t('comments.conflictHint'))

watch(open, (value) => {
	if (!value) return
	failed.value = false
	form.question = props.question ?? ''
	form.summary = ''
	form.rationale = ''
})

async function onSubmit(): Promise<void> {
	// Enter in a field submits the form too; while a promotion is in flight it must not start a second.
	if (props.busy || !form.question.trim() || !form.summary.trim()) return
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
    :title="another ? t('reviews.promote.anotherTitle') : t('reviews.promote.title')"
    :description="another ? t('reviews.promote.anotherDescription') : t('reviews.promote.description')"
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
          :title="conflict ? conflictTitle : error?.message"
          :description="conflict ? conflictHint : undefined"
          :data-promote-moved="conflict && moved?.length ? moved.join(' ') : undefined"
          data-promote-error
        />
        <KitField
          v-model="form.question"
          :label="t('reviews.promote.questionLabel')"
          :placeholder="t('reviews.promote.questionPlaceholder')"
          required
        />
        <KitField
          v-model="form.summary"
          :label="t('reviews.promote.summaryLabel')"
          :placeholder="t('reviews.promote.summaryPlaceholder')"
          required
        />
        <KitField
          v-model="form.rationale"
          :label="t('reviews.promote.rationaleLabel')"
          :placeholder="t('reviews.promote.rationalePlaceholder')"
          :rows="2"
        />
        <div class="flex justify-end gap-2">
          <KitButton
            variant="ghost"
            :label="t('common.cancel')"
            @click="open = false"
          />
          <KitButton
            type="submit"
            variant="primary"
            :loading="busy"
            :disabled="!form.question.trim() || !form.summary.trim()"
            :label="another ? t('reviews.promote.anotherSubmit') : t('reviews.promote.submit')"
          />
        </div>
      </form>
    </template>
  </UModal>
</template>
