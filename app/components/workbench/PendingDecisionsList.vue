<script setup lang="ts">
import { useI18n } from '#imports'
import KitBadge from '~/components/kit/ui/Badge.vue'
import { usePendingDecisions } from '../../composables/usePendingDecisions'
import { viewLocation } from '../../utils/workbench-routes'
import type { PendingDecisionRow } from '../../utils/decisions'

/**
 * The Overview's Decisions tab: every pending Decision across the Views (Rule
 * 01a11544-5f18-77ac-b89e-56ced4056f19). Each entry opens its View on the Spec, selecting the
 * Variant and Widget the source thread is anchored to when they are known.
 */
const { t } = useI18n()
const { rows, loading, failed, reload } = usePendingDecisions()

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
        {{ t('decision.pendingList.title') }}
      </h2>
      <span
        class="text-sm text-muted tabular-nums"
        role="status"
      >{{ loading ? t('decision.pendingList.loading') : t('decision.pendingList.count', rows.length) }}</span>
    </div>

    <UAlert
      v-if="failed"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      role="alert"
      :title="t('decision.pendingList.failed')"
      :actions="[{ label: t('decision.pendingList.retry'), color: 'neutral', variant: 'outline', onClick: () => { void reload() } }]"
      data-pending-decisions-error
    />

    <ul
      v-else-if="rows.length"
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
          :aria-label="t('decision.pendingList.open', { question: row.decision.question, view: row.viewName || t('common.unnamed') })"
        >
          <span class="font-medium text-highlighted">{{ row.decision.question }}</span>
          <span class="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>{{ t('decision.pendingList.inView', { view: row.viewName || t('common.unnamed') }) }}</span>
            <KitBadge
              v-if="row.target.variant"
              variant="mono"
              translate="no"
              :label="row.target.variant"
            />
            <KitBadge
              v-if="row.target.widgetId"
              variant="mono"
              translate="no"
              :label="row.target.widgetId"
            />
          </span>
        </ULink>
      </li>
    </ul>
    <p
      v-else-if="!loading"
      class="rounded-md border border-dashed border-accented px-3 py-2 text-sm text-muted"
      data-pending-decisions-empty
    >
      {{ t('decision.pendingList.empty') }}
    </p>
  </section>
</template>
