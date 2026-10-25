<script setup lang="ts">
import { useI18n } from '#imports'
import { usePendingDecisions } from '../../composables/usePendingDecisions'
import { viewLocation } from '../../utils/workbench-routes'
import type { PendingDecisionRow } from '../../utils/decisions'

/**
 * The Overview's Decisions tab: every pending Decision across the Views (Rule
 * 01a11544-5f18-77ac-b89e-56ced4056f19). Each entry opens its View on the Spec, selecting the
 * Variant and Widget the source thread is anchored to when they are known.
 */
const { t } = useI18n()
const { rows, loading, failed } = usePendingDecisions()

function to(row: PendingDecisionRow) {
	return viewLocation(row.viewId, { panel: 'spec', ...(row.target.variant ? { variant: row.target.variant } : {}), ...(row.target.widgetId ? { widget: row.target.widgetId } : {}) })
}
</script>

<template>
  <section
    class="space-y-3"
    :aria-labelledby="'pending-decisions-heading'"
    data-pending-decisions
  >
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2
        id="pending-decisions-heading"
        class="text-title font-semibold text-highlighted"
      >
        {{ t('decision.pending.title') }}
      </h2>
      <span
        class="text-sm text-muted tabular-nums"
        role="status"
      >{{ loading ? t('decision.pending.loading') : t('decision.pending.count', rows.length) }}</span>
    </div>

    <ul
      v-if="rows.length"
      class="divide-y divide-default rounded-md border border-default"
    >
      <li
        v-for="row in rows"
        :key="`${row.viewId}:${row.decision.id}`"
        data-pending-decision
        :data-decision-id="row.decision.id"
      >
        <ULink
          :to="to(row)"
          class="grid gap-0.5 px-3 py-2.5 hover:bg-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary pointer-coarse:min-h-11"
          :aria-label="t('decision.pending.open', { question: row.decision.question, view: row.viewName || t('common.unnamed') })"
        >
          <span class="font-medium text-highlighted">{{ row.decision.question }}</span>
          <span class="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>{{ t('decision.pending.inView', { view: row.viewName || t('common.unnamed') }) }}</span>
            <UBadge
              v-if="row.target.variant"
              color="neutral"
              variant="soft"
              class="font-mono"
              translate="no"
            >{{ row.target.variant }}</UBadge>
            <UBadge
              v-if="row.target.widgetId"
              color="neutral"
              variant="soft"
              class="font-mono"
              translate="no"
            >{{ row.target.widgetId }}</UBadge>
          </span>
        </ULink>
      </li>
    </ul>
    <p
      v-else-if="!loading && !failed"
      class="rounded-md border border-dashed border-accented px-3 py-2 text-sm text-muted"
      data-pending-decisions-empty
    >
      {{ t('decision.pending.empty') }}
    </p>
  </section>
</template>
