<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { relativeTime } from '../../../utils/widget-inspection'
import { threadAuthorInitials, useCanvasComments, VIEW_ANCHOR_WIDGET_ID, type CommentThread } from '../../../composables/useCanvasComments'

/**
 * One row of the Comments tab. It is its own component so that a thread whose pin scrolls in or out
 * of view re-renders only its own row (the canvas state is a fixed-size glyph, so the list never
 * changes height while the View scrolls). Persistent anchor problems get a line of text instead.
 */
const props = defineProps<{
	item: CommentThread
	/** The Widget type of the anchor, when the Widget exists. */
	widgetType?: string
	unplaceable: boolean
	current: boolean
}>()
const emit = defineEmits<{ (e: 'open' | 'hover' | 'leave'): void }>()

const { t, locale } = useI18n()
const comments = useCanvasComments()!
/** Read per thread, so only this row re-renders when its pin scrolls in or out of view. */
const status = computed(() => comments.pinStatus.get(props.item.id))

/** Persistent anchor problems, said in words under the title. */
const note = computed(() => {
	if (!props.item.anchorValid) return t('comments.widgetRemoved')
	if (props.item.missingVariants.length) return t('pins.variantMissing', { name: props.item.missingVariants.join(', ') })
	return undefined
})

const SIDE_ICON = { top: 'i-lucide-arrow-up-to-line', right: 'i-lucide-arrow-right-to-line', bottom: 'i-lucide-arrow-down-to-line', left: 'i-lucide-arrow-left-to-line' } as const

/** Why the pin is not on the canvas right now (decision 7): a glyph with its words for assistive tech and the tooltip. */
const canvas = computed<{ icon: string; text: string } | undefined>(() => {
	const current = status.value
	if (!props.item.anchorValid || !current || current.state === 'visible') return undefined
	if (current.state === 'offscreen') return { icon: SIDE_ICON[current.side ?? 'bottom'], text: t('comments.reason.offscreen') }
	switch (current.reason) {
		case 'point-not-visible': return { icon: 'i-lucide-scan', text: t('comments.reason.pointNotVisible') }
		case 'not-rendered':
		case 'no-visible-region': return { icon: 'i-lucide-eye-off', text: t('pins.notVisible') }
		case 'mapping-unavailable': return { icon: 'i-lucide-scan-line', text: t('comments.reason.mapping') }
		default: return undefined
	}
})

const statusIcon = computed(() => {
	if (props.unplaceable) return { name: 'i-lucide-triangle-alert', class: 'text-warning' }
	if (props.item.status === 'ready-for-review') return { name: 'i-lucide-eye', class: 'text-info' }
	if (props.item.status === 'resolved') return { name: 'i-lucide-circle-check', class: 'text-success' }
	return { name: 'i-lucide-circle-dot', class: 'text-annotation' }
})

const when = computed(() => props.item.latestActivityAt ? relativeTime(props.item.latestActivityAt, locale.value) : '')
// Cached, so a row that re-renders for its canvas glyph does no message formatting.
const authorName = computed(() => props.item.author?.displayName ?? t('comments.unknownAuthor'))
const messageCountLabel = computed(() => t('reviews.messageCount', props.item.messageCount))
/** A thread on the View as a whole (RootShell) reads "Whole View", not "RootShell · #root". */
const onView = computed(() => props.item.anchor.widgetId === VIEW_ANCHOR_WIDGET_ID)
const target = computed(() => onView.value ? t('comments.viewTarget') : `#${props.item.anchor.widgetId}`)
</script>

<template>
  <button
    type="button"
    class="grid w-full grid-cols-[16px_24px_minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-2 text-start hover:bg-muted focus-visible:bg-muted"
    :class="current ? 'bg-elevated' : ''"
    :aria-current="current ? 'true' : undefined"
    :data-comment-row="item.id"
    :data-comment-canvas="status?.state"
    @focus="emit('hover')"
    @blur="emit('leave')"
    @click="emit('open')"
  >
    <UIcon
      :name="statusIcon.name"
      class="mt-1 size-4"
      :class="statusIcon.class"
    />
    <UAvatar
      :text="item.author?.type === 'agent' ? undefined : threadAuthorInitials(item.author)"
      :icon="item.author?.type === 'agent' ? 'i-lucide-bot' : undefined"
      size="xs"
      aria-hidden="true"
    />
    <span class="min-w-0">
      <span class="block truncate text-sm text-highlighted">{{ item.title ?? target }}</span>
      <span class="mt-0.5 block truncate text-xs text-muted">
        {{ authorName }} ·
        <span
          v-if="onView"
          data-comment-target="view"
        >{{ target }}</span>
        <span
          v-else
          class="font-mono"
        >{{ widgetType ? `${widgetType} · ` : '' }}#{{ item.anchor.widgetId }}</span>
        <span
          v-if="item.variantNames.length"
          class="font-mono"
        > · {{ item.variantNames.join(', ') }}</span>
      </span>
      <span
        v-if="note"
        class="mt-0.5 block text-xs text-warning"
        data-comment-note
      >{{ note }}</span>
    </span>
    <span class="flex items-center gap-2 text-xs leading-5 whitespace-nowrap text-muted">
      <UTooltip
        :text="canvas?.text"
        :disabled="!canvas"
      >
        <span
          class="inline-grid size-3.5 place-items-center"
          data-comment-canvas-glyph
        >
          <UIcon
            :name="canvas?.icon ?? 'i-lucide-scan'"
            class="size-3.5"
            :class="canvas ? '' : 'invisible'"
          />
          <span
            v-if="canvas"
            class="sr-only"
          >{{ canvas.text }}</span>
        </span>
      </UTooltip>
      <time
        v-if="item.latestActivityAt"
        :datetime="item.latestActivityAt"
      >{{ when }}</time>
      <span class="inline-flex items-center gap-0.5">
        <UIcon
          name="i-lucide-message-circle"
          class="size-3"
        />{{ item.messageCount }}
        <span class="sr-only">{{ messageCountLabel }}</span>
      </span>
    </span>
  </button>
</template>
