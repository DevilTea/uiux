<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import type { BreadcrumbItem } from '@nuxt/ui'
import { injectFlowEditor } from '../../composables/useFlowEditor'
import { useWorkbench } from '../../composables/useWorkbench'
import type { CanvasTool } from '../../composables/usePreviewSession'
import type { FlowDraft } from '../../utils/flow-graph'
import {
	availableTransitions,
	currentVisit,
	followTrigger,
	restartPlayback,
	startPlayback,
	type PlayerTrigger,
	type PlayerVisit,
} from '../../utils/prototype-player'
import PreviewCanvas from '../workbench/PreviewCanvas.vue'

/**
 * The Prototype player (brief g, section 5; Discussion #6, items 6 and 10c). It reuses the View
 * canvas frame and the one Preview session. Playback starts at the entry step and follows the saved
 * canonical Flow. Every step entry starts a new runtime generation, so the iframe document and its
 * View Runtime are created fresh, including on a return to a step already visited; leaving a step
 * disposes its document. Nothing from an earlier entry is restored.
 *
 * Transitions are followed from the dock. The same `followTrigger` path is where a Widget Event
 * occurrence reported by the Preview runtime would enter, once the runtime reports one.
 */
const props = defineProps<{ flow: FlowDraft }>()
const emit = defineEmits<{ (e: 'exit'): void }>()

const { t } = useI18n()
const editor = injectFlowEditor()
const workbench = useWorkbench()
const { preview } = workbench

const state = shallowRef(startPlayback(props.flow))
const visit = computed(() => currentVisit(state.value))
const transitions = computed(() => availableTransitions(props.flow, state.value))
const announcement = ref('')

function stepTitle(stepId: string): string {
	const variant = props.flow.steps[stepId]?.target.variantName
	return variant ? t('flows.player.stepWithVariant', { step: editor.stepLabel(stepId), variant }) : editor.stepLabel(stepId)
}

/** The path played so far. Earlier steps are history, not links: going back is not a Flow transition. */
const MAX_CRUMBS = 6
const crumbs = computed<BreadcrumbItem[]>(() => {
	const history = state.value.history
	const shown = history.slice(-MAX_CRUMBS)
	const items: BreadcrumbItem[] = shown.map((item, index) => ({
		label: stepTitle(item.stepId),
		...(index === shown.length - 1 ? { 'aria-current': 'step' } : {}),
	}))
	if (history.length > shown.length) items.unshift({ label: t('flows.player.earlier', history.length - shown.length) })
	return items
})

let entryToken = 0

async function enter(entered: PlayerVisit): Promise<void> {
	const token = ++entryToken
	const target = props.flow.steps[entered.stepId]?.target
	if (!target) return
	const generationBefore = preview.runtimeGenerationId.value
	await workbench.openView(target.viewId, {
		variant: target.variantName ?? '',
		locale: workbench.selectedLocale.value,
		viewport: workbench.selectedViewportId.value,
		theme: workbench.selectedThemeId.value,
		widget: 'root',
	})
	if (token !== entryToken) return
	// The player selects nothing: no Widget, not even RootShell, is highlighted in the played View.
	workbench.selectedWidgetId.value = ''
	await nextTick()
	// Part 6 #6: a fresh View Runtime on every step entry, even when the View is already on screen.
	if (preview.runtimeGenerationId.value === generationBefore) preview.replaceGeneration()
	announcement.value = t('flows.player.entered', { n: state.value.history.length, step: stepTitle(entered.stepId) })
}

watch(() => visit.value.entry, () => { void enter(visit.value) })

const root = ref<HTMLElement>()

/** The dock is rebuilt for each entry; keep keyboard focus in it rather than dropping it to the page. */
async function keepDockFocus(change: () => void): Promise<void> {
	const dock = root.value?.querySelector('[data-flow-player-dock]')
	const hadFocus = !!dock && dock.contains(document.activeElement)
	change()
	if (!hadFocus) return
	await nextTick()
	root.value?.querySelector<HTMLElement>('[data-flow-player-dock] button')?.focus()
}

function follow(trigger: PlayerTrigger): void {
	void keepDockFocus(() => { state.value = followTrigger(props.flow, state.value, trigger) })
}

function restart(): void {
	void keepDockFocus(() => { state.value = restartPlayback(props.flow, state.value) })
}

function onKeydown(event: KeyboardEvent): void {
	if (event.key !== 'Escape' || event.defaultPrevented) return
	if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
	event.preventDefault()
	emit('exit')
}

let previousTool: CanvasTool = 'select'
onMounted(() => {
	previousTool = preview.canvasTool.value
	// The View receives every click in the player; nothing changes the Workbench selection.
	preview.setCanvasTool('interact')
	window.addEventListener('keydown', onKeydown)
	void enter(visit.value)
})

onBeforeUnmount(() => {
	entryToken++
	window.removeEventListener('keydown', onKeydown)
	preview.setCanvasTool(previousTool)
	workbench.selectedWidgetId.value = 'root'
})

defineExpose({ follow, restart })
</script>

<template>
  <section
    ref="root"
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    :aria-label="t('flows.player.label')"
    data-flow-player
  >
    <UDashboardToolbar
      :ui="{
        root: 'min-h-10 h-auto gap-2 bg-default px-2 py-1 sm:px-2',
        left: 'min-w-0 flex-1 gap-2',
        right: 'shrink-0 gap-1',
      }"
    >
      <template #left>
        <UIcon
          name="i-lucide-play"
          class="size-4 shrink-0 text-dimmed"
        />
        <nav
          :aria-label="t('flows.player.path')"
          class="min-w-0 flex-1 overflow-x-auto"
        >
          <UBreadcrumb
            :items="crumbs"
            separator-icon="i-lucide-chevron-right"
            :ui="{
              list: 'flex-nowrap',
              item: 'shrink-0',
              link: 'text-sm whitespace-nowrap',
              linkLabel: 'max-w-56 truncate',
            }"
            data-flow-player-path
          />
        </nav>
      </template>
      <template #right>
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-rotate-ccw"
          :label="t('flows.restart')"
          :ui="{ label: 'max-sm:sr-only' }"
          data-flow-player-restart
          @click="restart"
        />
        <UTooltip
          :text="t('flows.exit')"
          :kbds="['esc']"
        >
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-x"
            :label="t('flows.exit')"
            :ui="{ label: 'max-sm:sr-only' }"
            data-flow-player-exit
            @click="emit('exit')"
          />
        </UTooltip>
      </template>
    </UDashboardToolbar>

    <PreviewCanvas prototype>
      <template #dock>
        <div
          :key="visit.entry"
          role="group"
          :aria-label="t('flows.player.nextGroup')"
          class="player-dock pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-[10px] bg-default p-1 shadow-overlay"
          data-flow-player-dock
        >
          <template v-if="transitions.length">
            <UTooltip
              v-for="(transition, index) in transitions"
              :key="`${visit.entry}:${index}`"
              :text="t('flows.player.goesTo', { step: stepTitle(transition.targetStepId) })"
            >
              <UButton
                color="neutral"
                variant="ghost"
                size="sm"
                trailing-icon="i-lucide-arrow-right"
                class="min-w-0"
                :ui="{ base: 'gap-1.5 px-2', trailingIcon: 'text-dimmed' }"
                data-flow-player-next
                @click="follow(transition.trigger)"
              >
                <i18n-t
                  keypath="flows.next"
                  tag="span"
                  scope="global"
                  class="min-w-0 truncate"
                >
                  <template #event>
                    <code class="font-mono text-xs text-highlighted">{{ transition.trigger.event }} #{{ transition.trigger.widgetId }}</code>
                  </template>
                </i18n-t>
              </UButton>
            </UTooltip>
          </template>
          <template v-else>
            <span class="px-2 text-sm text-muted">{{ t('flows.player.end') }}</span>
            <UButton
              color="primary"
              variant="solid"
              size="sm"
              icon="i-lucide-rotate-ccw"
              :label="t('flows.restart')"
              @click="restart"
            />
          </template>
        </div>
      </template>
    </PreviewCanvas>

    <p
      class="sr-only"
      role="status"
      aria-live="polite"
    >
      {{ announcement }}
    </p>
  </section>
</template>

<style scoped>
/* Each step entry re-seats the dock: opacity plus a 4px rise from the canvas edge, 160ms. */
.player-dock {
  animation: dock-in 160ms var(--ease-out-quiet, cubic-bezier(0.2, 0, 0, 1)) both;
}
@keyframes dock-in {
  from { opacity: 0; translate: 0 4px; }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes dock-in {
    from { opacity: 0; }
  }
}
</style>
