<script setup lang="ts">
import { computed, nextTick, onMounted, shallowRef, useId, useTemplateRef, watch } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { useI18n } from '#imports'
import type { ComparedCurrent, ComparedVersion, ResourceSemanticChange } from '../../../src/application/services/history-diff'
import type { VersionRecord } from '../../../src/domain/history/schema'
import { CHANGE_ICONS, useHistoryLabels } from '../../composables/useHistoryLabels'
import { readVersionRecord, useOrderedEndpoints, useVersionDiff, useWorkbenchSignature } from '../../composables/useVersionHistory'
import { CURRENT_COMPARE, PARENT_COMPARE, resolveHistorySelection, sameResource, type HistoryAddress, type HistoryResourceRef, type HistorySelection } from '../../utils/version-history'
import { comparisonRefreshKey } from '../../utils/comparison-refresh'
import ResourceChange from './ResourceChange.vue'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'

/**
 * A comparison (Rule 01a11a5e-11e0-7f39-84a7-fde3faa43340): the summary of every compared resource
 * first, then the semantic diff of each changed one, read per resource when it is opened (the
 * selected resource, or the only changed one, opens at once). The selection lives in the address
 * (Rule 01a11a5e-1afd-79e8-bfe8-8c0eccfaa396), so the compare-with choices and the resource choices
 * are links built by the caller (`linkFor`). A View's canvas before and after is B9: the `canvas`
 * slot is where it goes, below that View's change list.
 */
const props = withDefaults(defineProps<{
	/** The address as written; it holds a `version` (`resolveHistorySelection` applies the defaults). */
	address: HistoryAddress
	/** Only these resources are compared (the View page's panel compares its View). */
	requestResources?: readonly HistoryResourceRef[]
	/** The address of another selection: a different `compare` or `resource`. */
	linkFor: (address: HistoryAddress) => RouteLocationRaw
	/** The address without a selection: the timeline only. */
	closeTo: RouteLocationRaw
	/** From the View page: the same comparison in Overview's Activity, with every resource. */
	fullComparisonTo?: RouteLocationRaw
	/** The newest listed version: a comparison with `current` is read again when it or the Workspace changes. */
	latestVersionId?: string
}>(), { requestResources: () => [], fullComparisonTo: undefined, latestVersionId: undefined })

defineSlots<{ canvas?: (props: { change: ResourceSemanticChange }) => unknown }>()

const { t } = useI18n()
const labels = useHistoryLabels()
const headingId = useId()
const heading = useTemplateRef<HTMLElement>('heading')

const selection = computed<HistorySelection>(() => resolveHistorySelection(props.address) ?? { version: '', compare: PARENT_COMPARE })
const ordered = useOrderedEndpoints(selection)
const endpoints = ordered.endpoints
const signature = useWorkbenchSignature()
const refreshKey = computed(() => comparisonRefreshKey(props.latestVersionId, signature.value))
const summary = useVersionDiff(endpoints, { resources: () => props.requestResources, detail: 'summary', refreshKey })
const result = computed(() => summary.result.value)
const changed = computed(() => result.value?.summary.filter(row => row.status !== 'unchanged') ?? [])
const unchangedCount = computed(() => (result.value?.summary.length ?? 0) - changed.value.length)
const shownRows = computed(() => changed.value.filter(row => !selection.value.resource || sameResource(row, selection.value.resource)))

/** The records of the two sides, for their titles (system Checkpoint names are localized by actor). */
const sideRecords = shallowRef(new Map<string, VersionRecord>())
watch(() => [result.value?.from?.id, result.value?.to.id].filter((id): id is string => !!id && id !== CURRENT_COMPARE).join(','), async (ids) => {
	for (const id of ids ? ids.split(',') : []) {
		if (sideRecords.value.has(id)) continue
		const read = await readVersionRecord(id).catch(() => undefined)
		if (read) sideRecords.value = new Map(sideRecords.value).set(id, read.version)
	}
}, { immediate: true })

function side(side: ComparedVersion | ComparedCurrent | null | undefined): { title: string; stored?: string } {
	if (!side) return { title: t('history.compare.nothing') }
	if (side.id === CURRENT_COMPARE) return { title: t('history.compare.current') }
	const version = side as ComparedVersion
	const record = sideRecords.value.get(version.id)
	if (record) return { title: labels.versionTitle(record), ...(labels.storedName(record) ? { stored: labels.storedName(record) } : {}) }
	return { title: version.type === 'checkpoint' && version.name ? version.name : t(`history.type.${version.type}`) }
}

const targets = computed(() => {
	const list = [
		{ value: PARENT_COMPARE, label: t('history.compare.parent') },
		{ value: CURRENT_COMPARE, label: t('history.compare.current') },
	]
	if (selection.value.compare !== PARENT_COMPARE && selection.value.compare !== CURRENT_COMPARE) {
		const other = ordered.compared.value
		list.push({ value: selection.value.compare, label: other ? t('history.compare.otherNamed', { name: labels.versionTitle(other) }) : t('history.compare.other') })
	}
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

/**
 * After the reader picks a version in the timeline, focus moves to the comparison heading so a
 * screen reader hears where the result is; a comparison opened from the address keeps the page's focus.
 */
function focusHeading(): void {
	void nextTick(() => heading.value?.focus())
}
onMounted(() => { if (document.activeElement?.closest('[data-version-timeline]')) focusHeading() })
watch(() => props.address.version, focusHeading)
</script>

<template>
  <section
    class="space-y-4"
    :aria-labelledby="headingId"
    data-version-comparison
    :data-from="endpoints?.from"
    :data-to="endpoints?.to"
    :aria-busy="summary.loading.value || !endpoints || undefined"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0 space-y-1">
        <h3
          :id="headingId"
          ref="heading"
          tabindex="-1"
          class="text-sm font-semibold text-highlighted"
          data-comparison-heading
        >
          {{ t('history.compare.title') }}
        </h3>
        <p
          v-if="result"
          class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted"
          data-comparison-sides
        >
          <span
            class="truncate font-medium text-default"
            :title="side(result.from).stored"
          >{{ side(result.from).title }}</span>
          <time
            v-if="result.from && 'at' in result.from"
            :datetime="result.from.at"
          >{{ labels.dateTime(result.from.at) }}</time>
          <UIcon
            name="i-lucide-arrow-right"
            class="size-3.5 shrink-0"
          />
          <span class="sr-only">{{ t('history.compare.to') }}</span>
          <span
            class="truncate font-medium text-default"
            :title="side(result.to).stored"
          >{{ side(result.to).title }}</span>
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
      v-if="summary.error.value"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="summary.error.value.message"
      :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => { void summary.load() } }]"
    >
      <template #description>
        <WbErrorDescription
          :headline="summary.error.value.message"
          :diagnostics="summary.error.value.diagnostics"
          :status-code="summary.error.value.statusCode"
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

      <ResourceChange
        v-for="row in shownRows"
        :key="`${endpoints?.from}:${endpoints?.to}:${row.kind}:${row.key}`"
        :row="row"
        :endpoints="endpoints!"
        :refresh-key="refreshKey"
        :selected-version="selection.version"
        :initially-open="!!selection.resource || changed.length === 1"
      >
        <template #canvas="{ change }">
          <slot
            name="canvas"
            :change="change"
          />
        </template>
      </ResourceChange>
    </template>
  </section>
</template>
