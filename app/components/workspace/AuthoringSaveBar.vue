<script setup lang="ts">
import { useI18n } from '#imports'
import KitButton from '~/components/kit/ui/Button.vue'

/** Section footer while a draft exists: "{n} unsaved · Discard · Save" (brief g, section 7). */
defineProps<{
	count: number
	saving?: boolean
	disabled?: boolean
	saveLabel?: string
	note?: string
}>()
const emit = defineEmits<{ discard: []; save: [] }>()
const { t } = useI18n()
</script>

<template>
  <div
    class="flex flex-wrap items-center justify-end gap-x-3 gap-y-2"
    data-save-bar
  >
    <p
      v-if="note"
      class="me-auto text-xs text-muted"
    >
      {{ note }}
    </p>
    <span
      class="text-xs text-muted"
      role="status"
    >{{ t('settings.unsaved', { n: count }, count) }}</span>
    <KitButton
      variant="ghost"
      :disabled="saving"
      @click="emit('discard')"
    >
      {{ t('authoring.discard') }}
    </KitButton>
    <KitButton
      variant="primary"
      :loading="saving"
      :disabled="disabled"
      @click="emit('save')"
    >
      {{ saveLabel || t('authoring.saveChanges') }}
    </KitButton>
  </div>
</template>
