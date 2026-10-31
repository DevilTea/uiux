<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '#imports'
import type { RequirementCoverageEntry, RequirementReferrer, RequirementState } from '../../../src/application/services/requirements'
import KitBadge from '~/components/kit/ui/Badge.vue'
import KitButton from '~/components/kit/ui/Button.vue'
import { useRequirements } from '../../composables/useRequirements'
import { useWorkbench } from '../../composables/useWorkbench'
import { coverageShare, referrerLocation } from '../../utils/requirements'

/**
 * The Overview's Requirements tab, shown with a `spec` provider only (Rule 01a18120-feff-…): every
 * requirement of the provider as referenced, unreferenced or `noUi` with its reason, the unresolved IDs
 * and the coverage, each linked to the Views, Variants and UX Flows that reference it. View-only: an Agent
 * authors references and `noUi` through MCP. An unreadable provider is never shown as coverage (Rule
 * 01a1814f-8133-…): the tab says so and lists the referenced IDs as unverified.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const requirements = useRequirements()
requirements.ensureLoaded()
const { coverage, loading, failed } = requirements

type Filter = 'all' | RequirementState
const filter = ref<Filter>('all')

const share = computed(() => coverageShare(coverage.value))
const entries = computed(() => coverage.value?.requirements ?? [])
const shown = computed(() => filter.value === 'all' ? entries.value : entries.value.filter(entry => entry.state === filter.value))
const counts = computed(() => coverage.value?.counts)

const filters = computed(() => [
	{ value: 'all' as const, label: t('requirements.filter.all'), count: entries.value.length },
	{ value: 'referenced' as const, label: t('requirements.state.referenced'), count: counts.value?.referenced ?? 0 },
	{ value: 'unreferenced' as const, label: t('requirements.state.unreferenced'), count: counts.value?.unreferenced ?? 0 },
	{ value: 'noUi' as const, label: t('requirements.state.noUi'), count: counts.value?.noUi ?? 0 },
])

const STATE_BADGE: Record<RequirementState, { tone: 'success' | 'warning' | 'neutral'; icon: string }> = {
	referenced: { tone: 'success', icon: 'circle-check' },
	unreferenced: { tone: 'warning', icon: 'circle-dashed' },
	noUi: { tone: 'neutral', icon: 'ban' },
}

function viewName(viewId: string | undefined): string {
	return workbench.views.value.find(view => view.key === viewId)?.summary.name || t('common.unnamed')
}
function flowName(flowId: string | undefined): string {
	return workbench.flows.value.find(flow => flow.key === flowId)?.summary.name || t('common.unnamed')
}
function referrerLabel(referrer: RequirementReferrer): string {
	if (referrer.kind === 'flow') return t('requirements.kind.flow', { name: flowName(referrer.flowId) })
	if (referrer.kind === 'variant') return t('requirements.kind.variant', { variant: referrer.variantName ?? '', name: viewName(referrer.viewId) })
	return t('requirements.kind.view', { name: viewName(referrer.viewId) })
}
function referrerKey(referrer: RequirementReferrer): string {
	return [referrer.kind, referrer.viewId, referrer.variantName, referrer.flowId].join(':')
}

function rowAttributes(entry: RequirementCoverageEntry): Record<string, string> {
	return { 'data-requirement': entry.id, 'data-requirement-state': entry.state }
}
</script>

<template>
  <section
    class="space-y-4"
    aria-labelledby="overview-requirements-heading"
    data-overview-requirements
  >
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2
        id="overview-requirements-heading"
        class="text-title font-semibold text-highlighted"
      >
        {{ t('requirements.title') }}
      </h2>
      <span
        class="text-sm text-muted tabular-nums"
        role="status"
        data-requirements-coverage
      >
        <template v-if="loading && !coverage">{{ t('requirements.loading') }}</template>
        <template v-else-if="share">{{ t('requirements.coverage', share) }}</template>
        <template v-else-if="coverage?.status === 'ok'">{{ t('requirements.coverageNone') }}</template>
      </span>
    </div>

    <UAlert
      v-if="failed"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      role="alert"
      :title="t('requirements.loadFailed')"
      :actions="[{ label: t('requirements.retry'), color: 'neutral', variant: 'outline', onClick: () => { void requirements.load(true) } }]"
      data-requirements-error
    />

    <UAlert
      v-else-if="coverage?.status === 'unavailable'"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('requirements.unavailable.title')"
      :description="t('requirements.unavailable.body')"
      data-requirements-unavailable
    />

    <template v-if="coverage && coverage.status === 'ok'">
      <div
        role="group"
        :aria-label="t('requirements.filter.label')"
        class="flex flex-wrap items-center gap-1.5"
      >
        <KitButton
          v-for="item in filters"
          :key="item.value"
          size="sm"
          variant="outline"
          :pressed="filter === item.value"
          class="[&>span]:inline-flex [&>span]:items-center [&>span]:gap-1.5"
          :data-requirements-filter="item.value"
          @click="filter = item.value"
        >
          {{ item.label }}
          <span class="tabular-nums text-muted">{{ item.count }}</span>
        </KitButton>
        <span
          v-if="coverage.counts.unresolved"
          class="ms-auto text-sm text-warning tabular-nums"
          data-requirements-unresolved-count
        >{{ t('requirements.counts.unresolved', { n: coverage.counts.unresolved }) }}</span>
      </div>

      <ul
        v-if="shown.length"
        class="divide-y divide-default rounded-md border border-default"
        data-requirements-list
      >
        <li
          v-for="entry in shown"
          :key="entry.id"
          class="grid gap-1 px-3 py-2.5"
          v-bind="rowAttributes(entry)"
        >
          <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <KitBadge
              :tone="STATE_BADGE[entry.state].tone"
              :icon="STATE_BADGE[entry.state].icon"
              :label="t(`requirements.state.${entry.state}`)"
            />
            <span
              class="min-w-0 break-all font-mono text-xs text-muted"
              translate="no"
            >{{ entry.id }}</span>
          </span>
          <span class="text-sm text-default">{{ entry.statement }}</span>
          <span
            v-if="entry.reason"
            class="text-sm text-muted"
            data-requirement-reason
          >{{ t('requirements.reason', { reason: entry.reason }) }}</span>
          <span
            v-if="entry.referencedBy.length"
            class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
          >
            <span class="text-muted">{{ t('requirements.referencedBy') }}</span>
            <ULink
              v-for="referrer in entry.referencedBy"
              :key="referrerKey(referrer)"
              :to="referrerLocation(referrer)"
              class="text-default underline decoration-(--ui-border-accented) underline-offset-2 hover:decoration-current pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              data-requirement-referrer
            >{{ referrerLabel(referrer) }}</ULink>
          </span>
          <span
            v-else-if="entry.state !== 'noUi'"
            class="text-sm text-dimmed"
          >{{ t('requirements.notReferenced') }}</span>
        </li>
      </ul>
      <p
        v-else
        class="rounded-md border border-dashed border-accented px-3 py-2 text-sm text-muted"
        data-requirements-empty
      >
        {{ entries.length ? t('requirements.noMatch') : t('requirements.empty') }}
      </p>
    </template>

    <section
      v-if="coverage?.unresolved.length"
      class="space-y-2"
      aria-labelledby="overview-requirements-unresolved"
      data-requirements-unresolved
    >
      <h3
        id="overview-requirements-unresolved"
        class="text-sm font-semibold text-highlighted"
      >
        {{ t('requirements.unresolved.title') }}
      </h3>
      <p class="text-sm text-muted">
        {{ t('requirements.unresolved.hint') }}
      </p>
      <ul class="divide-y divide-default rounded-md border border-default">
        <li
          v-for="item in coverage.unresolved"
          :key="item.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
          :data-requirement-unresolved="item.id"
        >
          <span
            class="min-w-0 break-all font-mono text-xs text-default"
            translate="no"
          >{{ item.id }}</span>
          <ULink
            v-for="referrer in item.referencedBy"
            :key="referrerKey(referrer)"
            :to="referrerLocation(referrer)"
            class="text-sm text-default underline decoration-(--ui-border-accented) underline-offset-2 hover:decoration-current"
          >
            {{ referrerLabel(referrer) }}
          </ULink>
        </li>
      </ul>
    </section>

    <section
      v-if="coverage?.unverified.length"
      class="space-y-2"
      aria-labelledby="overview-requirements-unverified"
      data-requirements-unverified
    >
      <h3
        id="overview-requirements-unverified"
        class="text-sm font-semibold text-highlighted"
      >
        {{ t('requirements.unverified.title') }}
      </h3>
      <p class="text-sm text-muted">
        {{ t('requirements.unverified.hint') }}
      </p>
      <ul class="divide-y divide-default rounded-md border border-default">
        <li
          v-for="item in coverage.unverified"
          :key="item.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
          :data-requirement-unverified="item.id"
        >
          <span
            class="min-w-0 break-all font-mono text-xs text-default"
            translate="no"
          >{{ item.id }}</span>
          <ULink
            v-for="referrer in item.referencedBy"
            :key="referrerKey(referrer)"
            :to="referrerLocation(referrer)"
            class="text-sm text-default underline decoration-(--ui-border-accented) underline-offset-2 hover:decoration-current"
          >
            {{ referrerLabel(referrer) }}
          </ULink>
        </li>
      </ul>
    </section>
  </section>
</template>
