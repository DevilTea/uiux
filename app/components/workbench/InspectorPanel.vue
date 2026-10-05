<script setup lang="ts">
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'

/** Right rail: details for the selected Widget, or the selected View's metadata. */
const { t } = useI18n()
const workbench = useWorkbench()
const { selectedView, selectedWidgetNode, widgetStateOverrides, selectedWidgetDiagnostics } = workbench

function shortRevision(revision: string) {
	return revision.length > 18 ? `${revision.slice(0, 18)}…` : revision
}
</script>

<template>
  <section
    class="flex h-full min-h-0 flex-col bg-default p-4"
    :aria-label="t('workbench.inspector.title')"
  >
    <div class="flex items-center justify-between border-b border-default pb-3">
      <h2 class="text-xs font-semibold text-muted">
        {{ t('workbench.inspector.title') }}
      </h2>
      <UBadge
        color="neutral"
        variant="soft"
        size="sm"
        class="font-mono"
      >
        {{ selectedWidgetNode ? selectedWidgetNode.type : t('workbench.inspector.view') }}
      </UBadge>
    </div>

    <div class="flex-1 space-y-4 overflow-y-auto py-3 text-xs">
      <div
        v-if="selectedWidgetNode"
        class="space-y-4"
      >
        <section>
          <h3 class="font-semibold text-muted">
            {{ t('workbench.inspector.selectedWidget') }}
          </h3>
          <UCard
            variant="subtle"
            class="mt-2"
            :ui="{ body: 'p-2.5 sm:p-2.5' }"
          >
            <dl class="space-y-2">
              <div class="flex justify-between gap-2">
                <dt class="text-dimmed">
                  {{ t('workbench.inspector.identity') }}
                </dt>
                <dd class="truncate font-mono text-default">
                  #{{ selectedWidgetNode.id }}
                </dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-dimmed">
                  {{ t('workbench.inspector.type') }}
                </dt>
                <dd class="font-semibold text-default">
                  {{ selectedWidgetNode.type }}
                </dd>
              </div>
              <div
                v-if="selectedWidgetNode.slotName"
                class="flex justify-between gap-2"
              >
                <dt class="text-dimmed">
                  {{ t('workbench.inspector.slot') }}
                </dt>
                <dd class="font-mono text-default">
                  {{ selectedWidgetNode.slotName }}[{{ selectedWidgetNode.slotIndex }}]
                </dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-dimmed">
                  {{ t('workbench.inspector.depth') }}
                </dt>
                <dd class="font-mono text-default">
                  {{ selectedWidgetNode.depth }}
                </dd>
              </div>
            </dl>
          </UCard>
        </section>

        <section>
          <h3 class="font-semibold text-muted">
            {{ t('workbench.inspector.stateOverrides') }}
          </h3>
          <UCard
            v-if="widgetStateOverrides"
            variant="subtle"
            class="mt-2"
            :ui="{ body: 'p-2.5 sm:p-2.5' }"
          >
            <dl class="font-mono text-xs">
              <div
                v-for="(value, key) in widgetStateOverrides"
                :key="key"
                class="flex justify-between gap-2 py-0.5"
              >
                <dt class="text-muted">
                  {{ key }}
                </dt>
                <dd class="truncate text-default">
                  {{ JSON.stringify(value) }}
                </dd>
              </div>
            </dl>
          </UCard>
          <p
            v-else
            class="mt-1 text-dimmed"
          >
            {{ t('workbench.inspector.noStateOverrides') }}
          </p>
        </section>

        <section>
          <h3 class="font-semibold text-muted">
            {{ t('workbench.inspector.findings') }}
          </h3>
          <div
            v-if="selectedWidgetDiagnostics.length"
            class="mt-2 space-y-1.5"
          >
            <UAlert
              v-for="diagnostic in selectedWidgetDiagnostics"
              :key="diagnostic.code + diagnostic.path"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="diagnostic.code"
              :description="diagnostic.message"
              :ui="{ root: 'p-2', title: 'font-mono text-xs', description: 'text-xs' }"
            />
          </div>
          <p
            v-else
            class="mt-1 flex items-center gap-1 text-success"
          >
            <UIcon
              name="i-lucide-circle-check"
              class="size-3.5"
            />
            {{ t('workbench.inspector.cleanWidget') }}
          </p>
        </section>
      </div>

      <section
        v-else-if="selectedView"
        class="space-y-4"
      >
        <h3 class="font-semibold text-muted">
          {{ t('workbench.inspector.viewMetadata') }}
        </h3>
        <UCard
          variant="subtle"
          :ui="{ body: 'p-2.5 sm:p-2.5' }"
        >
          <dl class="space-y-2">
            <div>
              <dt class="text-dimmed">
                {{ t('workbench.inspector.id') }}
              </dt>
              <dd class="font-mono text-xs break-all text-toned">
                {{ selectedView.resource.id }}
              </dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-dimmed">
                {{ t('common.revision') }}
              </dt>
              <dd class="font-mono text-toned">
                {{ shortRevision(selectedView.revision) }}
              </dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-dimmed">
                {{ t('workbench.inspector.variants') }}
              </dt>
              <dd class="text-toned">
                {{ Object.keys(selectedView.resource.variants).length }}
              </dd>
            </div>
          </dl>
        </UCard>
      </section>

      <UEmpty
        v-else
        size="sm"
        icon="i-lucide-mouse-pointer-click"
        :title="t('workbench.inspector.emptyTitle')"
        :description="t('workbench.inspector.emptyDescription')"
        variant="naked"
      />
    </div>
  </section>
</template>
