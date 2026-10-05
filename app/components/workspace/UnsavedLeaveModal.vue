<script setup lang="ts">
import { useI18n } from '#imports'

/** "Leave without saving?" for the Workspace authoring pages (brief g, section 7). */
const open = defineModel<boolean>('open', { required: true })
defineProps<{ count: number }>()
const emit = defineEmits<{ leave: []; stay: [] }>()
const { t } = useI18n()
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('authoring.leave.title')"
    :description="t('authoring.leave.description', { n: count }, count)"
    :dismissible="false"
    :close="false"
  >
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          @click="emit('stay')"
        >
          {{ t('authoring.leave.stay') }}
        </UButton>
        <UButton
          color="error"
          variant="soft"
          @click="emit('leave')"
        >
          {{ t('authoring.leave.discard') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
