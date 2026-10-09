<script setup lang="ts">
import { computed, useId } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { useI18n } from '#imports'
import type { ComparedCurrent, ComparedVersion, ResourceSemanticChange } from '../../../src/application/services/history-diff'
import { CHANGE_ICONS, useHistoryLabels } from '../../composables/useHistoryLabels'
import { useVersionComparison } from '../../composables/useVersionHistory'
import { CURRENT_COMPARE, PARENT_COMPARE, resolveHistorySelection, sameResource, type ComparisonEndpoints, type HistoryAddress, type HistoryResourceRef, type HistorySelection } from '../../utils/version-history'
import ResourceDiff from './ResourceDiff.vue'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'

/**
 * A comparison (Rule 01a11a5e-11e0-7f39-84a7-fde3faa43340): the summary of every compared resource
 * first, then the semantic diff of each changed one. The selection lives in the address
 * (Rule 01a11a5e-1afd-79e8-bfe8-8c0eccfaa396), so the compare-with choices and the resource
 * choices are links built by the caller (`linkFor`). A View's canvas before and after is B9: the
 * `canvas` slot is where it goes, below that View's change list.
 */
const props = withDefaults(defineProps<{
	/** The address as written; it holds a `version` (`resolveHistorySelection` applies the defaults). */
	address: HistoryAddress
	endpoints: ComparisonEndpoints
	/** Only these resources are compared (the View page's panel compares its View). */
	requestResources?: readonly HistoryResourceRef[]
	/** The address of another selection: a different `compare` or `resource`. */
	linkFor: (address: HistoryAddress) => RouteLocationRaw
	/** The address without a selection: the timeline only. */
	closeTo: RouteLocationRaw
	/** From the View page: the same comparison in Overview's Activity, with every resource. */
	fullComparisonTo?: RouteLocationRaw
	/** The compared version's display title, when the caller knows it, for the other-version choice. */
	compareTitle?: string
}>(), { requestResources: () => [], fullComparisonTo: undefined, compareTitle: undefined })

defineSlots<{ canvas?: (props: { change: ResourceSemanticChange }) => unknown }>()

const { t } = useI18n()
const labels = useHistoryLabels()
const headingId = useId()

const selection = computed<HistorySelection>(() => resolveHistorySelection(props.address) ?? { version: '', compare: PARENT_COMPARE })
const comparison = useVersionComparison(() => props.endpoints, () => props.requestResources)
const result = computed(() => comparison.result.value)
const changed = computed(() => result.value?.summary.filter(row => row.status !== 'unchanged') ?? [])
const unchangedCount = computed(() => (result.value?.summary.length ?? 0) - changed.value.length)
const shownChanges = computed(() => (result.value?.changes ?? []).filter(change => !selection.value.resource || sameResource(change, selection.value.resource)))

function sideTitle(side: ComparedVersion | ComparedCurrent | null | undefined): string {
	if (!side) return t('history.compare.nothing')
	if (side.id === CURRENT_COMPARE) return t('history.compare.current')
	const version = side as ComparedVersion
	return version.type === 'checkpoint' && version.name ? version.name : t(`history.type.${version.type}`)
}

const targets = computed(() => {
	const list = [
		{ value: PARENT_COMPARE, label: t('history.compare.parent') },
		{ value: CURRENT_COMPARE, label: t('history.compare.current') },
	]
	if (selection.value.compare !== PARENT_COMPARE && selection.value.compare !== CURRENT_COMPARE)
		list.push({ value: selection.value.compare, label: props.compareTitle ? t('history.compare.otherNamed', { name: props.compareTitle }) : t('history.compare.other') })
	return list
})

/** The written address with one key changed; keys the reader never chose stay omitted. */
function addressWith(patch: Partial<HistoryAddress>): HistoryAddress {
	return { ...props.address, ...patch }
}

/** Selects one resource's diff, or all of them again when that resource is already selected. */
function resourceLink(resource: HistoryResourceRef): RouteLocationRaw {
	if (!sameResource(resource, props.address.resource)) return props.linkFor(addressWith({ resource }))
	const rest: Record<string, unknown> = { ...props.address }
	delete rest.resource
	return props.linkFor(rest as HistoryAddress)
}
</script>

<template>
  <section
    class="space-y-4"
    :aria-labelledby="headingId"
    data-version-comparison
    :data-from="endpoints.from"
    :data-to="endpoints.to"
    :aria-busy="comparison.loading.value || undefined"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0 space-y-1">
        <h3
          :id="headingId"
          class="text-sm font-semibold text-highlighted"
        >
          {{ t('history.compare.title') }}
        </h3>
        <p
          v-if="result"
          class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted"
          data-comparison-sides
        >
          <span class="truncate font-medium text-default">{{ sideTitle(result.from) }}</span>
          <time
            v-if="result.from && 'at' in result.from"
            :datetime="result.from.at"
          >{{ labels.dateTime(result.from.at) }}</time>
          <UIcon
            name="i-lucide-arrow-right"
            class="size-3.5 shrink-0"
          />
          <span class="sr-only">{{ t('history.compare.to') }}</span>
          <span class="truncate font-medium text-default">{{ sideTitle(result.to) }}</span>
          <time
            v-if="'at' in result.to"
            :datetime="result.to.at"
          >{{ labels.dateTime(result.to.at) }}</time>
        </p>
      </div>
      <UTooltip :text="t('history.compare.close')">
        <UButton
          :to="closeTo"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          :aria-label="t('history.compare.close')"
          data-comparison-close
        />
      </UTooltip>
    </div>

    <nav
      class="flex flex-wrap items-center gap-1.5"
      :aria-label="t('history.compare.against')"
      data-compare-targets
    >
      <span class="text-xs text-muted">{{ t('history.compare.against') }}</span>
      <UButton
        v-for="target in targets"
        :key="target.value"
        :to="linkFor(addressWith({ compare: target.value }))"
        size="xs"
        color="neutral"
        :variant="selection.compare === target.value ? 'solid' : 'outline'"
        :aria-current="selection.compare === target.value ? 'true' : undefined"
        :data-compare-target="target.value === PARENT_COMPARE || target.value === CURRENT_COMPARE ? target.value : 'version'"
        :label="target.label"
      />
    </nav>

    <UAlert
      v-if="comparison.error.value"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="comparison.error.value.message"
      :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => { void comparison.load() } }]"
    >
      <template #description>
        <WbErrorDescription
          :headline="comparison.error.value.message"
          :diagnostics="comparison.error.value.diagnostics"
          :status-code="comparison.error.value.statusCode"
        />
      </template>
    </UAlert>
    <div
      v-else-if="!result"
      class="space-y-2"
    >
      <USkeleton
        v-for="index in 3"
        :key="index"
        class="h-8 w-full"
        :aria-label="t('common.loading')"
      />
    </div>

    <template v-if="result">
      <section
        class="space-y-2"
        :aria-label="t('history.compare.summary')"
        data-comparison-summary
      >
        <h4 class="flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-muted">
          {{ t('history.compare.summary') }}
          <span class="font-normal">{{ t('history.compare.changedCount', changed.length) }}<template v-if="unchangedCount"> · {{ t('history.compare.unchangedCount', unchangedCount) }}</template></span>
        </h4>
        <p
          v-if="!result.from"
          class="text-xs text-muted"
        >
          {{ t('history.compare.noParent') }}
        </p>
        <p
          v-if="!changed.length"
          class="text-sm text-muted"
          data-comparison-same
        >
          {{ t('history.compare.noDifferences') }}
        </p>
        <ul
          v-else
          class="divide-y divide-(--ui-border) rounded-lg border border-default"
        >
          <li
            v-for="row in changed"
            :key="`${row.kind}:${row.key}`"
            :data-summary-row="`${row.kind}:${row.key}`"
            :data-status="row.status"
          >
            <ULink
              :to="resourceLink(row)"
              class="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted pointer-coarse:min-h-11"
              :class="sameResource(row, selection.resource) ? 'bg-elevated' : ''"
              :aria-current="sameResource(row, selection.resource) ? 'true' : undefined"
            >
              <UIcon
                :name="CHANGE_ICONS[row.status]!"
                class="size-4 shrink-0 text-muted"
              />
              <span class="w-20 shrink-0 text-xs text-muted">{{ t(`history.compare.status.${row.status}`) }}</span>
              <span class="shrink-0 text-xs text-muted">{{ labels.kindLabel(row.kind) }}</span>
              <span class="min-w-0 flex-1 truncate text-default">{{ labels.resourceName(row) }}</span>
            </ULink>
          </li>
        </ul>
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          <ULink
            v-if="selection.resource"
            :to="resourceLink(selection.resource)"
            class="text-xs text-default underline underline-offset-2"
            data-comparison-all
          >
            {{ t('history.compare.allResources') }}
          </ULink>
          <ULink
            v-if="fullComparisonTo"
            :to="fullComparisonTo"
            class="text-xs text-default underline underline-offset-2"
            data-comparison-full
          >
            {{ t('history.compare.openInActivity') }}
          </ULink>
        </div>
      </section>

      <article
        v-for="change in shownChanges"
        :key="`${change.kind}:${change.key}`"
        class="space-y-2 border-t border-default pt-3"
        :data-resource-diff="`${change.kind}:${change.key}`"
      >
        <h4 class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
          <UIcon
            :name="CHANGE_ICONS[change.status]!"
            class="size-4 shrink-0 text-muted"
          />
          <span class="text-xs text-muted">{{ t(`history.compare.status.${change.status}`) }}</span>
          <span class="text-xs text-muted">{{ labels.kindLabel(change.kind) }}</span>
          <span class="min-w-0 truncate font-medium text-highlighted">{{ labels.resourceName(change) }}</span>
        </h4>
        <ResourceDiff
          :diff="change.diff"
          :name="labels.resourceName(change)"
          :current-image-url="change.kind === 'asset' && endpoints.to === CURRENT_COMPARE ? `/api/assets/${encodeURIComponent(change.key)}/content` : undefined"
        />
        <!-- B9 seam: a View's canvas before and after (Rules 01a11a5e-1232…, 1288…, 12dc…) renders here. -->
        <slot
          v-if="change.kind === 'view'"
          name="canvas"
          :change="change"
        />
      </article>
    </template>
  </section>
</template>
