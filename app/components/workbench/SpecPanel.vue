<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import type { TabsItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import type { DecisionRead, Diagnostic, SpecTab } from '../../composables/workbench-types'

/** Bottom panel below the canvas: the selected View's Spec, References, Decisions and Checks. */
const { t } = useI18n()
const workbench = useWorkbench()
const { selectedView, activeSpecTab, specPanelExpanded } = workbench

const spec = computed(() => selectedView.value?.resource.spec)

const items = computed<TabsItem[]>(() => [
	{ value: 'spec', slot: 'spec' as const, label: t('workbench.spec.tabs.spec') },
	{ value: 'references', slot: 'references' as const, label: t('workbench.spec.tabs.references'), badge: badge(spec.value?.references.length ?? 0) },
	{ value: 'decisions', slot: 'decisions' as const, label: t('workbench.spec.tabs.decisions'), badge: badge(spec.value?.decisions.length ?? 0) },
	{
		value: 'checks',
		slot: 'checks' as const,
		label: t('workbench.spec.tabs.checks'),
		badge: { ...badge(selectedView.value?.diagnostics.length ?? 0), ...(selectedView.value?.diagnostics.length ? { color: 'warning' as const } : {}) },
	},
])

function badge(count: number) {
	return { label: String(count), color: 'neutral' as const, variant: 'soft' as const, size: 'sm' as const }
}

const tabModel = computed({
	get: () => activeSpecTab.value,
	set: (value: string | number) => { activeSpecTab.value = value as SpecTab },
})

function decisionColor(status: DecisionRead['status']) {
	return status === 'decided' ? 'success' : status === 'pending' ? 'warning' : 'neutral'
}

function decisionStatusLabel(status: DecisionRead['status']): string {
	switch (status) {
		case 'decided': return t('workbench.spec.decisionStatus.decided')
		case 'pending': return t('workbench.spec.decisionStatus.pending')
		default: return t('workbench.spec.decisionStatus.deferred')
	}
}

function jumpTo(diagnostic: Diagnostic) {
	const id = workbench.resolveWidgetIdFromDiagnostic(diagnostic)
	if (id) workbench.selectWidget(id)
}
</script>

<template>
  <section
    class="relative shrink-0 border-t border-default bg-default"
    :aria-label="t('workbench.spec.label')"
  >
    <UButton
      color="neutral"
      variant="ghost"
      size="xs"
      class="absolute top-1.5 right-3 z-10"
      :icon="specPanelExpanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
      :aria-expanded="specPanelExpanded"
      @click="specPanelExpanded = !specPanelExpanded"
    >
      {{ specPanelExpanded ? t('workbench.spec.collapse') : t('workbench.spec.expand') }}
    </UButton>

    <UTabs
      v-model="tabModel"
      :items="items"
      :content="specPanelExpanded"
      variant="link"
      size="xs"
      :ui="{
        root: 'gap-0',
        list: 'border-b border-default px-4 pe-32',
        content: 'max-h-56 overflow-y-auto p-4 text-xs focus-visible:outline-2 focus-visible:-outline-offset-2',
      }"
    >
      <template #spec>
        <div
          v-if="spec"
          class="space-y-4"
        >
          <div>
            <h3 class="font-semibold tracking-wider text-muted uppercase">
              {{ t('workbench.spec.intent') }}
            </h3>
            <p class="mt-1 leading-relaxed text-default">
              {{ spec.intent || t('workbench.spec.noIntent') }}
            </p>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <UCard
              variant="outline"
              :ui="{ body: 'p-2.5 sm:p-2.5' }"
            >
              <h3 class="font-medium text-toned">
                {{ t('workbench.spec.entryConditions', spec.entryConditions.length) }}
              </h3>
              <ul
                v-if="spec.entryConditions.length"
                class="mt-1.5 list-disc space-y-1 ps-4 text-muted"
              >
                <li
                  v-for="(item, index) in spec.entryConditions"
                  :key="index"
                >
                  {{ item }}
                </li>
              </ul>
              <p
                v-else
                class="mt-1 text-dimmed"
              >
                {{ t('common.none') }}
              </p>
            </UCard>

            <UCard
              variant="outline"
              :ui="{ body: 'p-2.5 sm:p-2.5' }"
            >
              <h3 class="font-medium text-toned">
                {{ t('workbench.spec.interactionRules', spec.interactionRules.length) }}
              </h3>
              <ul
                v-if="spec.interactionRules.length"
                class="mt-1.5 list-disc space-y-1 ps-4 text-muted"
              >
                <li
                  v-for="(item, index) in spec.interactionRules"
                  :key="index"
                >
                  {{ item }}
                </li>
              </ul>
              <p
                v-else
                class="mt-1 text-dimmed"
              >
                {{ t('common.none') }}
              </p>
            </UCard>
          </div>
        </div>
        <p
          v-else
          class="text-dimmed"
        >
          {{ t('workbench.spec.noView') }}
        </p>
      </template>

      <template #references>
        <div
          v-if="spec?.references.length"
          class="grid grid-cols-2 gap-2"
        >
          <UCard
            v-for="item in spec.references"
            :key="item.uri"
            variant="subtle"
            :ui="{ body: 'p-2.5 sm:p-2.5' }"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="truncate font-medium text-default">{{ item.label || item.uri }}</span>
              <div class="flex shrink-0 gap-1">
                <UBadge
                  v-if="item.type"
                  color="neutral"
                  variant="soft"
                  size="xs"
                >
                  {{ item.type }}
                </UBadge>
                <UBadge
                  v-if="item.relation"
                  color="primary"
                  variant="soft"
                  size="xs"
                >
                  {{ item.relation }}
                </UBadge>
              </div>
            </div>
            <ULink
              v-if="item.uri.startsWith('http')"
              :to="item.uri"
              target="_blank"
              rel="noopener noreferrer"
              class="mt-1 flex items-center gap-1 truncate text-[11px] text-primary hover:underline"
            >
              <span class="truncate">{{ item.uri }}</span>
              <UIcon
                name="i-lucide-external-link"
                class="size-3 shrink-0"
              />
              <span class="sr-only">{{ t('workbench.spec.opensInNewTab') }}</span>
            </ULink>
            <p
              v-else
              class="mt-1 truncate font-mono text-[10px] text-dimmed"
            >
              {{ item.uri }}
            </p>
          </UCard>
        </div>
        <p
          v-else
          class="text-dimmed"
        >
          {{ t('workbench.spec.noReferences') }}
        </p>
      </template>

      <template #decisions>
        <div
          v-if="spec?.decisions.length"
          class="space-y-2"
        >
          <UCard
            v-for="decision in spec.decisions"
            :key="decision.id"
            variant="subtle"
            :ui="{ body: 'p-3 sm:p-3' }"
          >
            <div class="flex items-start justify-between gap-2">
              <p class="font-medium text-default">
                {{ decision.question }}
              </p>
              <UBadge
                :color="decisionColor(decision.status)"
                variant="soft"
                size="xs"
              >
                {{ decisionStatusLabel(decision.status) }}
              </UBadge>
            </div>
            <p
              v-if="decision.outcome"
              class="mt-1.5 text-toned"
            >
              <span class="font-semibold text-muted">{{ t('workbench.spec.outcome') }}</span> {{ decision.outcome.summary }}
            </p>
            <p
              v-if="decision.outcome?.rationale"
              class="mt-1 text-muted italic"
            >
              {{ decision.outcome.rationale }}
            </p>
            <p class="mt-2 font-mono text-[10px] text-dimmed">
              {{ t('workbench.spec.historyEvents', decision.history.length) }} · {{ decision.id }}
            </p>
          </UCard>
        </div>
        <p
          v-else
          class="text-dimmed"
        >
          {{ t('workbench.spec.noDecisions') }}
        </p>
      </template>

      <template #checks>
        <div
          v-if="selectedView?.diagnostics.length"
          class="space-y-1.5"
        >
          <UAlert
            v-for="diagnostic in selectedView.diagnostics"
            :key="diagnostic.code + diagnostic.path"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :ui="{ root: 'p-2.5', title: 'font-mono text-xs', description: 'text-xs' }"
          >
            <template #title>
              <span class="font-medium">[{{ diagnostic.code }}]</span>
              <span class="ms-2 text-muted">{{ diagnostic.path }}</span>
            </template>
            <template #description>
              {{ diagnostic.message }}
            </template>
            <template #actions>
              <UButton
                v-if="workbench.resolveWidgetIdFromDiagnostic(diagnostic)"
                color="primary"
                variant="soft"
                size="xs"
                icon="i-lucide-crosshair"
                @click="jumpTo(diagnostic)"
              >
                {{ t('workbench.spec.jumpToWidget', { id: workbench.resolveWidgetIdFromDiagnostic(diagnostic) }) }}
              </UButton>
              <UBadge
                v-else
                color="neutral"
                variant="soft"
                size="xs"
              >
                {{ t('workbench.spec.unresolvedLocation') }}
              </UBadge>
            </template>
          </UAlert>
        </div>
        <UAlert
          v-else-if="selectedView"
          color="success"
          variant="subtle"
          icon="i-lucide-circle-check"
          :title="t('workbench.spec.allChecksPassed')"
          :ui="{ root: 'p-2.5', title: 'text-xs' }"
        />
      </template>
    </UTabs>
  </section>
</template>
