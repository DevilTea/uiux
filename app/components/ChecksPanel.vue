<script setup lang="ts">
import { computed } from 'vue'
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
  <div class="flex h-full flex-col overflow-hidden text-xs text-neutral-200">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-neutral-800 p-3">
      <div>
        <h2 class="text-sm font-semibold text-white">
          Checks & Diagnostics
        </h2>
        <p class="text-[11px] text-neutral-400">
          Actionable validation findings across Workspace & Views
        </p>
      </div>

      <UBadge
        :color="allCheckItems.length ? 'warning' : 'success'"
        variant="soft"
        size="xs"
      >
        {{ allCheckItems.length ? `${allCheckItems.length} findings` : 'Clean' }}
      </UBadge>
    </div>

    <!-- Findings List -->
    <div class="flex-1 overflow-y-auto p-3 space-y-2">
      <div
        v-if="allCheckItems.length"
        class="space-y-2"
      >
        <div
          v-for="(item, idx) in allCheckItems"
          :key="idx"
          class="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-amber-200 space-y-1.5"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 font-mono text-[11px]">
              <span class="rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-400 uppercase font-sans font-medium">
                {{ item.source }}
              </span>
              <span class="font-semibold text-amber-400">[{{ item.code }}]</span>
              <span class="text-neutral-400">{{ item.path }}</span>
            </div>

            <!-- Actionable Jump button or Unresolved badge -->
            <div>
              <button
                v-if="item.resolvedWidgetId"
                type="button"
                class="inline-flex items-center gap-1 rounded bg-primary/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary-300 hover:bg-primary/30 transition"
                title="Select and highlight widget in Preview Canvas"
                @click="handleJump(item.resolvedWidgetId)"
              >
                🎯 #{{ item.resolvedWidgetId }}
              </button>
              <span
                v-else
                class="rounded bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[9px] text-neutral-500"
                title="No widget location identity associated with this finding"
              >
                [unresolved location]
              </span>
            </div>
          </div>

          <p class="text-[11px] text-neutral-200 leading-relaxed">
            {{ item.message }}
          </p>
        </div>
      </div>

      <div
        v-else
        class="flex flex-col items-center justify-center p-8 text-center"
      >
        <div class="text-emerald-400 text-lg mb-1">
          ✓
        </div>
        <p class="font-medium text-neutral-200">
          All checks passed
        </p>
        <p class="text-[11px] text-neutral-500 mt-0.5">
          No diagnostic errors or warnings found in current Workspace and View.
        </p>
      </div>
    </div>
  </div>
</template>
