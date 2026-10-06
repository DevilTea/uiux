<script setup lang="ts">
import { computed } from 'vue'
import { diagnosticText } from '../../utils/diagnostic-copy'
import type { FetchErrorDetails } from '../../utils/fetch-error'
import WbErrorDetails from '../workbench/WbErrorDetails.vue'

/**
 * Server rejection of a save (brief h, "Validation rejected"): the first message as the
 * description, then every diagnostic with its JSON Pointer path in mono, each in the UI language
 * (`utils/diagnostic-copy.ts`). The exact codes and the server's own words stay in Details.
 */
const props = defineProps<{ title: string; error: FetchErrorDetails }>()
const emit = defineEmits<{ close: [] }>()

const listed = computed(() => props.error.diagnostics.length > 1 || (props.error.diagnostics[0] && diagnosticText(props.error.diagnostics[0]) !== props.error.message))
</script>

<template>
  <UAlert
    color="error"
    variant="subtle"
    icon="i-lucide-circle-alert"
    role="alert"
    :title="title"
    close
    @update:open="(open: boolean) => { if (!open) emit('close') }"
  >
    <template #description>
      <p>{{ error.message }}</p>
      <ul
        v-if="listed"
        class="mt-1 space-y-1"
      >
        <li
          v-for="(diagnostic, index) in error.diagnostics"
          :key="index"
          class="break-words"
        >
          <code
            v-if="diagnostic.path"
            class="me-1 font-mono text-xs"
          >{{ diagnostic.path }}</code>{{ diagnosticText(diagnostic) }}
        </li>
      </ul>
      <WbErrorDetails
        :diagnostics="error.diagnostics"
        :status-code="error.statusCode"
      />
    </template>
  </UAlert>
</template>
