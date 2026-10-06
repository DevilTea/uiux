<script setup lang="ts">
import type { FetchErrorDetails } from '../../utils/fetch-error'

/**
 * Server rejection of a save (brief h, "Validation rejected"): the first message as the
 * description, then every diagnostic with its JSON Pointer path in mono.
 */
defineProps<{ title: string; error: FetchErrorDetails }>()
const emit = defineEmits<{ close: [] }>()
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
        v-if="error.diagnostics.length > 1 || (error.diagnostics[0] && error.diagnostics[0].message !== error.message)"
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
          >{{ diagnostic.path }}</code>{{ diagnostic.message }}
        </li>
      </ul>
    </template>
  </UAlert>
</template>
