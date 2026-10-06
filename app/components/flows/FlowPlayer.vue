<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import type { BreadcrumbItem } from '@nuxt/ui'
import { injectFlowEditor } from '../../composables/useFlowEditor'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { provideCanvasComments } from '../../composables/useCanvasComments'
import type { CanvasTool } from '../../composables/usePreviewSession'
import type { FlowDraft } from '../../utils/flow-graph'
import {
	availableTransitions,
	currentVisit,
	followTrigger,
	resolveTransition,
	restartPlayback,
	startPlayback,
	type PlayerFollowScope,
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
 * Transitions follow real Widget Events (Part 2 decision group "Widget Event reporting"): each
 * step entry is bound to its runtime generation and arms that runtime with the step's outgoing
 * triggers only. The runtime reports at most one occurrence per arm, and each entry accepts at
 * most one transition from any source. The dock's Next controls and digits 1–9 stay available as
 * Workbench-driven advances (`source: 'workbench'`): player actions, not Events, never evidence.
 * Comment mode is allowed during playback (R17): it disarms, and leaving it re-arms.
 */
const props = defineProps<{ flow: FlowDraft }>()
const emit = defineEmits<{ (e: 'exit'): void }>()

const { t } = useI18n()
const editor = injectFlowEditor()
const workbench = useWorkbench()
const shell = useWorkbenchShell()
const { preview } = workbench
/** Reviewers can comment on a step's View or Variant while the player runs (R17). */
const comments = provideCanvasComments(ref<string>())
/** While Comment mode is on, its toggle turns it off; otherwise the reason it can't start, if any. */
const commentBlocked = computed(() => preview.isCommentMode.value ? undefined : comments.toolBlockedReason.value)

const state = shallowRef(startPlayback(props.flow))
const visit = computed(() => currentVisit(state.value))
const transitions = computed(() => availableTransitions(props.flow, state.value))
/**
 * The dock's controls, each carrying the entry it was rendered for: a click is scoped to that
 * entry, so a click on a control of a closed entry is a no-op (decision 7).
 */
const dockItems = computed(() => {
	const entry = visit.value.entry
	return transitions.value.map((transition, index) => ({ transition, entry, index }))
})
const announcement = ref('')
/** True once the open generation's handshake shows it can't report Widget Events (decision 10). */
const eventsUnavailable = computed(() => preview.widgetEventsSupported.value === false)

function stepTitle(stepId: string): string {
	const variant = props.flow.steps[stepId]?.target.variantName
	return variant ? t('flows.player.stepWithVariant', { step: editor.stepLabel(stepId), variant }) : editor.stepLabel(stepId)
}

/**
 * The path played so far. Earlier steps are history, not links: going back is not a Flow transition.
 * Steps often open the same View in different Variants, so each crumb leads with its play-order
 * number and its Variant ("Base state" when there is none); the View name follows, and the full
 * "Step n: View · Variant" title is in the tooltip.
 */
const MAX_CRUMBS = 6
interface StepCrumb extends BreadcrumbItem {
	slot: 'step'
	stepNumber: number
	variantLabel: string
	baseState: boolean
	viewLabel: string
	fullTitle: string
}
interface EarlierCrumb extends BreadcrumbItem { slot?: undefined }
const crumbs = computed<(StepCrumb | EarlierCrumb)[]>(() => {
	const history = state.value.history
	const shown = history.slice(-MAX_CRUMBS)
	const offset = history.length - shown.length
	const items: (StepCrumb | EarlierCrumb)[] = shown.map((item, index): StepCrumb => ({
		label: stepTitle(item.stepId),
		slot: 'step',
		stepNumber: offset + index + 1,
		variantLabel: props.flow.steps[item.stepId]?.target.variantName || t('ctx.base'),
		baseState: !props.flow.steps[item.stepId]?.target.variantName,
		viewLabel: editor.stepLabel(item.stepId),
		fullTitle: t('flows.player.entered', { n: offset + index + 1, step: stepTitle(item.stepId) }),
		...(index === shown.length - 1 ? { 'aria-current': 'step' } : {}),
		// A Workbench-driven advance is marked: it is not an Event and never evidence (decision 8).
		...(item.via?.source === 'workbench'
			? { 'icon': 'i-lucide-step-forward', 'advancedFromWorkbench': true, 'data-flow-player-advanced': 'workbench' }
			: {}),
	}))
	if (history.length > shown.length) items.unshift({ label: t('flows.player.earlier', history.length - shown.length) })
	return items
})

let entryToken = 0
/** The open step entry and the runtime generation it is bound to; undefined in the transition window. */
let boundEntry: Readonly<{ entry: number; runtimeGenerationId: string }> | undefined

/** Arms the bound generation with the current step's outgoing triggers (a changed set re-arms). */
function armCurrentEntry(): void {
	const bound = boundEntry
	if (!bound || bound.entry !== visit.value.entry) return
	preview.widgetEvents.arm(transitions.value.map(transition => transition.trigger), { runtimeGenerationId: bound.runtimeGenerationId })
}

async function enter(entered: PlayerVisit): Promise<void> {
	const token = ++entryToken
	boundEntry = undefined
	preview.widgetEvents.retire()
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
	// One step entry is one runtime generation: bind it, and arm that generation after its ACK.
	boundEntry = Object.freeze({ entry: entered.entry, runtimeGenerationId: preview.runtimeGenerationId.value })
	armCurrentEntry()
	announcement.value = t('flows.player.entered', { n: state.value.history.length, step: stepTitle(entered.stepId) })
}

watch(() => visit.value.entry, () => { void enter(visit.value) })
// The Flow changed during playback: the outgoing set of the open entry is re-armed.
watch(transitions, () => armCurrentEntry())

/**
 * Gates 5, 8 and 9 for an occurrence that passed the session's gates: the entry is open and bound
 * to this generation, the occurrence's context is the entry's step target, and exactly one
 * transition resolves. Anything else is discarded, never followed.
 */
preview.widgetEvents.onOccurrence((occurrence) => {
	const bound = boundEntry
	const current = visit.value
	if (!bound || bound.entry !== current.entry || bound.runtimeGenerationId !== occurrence.runtimeGenerationId) return 'closed'
	const target = props.flow.steps[current.stepId]?.target
	if (!target || target.viewId !== occurrence.viewId || (target.variantName ?? '') !== (occurrence.variantId ?? '')) return 'closed'
	const trigger = { widgetId: occurrence.widgetId, event: occurrence.event }
	if (!occurrence.armed || !resolveTransition(props.flow, current.stepId, trigger)) return 'unmatched'
	return follow(trigger, { entry: bound.entry, source: 'runtime' }) ? 'followed' : 'closed'
})

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

/**
 * Follows a trigger from the entry the call was issued in. The first accepted transition closes
 * the entry and retires its arm at once; later calls scoped to it are no-ops.
 */
function follow(trigger: PlayerTrigger, scope: PlayerFollowScope): boolean {
	const next = followTrigger(props.flow, state.value, trigger, scope)
	if (next === state.value) return false
	boundEntry = undefined
	preview.widgetEvents.retire()
	void keepDockFocus(() => { state.value = next })
	return true
}

/** A dock control: a Workbench-driven advance. The second click of a double click is ignored. */
function advanceFromDock(event: MouseEvent, item: (typeof dockItems.value)[number]): void {
	if (event.detail > 1) return
	follow(item.transition.trigger, { entry: item.entry, source: 'workbench' })
}

function restart(): void {
	boundEntry = undefined
	preview.widgetEvents.retire()
	void keepDockFocus(() => { state.value = restartPlayback(props.flow, state.value) })
}

function isTyping(target: EventTarget | null): boolean {
	const element = (target instanceof HTMLElement ? target : document.activeElement) as HTMLElement | null
	return !!element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable)
}

/** Esc leaves the composer, the bubble or Comment mode first; only then the player. */
function onEscape(event: KeyboardEvent): void {
	if (event.key !== 'Escape' || event.defaultPrevented) return
	if (preview.isCommentMode.value || comments.composer.value || comments.openThreadId.value) return
	if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
	event.preventDefault()
	emit('exit')
}

/**
 * Digits 1–9 follow the n-th listed transition when single-key shortcuts are on (decision 8).
 * Keys pressed inside the iframe belong to the View and never reach this document.
 */
function onDigit(event: KeyboardEvent): void {
	if (!shell.singleKeyShortcuts.value || event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
	if (!/^[1-9]$/.test(event.key) || isTyping(event.target)) return
	if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
	const item = dockItems.value[Number(event.key) - 1]
	if (!item) return
	event.preventDefault()
	follow(item.transition.trigger, { entry: item.entry, source: 'workbench' })
}

let previousTool: CanvasTool = 'select'
onMounted(() => {
	previousTool = preview.canvasTool.value
	// The View receives every click in the player; nothing changes the Workbench selection.
	preview.setCanvasTool('interact')
	// Capture: Esc is seen before the session's own handler leaves Comment mode.
	window.addEventListener('keydown', onEscape, true)
	window.addEventListener('keydown', onDigit)
	void enter(visit.value)
})

onBeforeUnmount(() => {
	entryToken++
	boundEntry = undefined
	preview.widgetEvents.onOccurrence(undefined)
	preview.widgetEvents.disarm()
	window.removeEventListener('keydown', onEscape, true)
	window.removeEventListener('keydown', onDigit)
	if (preview.isCommentMode.value) preview.exitCommentMode()
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
        <div class="min-w-0 flex-1">
          <!-- Neutral like the navbar breadcrumb: the current step is a location, not a selection.
               UBreadcrumb is the <nav> landmark and gets the translated name. A long path scrolls
               sideways, so the named landmark itself is the focusable scroller. -->
          <UBreadcrumb
            :items="crumbs"
            :aria-label="t('flows.player.path')"
            color="neutral"
            separator-icon="i-lucide-chevron-right"
            tabindex="0"
            class="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :ui="{
              root: 'overflow-x-auto',
              list: 'flex-nowrap',
              item: 'shrink-0',
              link: 'text-sm whitespace-nowrap',
              linkLabel: 'flex min-w-0 max-w-[min(32rem,40vw)]',
            }"
            data-flow-player-path
          >
            <template #step-label="{ item }">
              <UTooltip
                :text="item.fullTitle"
                :content="{ side: 'bottom', align: 'start' }"
              >
                <span
                  class="inline-flex min-w-0 items-baseline gap-1.5"
                  data-flow-player-crumb
                >
                  <span class="shrink-0 font-mono text-xs tabular-nums text-dimmed">{{ item.stepNumber }}</span>
                  <span
                    class="max-w-[14rem] truncate font-medium"
                    :class="item.baseState ? 'text-toned' : 'text-highlighted'"
                    data-flow-player-crumb-variant
                  >{{ item.variantLabel }}</span>
                  <span class="max-w-[6rem] truncate text-xs text-muted sm:max-w-[10rem]">{{ item.viewLabel }}</span>
                </span>
              </UTooltip>
            </template>
            <template #item-trailing="{ item }">
              <span
                v-if="item.advancedFromWorkbench"
                class="sr-only"
              >{{ t('flows.player.advancedFromWorkbench') }}</span>
            </template>
            <template #step-trailing="{ item }">
              <span
                v-if="item.advancedFromWorkbench"
                class="sr-only"
              >{{ t('flows.player.advancedFromWorkbench') }}</span>
            </template>
          </UBreadcrumb>
        </div>
      </template>
      <template #right>
        <!-- The player has no tool pill and the View holds keyboard focus once clicked, so `C`
             alone can't be relied on: Comment mode gets a visible toggle, which says why when it
             can't start (review feedback 8dd59d25). -->
        <UTooltip
          :text="commentBlocked ?? t('tool.comment')"
          :kbds="commentBlocked || !shell.singleKeyShortcuts.value ? undefined : ['C']"
        >
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-message-circle-plus"
            :label="t('tool.comment')"
            :aria-pressed="preview.isCommentMode.value"
            :aria-disabled="commentBlocked ? 'true' : undefined"
            :aria-description="commentBlocked"
            :class="commentBlocked ? 'cursor-not-allowed text-dimmed hover:bg-transparent' : preview.isCommentMode.value ? 'bg-comment-subtle text-annotation ring-1 ring-inset ring-annotation/35 hover:bg-comment-subtle' : 'text-muted'"
            :ui="{ label: 'max-sm:sr-only' }"
            data-flow-player-comment
            @click="comments.toggleCommentMode()"
          />
        </UTooltip>
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

    <UAlert
      v-if="eventsUnavailable"
      color="neutral"
      variant="subtle"
      icon="i-lucide-info"
      :description="t('flows.player.eventsUnavailable')"
      class="rounded-none border-b border-default"
      :ui="{ description: 'text-xs' }"
      data-flow-player-events-unavailable
    />

    <PreviewCanvas prototype>
      <template #dock>
        <div
          :key="visit.entry"
          role="group"
          :aria-label="t('flows.player.nextGroup')"
          class="player-dock pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-[10px] bg-default p-1 shadow-overlay"
          data-flow-player-dock
        >
          <template v-if="dockItems.length">
            <UTooltip
              v-for="item in dockItems"
              :key="`${item.entry}:${item.index}`"
              :text="t('flows.player.goesTo', { step: stepTitle(item.transition.targetStepId) })"
              :kbds="shell.singleKeyShortcuts.value && item.index < 9 ? [String(item.index + 1)] : undefined"
            >
              <UButton
                color="neutral"
                variant="ghost"
                size="sm"
                trailing-icon="i-lucide-arrow-right"
                class="min-w-0"
                :ui="{ base: 'gap-1.5 px-2', trailingIcon: 'text-dimmed' }"
                :aria-keyshortcuts="shell.singleKeyShortcuts.value && item.index < 9 ? String(item.index + 1) : undefined"
                data-flow-player-next
                @click="advanceFromDock($event, item)"
              >
                <i18n-t
                  keypath="flows.next"
                  tag="span"
                  scope="global"
                  class="min-w-0 truncate"
                >
                  <template #event>
                    <code class="font-mono text-xs text-highlighted">{{ item.transition.trigger.event }} #{{ item.transition.trigger.widgetId }}</code>
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
