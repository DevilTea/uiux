<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useRequirements } from '../../composables/useRequirements'
import type { ViewRequirementRow } from '../../utils/requirements'

/**
 * The requirement references a View or a UX Flow lists (Rule 01a18120-fe71-…), view-only: an ID, its
 * Rule text with a `spec` provider that was read, a link with a `url` provider (Rule
 * 01a18120-fc4e-…), and for a View the Variant behind each reference only a Variant lists. An ID the
 * provider lacks, or one nothing checks, says so.
 */
const props = defineProps<{ rows: readonly ViewRequirementRow[] }>()

const { t } = useI18n()
const requirements = useRequirements()
requirements.ensureLoaded()

const status = computed(() => requirements.coverage.value?.status)

function note(row: ViewRequirementRow): 'unresolved' | 'unverified' | undefined {
	if (requirements.hasSpecProvider.value) {
		if (status.value === 'ok') return requirements.unresolvedIds.value.has(row.id) ? 'unresolved' : undefined
		// Not read (yet, or unavailable): no ID is verified.
		return status.value === 'unavailable' ? 'unverified' : undefined
	}
	// No provider, or a `url` provider: nothing checks the ID (Rule 01a18120-fb3a-…).
	return 'unverified'
}
</script>

<template>
  <ul
    class="grid gap-2"
    :aria-label="t('requirements.listLabel')"
    data-requirement-refs
  >
    <li
      v-for="row in props.rows"
      :key="row.id"
      class="grid gap-0.5"
      :data-requirement-ref="row.id"
    >
      <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <a
          v-if="requirements.href(row.id)"
          :href="requirements.href(row.id)"
          target="_blank"
          rel="noopener noreferrer"
          class="min-w-0 break-all font-mono text-sm text-default underline decoration-(--ui-border-accented) underline-offset-2 hover:decoration-current"
          translate="no"
          :aria-label="t('requirements.open', { id: row.id })"
        >{{ row.id }}</a>
        <span
          v-else
          class="min-w-0 break-all font-mono text-sm text-highlighted"
          translate="no"
        >{{ row.id }}</span>
        <UBadge
          v-if="note(row) === 'unresolved'"
          color="warning"
          variant="subtle"
          icon="i-lucide-circle-help"
          data-requirement-note="unresolved"
        >
          {{ t('requirements.unresolved.badge') }}
        </UBadge>
        <UBadge
          v-else-if="note(row) === 'unverified'"
          color="neutral"
          variant="soft"
          data-requirement-note="unverified"
        >
          {{ t('requirements.unverified.badge') }}
        </UBadge>
        <UBadge
          v-for="variant in (row.fromView ? [] : row.variants)"
          :key="variant"
          color="neutral"
          variant="soft"
          data-requirement-variant
        >
          {{ t('requirements.viaVariant', { name: variant }) }}
        </UBadge>
      </span>
      <span
        v-if="requirements.statements.value.get(row.id)"
        class="text-sm text-muted"
        data-requirement-statement
      >{{ requirements.statements.value.get(row.id) }}</span>
    </li>
  </ul>
</template>
