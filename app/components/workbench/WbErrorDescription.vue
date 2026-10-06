<script setup lang="ts">
import { computed } from 'vue'
import { diagnosticLines } from '../../utils/diagnostic-copy'
import type { FetchErrorDiagnostic } from '../../utils/fetch-error'
import WbErrorDetails from './WbErrorDetails.vue'

/**
 * The body of an error alert (brief h, section 3): the diagnostics in the UI language under the
 * headline, then the collapsed Details with the exact codes, paths and the server's own words.
 */
const props = defineProps<{
	headline: string
	diagnostics: readonly FetchErrorDiagnostic[]
	statusCode?: number
	/** Leading text before the diagnostic lines (e.g. the unreadable-thread explanation). */
	lead?: string
}>()

const text = computed(() => {
	const lead = props.lead && props.lead !== props.headline ? props.lead : ''
	const lines = diagnosticLines(props.headline, props.diagnostics).filter(line => line !== lead)
	return [lead, ...lines].filter(Boolean).join(' ')
})
</script>

<template>
  <div class="space-y-1">
    <p v-if="text">
      {{ text }}
    </p>
    <WbErrorDetails
      :diagnostics="diagnostics"
      :status-code="statusCode"
    />
  </div>
</template>
