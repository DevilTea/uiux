<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from '#imports'
import type { FetchErrorDiagnostic } from '../../utils/fetch-error'

/**
 * The "Details" disclosure of an error state (brief h, section 3): the exact diagnostic codes and
 * paths, collapsed by default so the plain-words message leads. Codes stay untranslated mono.
 */
defineProps<{ diagnostics: readonly FetchErrorDiagnostic[]; statusCode?: number }>()

const { t } = useI18n()
const open = ref(false)
</script>

<template>
  <UCollapsible
    v-if="diagnostics.length || statusCode"
    v-model:open="open"
    class="w-full text-start"
    data-error-details
  >
    <UButton
      color="neutral"
      variant="link"
      size="xs"
      class="px-0"
      :trailing-icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
      :label="t('common.details')"
    />
    <template #content>
      <ul class="mt-1 space-y-1.5 text-xs text-muted">
        <li v-if="statusCode">
          <span class="font-mono text-toned">HTTP {{ statusCode }}</span>
        </li>
        <li
          v-for="diagnostic in diagnostics"
          :key="`${diagnostic.code}\u0000${diagnostic.path}\u0000${diagnostic.message}`"
          class="break-words"
        >
          <span
            v-if="diagnostic.code"
            class="font-mono text-toned"
            translate="no"
          >{{ diagnostic.code }}</span>
          <span
            v-if="diagnostic.path"
            class="ms-1 font-mono text-dimmed"
            translate="no"
          >{{ diagnostic.path }}</span>
          <span class="block">{{ diagnostic.message }}</span>
        </li>
      </ul>
    </template>
  </UCollapsible>
</template>
