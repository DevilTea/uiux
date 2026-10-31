<script setup lang="ts">
import { nextTick, useTemplateRef } from 'vue'
import { useI18n } from '#imports'
import KitButton from '~/components/kit/ui/Button.vue'
import type { ReceivedImpact } from '../../utils/version-restore'
import ImpactList from './ImpactList.vue'

/**
 * The confirmation a write asks for when the server lists a reference impact and has written
 * nothing (`impact_acknowledgement_required`, Clause 01a172ce-bdef-7cf6-bf8c-770dc9dd5e34; Rule
 * 01a172ce-31eb-7b81-afd6-ddd6855cc30e). The caller resends its write with `acknowledgeImpact: true`
 * only from `confirm`. Focus starts on Cancel, the safe choice.
 */
const open = defineModel<boolean>('open', { required: true })
defineProps<{
	title: string
	body: string
	impacts: readonly ReceivedImpact[]
	confirmLabel: string
	submitting?: boolean
}>()
const emit = defineEmits<{ confirm: [] }>()
const { t } = useI18n()

const cancelButton = useTemplateRef<{ $el?: HTMLElement }>('cancelButton')

function focusCancel(event: Event): void {
	event.preventDefault()
	void nextTick(() => cancelButton.value?.$el?.focus())
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :dismissible="!submitting"
    :content="{ onOpenAutoFocus: focusCancel }"
  >
    <template #body>
      <div
        class="space-y-3"
        data-impact-dialog
      >
        <p class="text-sm text-default">
          {{ body }}
        </p>
        <p class="text-xs font-medium text-muted">
          {{ t('history.restore.impact.count', impacts.length) }}
        </p>
        <ImpactList :impacts="impacts" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <KitButton
          ref="cancelButton"
          variant="outline"
          :disabled="submitting"
          :label="t('common.cancel')"
          data-impact-cancel
          @click="open = false"
        />
        <KitButton
          variant="primary"
          :loading="submitting"
          :label="confirmLabel"
          data-impact-acknowledge
          @click="emit('confirm')"
        />
      </div>
    </template>
  </UModal>
</template>
