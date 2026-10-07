<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '#imports'

/**
 * The inline second step of a thread action that asks something first: Duplicate's reason
 * (required) or Reopen's (optional). Shared by the canvas bubble and the Reviews detail.
 * Enter confirms, Escape cancels.
 */
const props = withDefaults(defineProps<{ action: 'duplicate' | 'reopen'; busy?: boolean; size?: 'xs' | 'sm' }>(), { busy: false, size: 'sm' })
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
const reason = defineModel<string>({ required: true })

const { t } = useI18n()
const input = ref<{ inputRef?: HTMLInputElement }>()

/** Enter confirms like the button, which is disabled while the write is in flight: no second write. */
function confirm(): void {
	if (!props.busy) emit('confirm')
}

defineExpose({ focus: () => input.value?.inputRef?.focus() })
</script>

<template>
  <div
    class="grid gap-2 rounded-md bg-muted p-2"
    data-thread-reason
  >
    <UInput
      ref="input"
      v-model="reason"
      :size="props.size === 'xs' ? 'sm' : 'md'"
      :placeholder="action === 'duplicate' ? t('comments.duplicateReason') : t('comments.reopenReason')"
      :aria-label="action === 'duplicate' ? t('comments.duplicateReason') : t('comments.reopenReason')"
      :ui="{ base: 'pointer-coarse:text-base' }"
      @keydown.enter.prevent="confirm"
      @keydown.escape.stop="emit('cancel')"
    />
    <div class="flex justify-end gap-2">
      <UButton
        color="neutral"
        variant="ghost"
        :size="props.size"
        :label="t('common.cancel')"
        @click="emit('cancel')"
      />
      <UButton
        color="primary"
        variant="solid"
        :size="props.size"
        :disabled="action === 'duplicate' && !reason.trim()"
        :loading="busy"
        :label="action === 'duplicate' ? t('comments.resolveAsDuplicate') : t('thread.reopen')"
        data-thread-reason-confirm
        @click="emit('confirm')"
      />
    </div>
  </div>
</template>
