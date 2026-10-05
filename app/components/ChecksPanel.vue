<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { deriveWidgetTree, flattenWidgetTree } from '../../src/preview/widget-tree'
import { resolveAllChecks, type DiagnosticItem } from '../../src/preview/checks-navigation'

const props = defineProps<{
	workspaceDiagnostics?: readonly DiagnosticItem[]
	viewDiagnostics?: readonly DiagnosticItem[]
	viewIr?: unknown
}>()

const emit = defineEmits<{
	(e: 'selectWidget', widgetId: string): void
}>()

const { t } = useI18n()

const widgetTree = computed(() => {
	if (!props.viewIr) return undefined
	const res = deriveWidgetTree(props.viewIr)
	return res.status === 'valid' ? res.root : undefined
})

const knownWidgetIds = computed<Set<string>>(() => {
	if (!widgetTree.value) return new Set()
	const all = flattenWidgetTree(widgetTree.value)
	return new Set(all.map(w => w.id))
})

const allCheckItems = computed(() =>
	resolveAllChecks(
		props.viewDiagnostics,
		props.workspaceDiagnostics,
		props.viewIr,
		knownWidgetIds.value,
	),
)

function handleJump(widgetId: string) {
	emit('selectWidget', widgetId)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden text-xs text-default">
    <!-- Header -->
    <div class="flex items-center justify-between gap-2 border-b border-default p-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ t('checks.title') }}
        </h2>
        <p class="text-[11px] text-muted">
          {{ t('checks.subtitle') }}
        </p>
      </div>

      <UBadge
        :color="allCheckItems.length ? 'warning' : 'success'"
        variant="subtle"
        size="sm"
        :icon="allCheckItems.length ? 'i-lucide-triangle-alert' : 'i-lucide-circle-check'"
        class="shrink-0"
      >
        {{ allCheckItems.length ? t('checks.findingCount', allCheckItems.length) : t('checks.clean') }}
      </UBadge>
    </div>

    <!-- Findings List -->
    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <ul
        v-if="allCheckItems.length"
        class="space-y-2"
        :aria-label="t('checks.listLabel')"
      >
        <li
          v-for="(item, idx) in allCheckItems"
          :key="`${item.source}:${item.code}:${item.path}:${idx}`"
        >
          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :ui="{ title: 'flex flex-wrap items-center gap-1.5', description: 'space-y-1', actions: 'mt-2' }"
          >
            <template #title>
              <UBadge
                color="neutral"
                variant="outline"
                size="sm"
              >
                {{ item.source === 'View' ? t('checks.source.view') : t('checks.source.workspace') }}
              </UBadge>
              <span class="font-mono text-[11px] font-semibold">{{ item.code }}</span>
            </template>

            <template #description>
              <p class="leading-relaxed text-default">
                {{ item.message }}
              </p>
              <p
                v-if="item.path"
                class="font-mono text-[10px] break-all text-muted"
              >
                {{ item.path }}
              </p>
            </template>

            <template #actions>
              <UTooltip
                v-if="item.resolvedWidgetId"
                :text="t('checks.jump.tooltip')"
              >
                <UButton
                  color="primary"
                  variant="soft"
                  size="xs"
                  icon="i-lucide-crosshair"
                  :label="t('checks.jump.label', { id: item.resolvedWidgetId })"
                  :aria-label="t('checks.jump.ariaLabel', { id: item.resolvedWidgetId })"
                  @click="handleJump(item.resolvedWidgetId)"
                />
              </UTooltip>
              <UTooltip
                v-else
                :text="t('checks.unresolved.tooltip')"
              >
                <UBadge
                  color="neutral"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-map-pin-off"
                  tabindex="0"
                >
                  {{ t('checks.unresolved.label') }}
                </UBadge>
              </UTooltip>
            </template>
          </UAlert>
        </li>
      </ul>

      <UEmpty
        v-else
        icon="i-lucide-circle-check"
        variant="naked"
        size="sm"
        :title="t('checks.allPassed.title')"
        :description="t('checks.allPassed.description')"
        :avatar="{ color: 'success' }"
      />
    </div>
  </div>
</template>
