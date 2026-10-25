<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useHistoryLabels } from '../../composables/useHistoryLabels'
import { groupImpacts, shortId, type ImpactGroup, type ReceivedImpact } from '../../utils/version-restore'

/**
 * The impact list of a change that would leave references dangling, grouped as the confirmation
 * shows it (Rules 01a11a5e-174b-… and 17a0-…; the destructive changes of issue #75 list the same
 * items). Shared by the restore dialog and by every change that asks the person to acknowledge an
 * impact before the server writes. IDs are shortened; the full value is in an item's `title`.
 */
const props = defineProps<{ impacts: readonly ReceivedImpact[] }>()

const { t } = useI18n()
const labels = useHistoryLabels()
const groups = computed(() => groupImpacts(props.impacts))

function viewName(id: unknown): string {
	return typeof id === 'string' ? labels.resourceName({ kind: 'view', key: id }) : '?'
}
function flowName(id: unknown): string {
	return typeof id === 'string' ? labels.resourceName({ kind: 'flow', key: id }) : '?'
}
function text(value: unknown): string {
	return typeof value === 'string' ? value : '?'
}
function threads(ids: unknown): string {
	return Array.isArray(ids) ? ids.map(id => shortId(String(id))).join(t('common.listSeparator')) : ''
}

/** One impact item as a sentence. */
function describeImpact(item: ReceivedImpact): string {
	const value = item as Readonly<Record<string, unknown>>
	const anchor = (value.anchor ?? {}) as Readonly<Record<string, unknown>>
	switch (item.category) {
		case 'review_anchor_invalidated':
			return t('history.restore.impact.item.anchorInvalidated', { thread: shortId(text(value.reviewId)), widget: text(anchor.widgetId), view: viewName(anchor.viewId) })
		case 'review_anchor_revalidated':
			return t('history.restore.impact.item.anchorRevalidated', { thread: shortId(text(value.reviewId)), widget: text(anchor.widgetId), view: viewName(anchor.viewId) })
		case 'review_variant_stale':
			return t('history.restore.impact.item.variantStale', { thread: shortId(text(value.reviewId)), variants: Array.isArray(value.variantNames) ? value.variantNames.join(t('common.listSeparator')) : '', view: viewName(value.viewId) }, Array.isArray(value.variantNames) ? value.variantNames.length : 1)
		case 'i18n_reference_dangling':
			return t('history.restore.impact.item.textKey', { key: text(value.i18nKey), view: viewName(value.viewId) })
		case 'asset_reference_dangling':
			return t('history.restore.impact.item.asset', { asset: labels.resourceName({ kind: 'asset', key: text(value.assetId) }), view: viewName(value.viewId) })
		case 'flow_step_widget_missing':
			return t('history.restore.impact.item.flowStep', { flow: flowName(value.flowId), step: text(value.stepId), widgets: Array.isArray(value.widgetIds) ? value.widgetIds.join(t('common.listSeparator')) : '', view: viewName(value.viewId) })
		case 'flow_step_target_missing':
			return value.missing === 'variant'
				? t('history.restore.impact.item.flowTargetVariant', { flow: flowName(value.flowId), step: text(value.stepId), variant: text(value.variantName), view: viewName(value.viewId) })
				: t('history.restore.impact.item.flowTargetView', { flow: flowName(value.flowId), step: text(value.stepId), view: viewName(value.viewId) })
		case 'view_reference_dangling':
			return value.missing === 'variant'
				? t('history.restore.impact.item.referenceVariant', { view: viewName(value.viewId), variant: text(value.variantName), target: viewName(value.targetViewId) })
				: t('history.restore.impact.item.referenceView', { view: viewName(value.viewId), target: viewName(value.targetViewId) })
		case 'view_decision_removed':
			return t(`history.restore.impact.item.decision.${text(value.status)}`, { question: text(value.question), view: viewName(value.viewId) })
		case 'submission_revision_not_current':
		case 'submission_revision_current': {
			const resource = (value.resource ?? {}) as Readonly<Record<string, unknown>>
			const named = { kind: text(resource.kind), key: text(resource.key) }
			return t(item.category === 'submission_revision_current' ? 'history.restore.impact.item.submissionCurrent' : 'history.restore.impact.item.submissionNotCurrent', {
				thread: shortId(text(value.reviewId)),
				kind: labels.kindLabel(named.kind),
				resource: labels.resourceName(named),
			})
		}
		case 'render_key_removed': {
			const ids = Array.isArray(value.reviewIds) ? value.reviewIds : []
			const key = value.dimension === 'theme' ? 'history.restore.impact.item.themeRemoved' : 'history.restore.impact.item.viewportRemoved'
			return `${t(key, { key: text(value.key) })} ${ids.length ? t('history.restore.impact.item.namedBy', { threads: threads(ids) }, ids.length) : t('history.restore.impact.item.namedByNone')}`
		}
		case 'evidence_stale':
			return typeof value.viewId === 'string'
				? t('history.restore.impact.item.evidenceForView', { evidence: shortId(text(value.evidence)), view: viewName(value.viewId) })
				: t('history.restore.impact.item.evidence', { evidence: shortId(text(value.evidence)) })
		default:
			return t('history.restore.impact.item.other', { category: item.category })
	}
}

/** The full identifiers an item names, for its tooltip. */
function impactIds(item: ReceivedImpact): string | undefined {
	const value = item as Readonly<Record<string, unknown>>
	const ids = [value.reviewId, value.evidence, ...(Array.isArray(value.reviewIds) ? value.reviewIds : [])].filter((id): id is string => typeof id === 'string')
	return ids.length ? ids.join(', ') : undefined
}

function groupLabel(group: ImpactGroup): string {
	return t(`history.restore.impact.group.${group}`)
}
</script>

<template>
  <div class="space-y-3">
    <section
      v-for="entry in groups"
      :key="entry.group"
      class="space-y-1"
      :data-impact-group="entry.group"
    >
      <h3 class="text-xs font-medium text-highlighted">
        {{ groupLabel(entry.group) }}
      </h3>
      <ul class="space-y-1">
        <li
          v-for="(item, index) in entry.items"
          :key="index"
          class="rounded-md border border-default px-2 py-1.5 text-xs text-default"
          :title="impactIds(item)"
          data-impact-item
          :data-category="item.category"
        >
          {{ describeImpact(item) }}
        </li>
      </ul>
    </section>
  </div>
</template>
