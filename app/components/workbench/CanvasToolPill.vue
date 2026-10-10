<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from '#imports'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'

/**
 * The floating canvas tool palette (DESIGN.md "Canvas tool palette"; brief b, section 10):
 * a toolbar with roving tabindex whose active tool is `aria-pressed`, then "Comment on this View"
 * and the pins toggle.
 *
 * An unavailable tool never disappears or silently does nothing (review feedback 8dd59d25): it
 * stays focusable with `aria-disabled`, its tooltip says why, and using it anyway emits `blocked`
 * with that reason so the canvas can say it out loud. A native `disabled` button would swallow
 * the hover and focus that show the tooltip.
 */
export type CanvasToolId = 'select' | 'comment' | 'interact'

const props = defineProps<{
	active: CanvasToolId
	/** Why every tool is unavailable (no live preview yet); undefined when they work. */
	disabledReason?: string
	/** Why new comments can't be started here (role, migration, phone…); undefined when they can. */
	commentDisabledReason?: string
	/** Offers the Comment tool and "Comment on this View" (the canvas has a comments layer). */
	comments?: boolean
	/** Comment pins hidden (`true`) or shown; undefined where the canvas has no pins. */
	pinsHidden?: boolean
}>()
const emit = defineEmits<{
	(e: 'select', tool: CanvasToolId): void
	(e: 'togglePins' | 'commentOnView'): void
	(e: 'blocked', reason: string): void
}>()

const { t } = useI18n()
const shell = useWorkbenchShell()

const tools = computed(() => [
	{ id: 'select' as const, icon: 'i-lucide-mouse-pointer-2', label: t('tool.select'), hint: undefined, kbd: 'V' },
	{ id: 'comment' as const, icon: 'i-lucide-message-circle-plus', label: t('tool.comment'), hint: undefined, kbd: 'C' },
	{ id: 'interact' as const, icon: 'i-lucide-hand', label: t('tool.interact'), hint: t('tool.interactHint'), kbd: 'I' },
].filter(tool => tool.id !== 'comment' || props.comments).map(tool => ({
	...tool,
	// An active Comment tool always stays clickable, so it can be turned off.
	blocked: props.disabledReason ?? (tool.id === 'comment' && props.active !== 'comment' ? props.commentDisabledReason : undefined),
})))

/** Single-key shortcuts can be turned off in the preferences; the hints then stay out of the way. */
const keys = computed(() => shell.singleKeyShortcuts.value)

/** Roving tabindex: one tab stop, arrows move between tools. */
const focusIndex = ref(-1)
const buttons = ref<{ $el: HTMLElement }[]>([])
const activeIndex = computed(() => Math.max(0, tools.value.findIndex(tool => tool.id === props.active)))

function tabIndexFor(index: number): number {
	return index === (focusIndex.value >= 0 ? focusIndex.value : activeIndex.value) ? 0 : -1
}

async function move(direction: 1 | -1 | 'first' | 'last'): Promise<void> {
	const count = tools.value.length
	const current = focusIndex.value >= 0 ? focusIndex.value : activeIndex.value
	focusIndex.value = direction === 'first' ? 0 : direction === 'last' ? count - 1 : (current + direction + count) % count
	await nextTick()
	buttons.value[focusIndex.value]?.$el.focus()
}

function toolClass(id: CanvasToolId, blocked: string | undefined): string {
	if (blocked) return 'text-dimmed cursor-not-allowed hover:bg-transparent'
	if (props.active !== id) return 'text-muted'
	return id === 'comment'
		? 'bg-comment-subtle text-annotation ring-1 ring-inset ring-annotation/35 hover:bg-comment-subtle'
		: 'bg-primary text-inverted hover:bg-primary'
}

function choose(id: CanvasToolId, blocked: string | undefined): void {
	if (blocked) emit('blocked', blocked)
	else emit('select', id)
}

const viewCommentBlocked = computed(() => props.commentDisabledReason)
function commentOnView(): void {
	if (viewCommentBlocked.value) emit('blocked', viewCommentBlocked.value)
	else emit('commentOnView')
}
</script>

<template>
  <!-- One pill: the tool toolbar (one active tool), then "Comment on this View" and the pins toggle. -->
  <div class="inline-flex items-center gap-0.5 rounded-[10px] bg-default p-1 shadow-overlay">
    <div
      role="toolbar"
      :aria-label="t('tool.label')"
      aria-orientation="horizontal"
      class="inline-flex items-center gap-0.5"
      @keydown.right.prevent="move(1)"
      @keydown.left.prevent="move(-1)"
      @keydown.home.prevent="move('first')"
      @keydown.end.prevent="move('last')"
    >
      <UTooltip
        v-for="(tool, index) in tools"
        :key="tool.id"
        :text="tool.blocked ?? tool.hint ?? tool.label"
        :kbds="tool.blocked || !keys ? undefined : [tool.kbd]"
      >
        <UButton
          ref="buttons"
          color="neutral"
          variant="ghost"
          size="sm"
          :icon="tool.icon"
          :aria-pressed="active === tool.id"
          :aria-keyshortcuts="keys ? tool.kbd : undefined"
          :aria-disabled="tool.blocked ? 'true' : undefined"
          :aria-description="tool.blocked"
          :data-tool="tool.id"
          :data-blocked="tool.blocked ? '' : undefined"
          :tabindex="tabIndexFor(index)"
          :class="toolClass(tool.id, tool.blocked)"
          :ui="{ base: 'gap-1.5 px-2', label: 'max-sm:sr-only' }"
          @focus="focusIndex = index"
          @blur="focusIndex = -1"
          @click="choose(tool.id, tool.blocked)"
        >
          {{ tool.label }}
          <!-- A tool that can't be used here at all (role, snapshot, phone) shows no key to press. -->
          <UKbd
            v-if="keys && !(tool.blocked && !disabledReason)"
            :value="tool.kbd"
            variant="outline"
            class="max-sm:hidden pointer-coarse:hidden bg-transparent text-current ring-current/35"
          />
        </UButton>
      </UTooltip>
    </div>
    <template v-if="comments || pinsHidden !== undefined">
      <USeparator
        orientation="vertical"
        class="mx-0.5 h-5"
      />
      <UTooltip
        v-if="comments"
        :text="viewCommentBlocked ?? t('comments.commentOnView')"
      >
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-message-square-plus"
          :aria-label="t('comments.commentOnView')"
          :aria-disabled="viewCommentBlocked ? 'true' : undefined"
          :aria-description="viewCommentBlocked"
          :class="viewCommentBlocked ? 'text-dimmed cursor-not-allowed hover:bg-transparent' : 'text-muted'"
          data-comment-on-view="pill"
          :data-blocked="viewCommentBlocked ? '' : undefined"
          @click="commentOnView"
        />
      </UTooltip>
      <UTooltip
        v-if="pinsHidden !== undefined"
        :text="pinsHidden ? t('pins.show') : t('pins.hide')"
        :kbds="keys ? ['shift', 'C'] : undefined"
      >
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :icon="pinsHidden ? 'i-lucide-eye-off' : 'i-lucide-eye'"
          :aria-label="t('pins.toggle')"
          :aria-pressed="!pinsHidden"
          :aria-keyshortcuts="keys ? 'Shift+C' : undefined"
          class="text-muted"
          data-pins-toggle
          @click="emit('togglePins')"
        />
      </UTooltip>
    </template>
  </div>
</template>
