<script setup lang="ts">
import { nextTick, onMounted, ref, useId } from 'vue'
import { useI18n } from '#imports'

/**
 * The inline confirm for "Delete comment" (retract addendum decision 8): it replaces the bubble
 * footer or the detail's action row, never a browser `confirm()`. Focus lands on Cancel, `Esc`
 * cancels, `Enter` on Delete confirms; while the request runs both buttons are disabled and
 * Delete shows a spinner. The destructive color (`error`, soft) appears only in this confirm.
 */
const props = withDefaults(defineProps<{ busy?: boolean; compact?: boolean; error?: string }>(), { busy: false, compact: false, error: undefined })
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

const { t } = useI18n()
const id = useId()
const root = ref<HTMLElement>()

/** Focus starts on Cancel: the safe default for an irreversible act. */
function focusCancel(): void {
	root.value?.querySelector<HTMLElement>('[data-retract-cancel]')?.focus()
}
onMounted(() => { void nextTick(focusCancel) })
// Opened from a menu, the menu closes after this mounts; its close hook calls focusCancel again.
defineExpose({ focusCancel })

function onKeydown(event: KeyboardEvent): void {
	if (event.key !== 'Escape' || props.busy) return
	event.preventDefault()
	event.stopPropagation()
	emit('cancel')
}
</script>

<template>
  <div
    ref="root"
    class="grid gap-2 rounded-md bg-muted p-2.5"
    role="group"
    :aria-labelledby="`${id}-title`"
    :aria-describedby="`${id}-body`"
    data-retract-confirm
    @keydown="onKeydown"
  >
    <p
      :id="`${id}-title`"
      class="text-sm font-semibold text-highlighted"
    >
      {{ t('comments.deleteConfirmTitle') }}
    </p>
    <p
      :id="`${id}-body`"
      class="text-xs text-muted"
    >
      {{ t('comments.deleteConfirmBody') }}
    </p>
    <p
      v-if="error"
      class="text-xs text-error"
      role="alert"
      data-retract-error
    >
      {{ error }}
    </p>
    <div class="flex justify-end gap-2">
      <UButton
        color="neutral"
        variant="outline"
        :size="compact ? 'xs' : 'sm'"
        :disabled="busy"
        :label="t('comments.deleteCancel')"
        data-retract-cancel
        @click="emit('cancel')"
      />
      <UButton
        color="error"
        variant="soft"
        :size="compact ? 'xs' : 'sm'"
        icon="i-lucide-trash-2"
        :loading="busy"
        :disabled="busy"
        :label="t('comments.deleteConfirm')"
        data-retract-delete
        @click="emit('confirm')"
      />
    </div>
  </div>
</template>
