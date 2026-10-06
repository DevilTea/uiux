<script setup lang="ts">
import { diagnosticText } from '../../utils/diagnostic-copy'
import type { FetchErrorDiagnostic } from '../../utils/fetch-error'
import WbErrorDetails from './WbErrorDetails.vue'

/**
 * A list of server or domain diagnostics, each with its JSON path (mono, never translated) and its
 * sentence in the UI language (`utils/diagnostic-copy.ts`). The exact codes and the server's own
 * words stay in the collapsed Details below.
 */
withDefaults(defineProps<{
	diagnostics: readonly FetchErrorDiagnostic[]
	statusCode?: number
	/** Show the collapsed Details disclosure below the list. */
	details?: boolean
}>(), { statusCode: undefined, details: true })
</script>

<template>
  <div class="space-y-1">
    <ul class="space-y-0.5">
      <li
        v-for="(diagnostic, index) in diagnostics"
        :key="index"
      >
        <span
          v-if="diagnostic.path"
          class="me-1 font-mono text-xs"
          translate="no"
        >{{ diagnostic.path }}</span>{{ diagnosticText(diagnostic) }}
      </li>
    </ul>
    <WbErrorDetails
      v-if="details"
      :diagnostics="diagnostics"
      :status-code="statusCode"
    />
  </div>
</template>
