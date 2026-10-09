<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../../composables/useWorkbench'
import { useCanvasComments } from '../../../composables/useCanvasComments'
import CommentPin from './CommentPin.vue'

/**
 * One thread's pin on the canvas. It derives its own look from the thread (each flag is its own
 * computed), so the pin layer can re-render its list of anchors without re-rendering pins whose
 * thread did not change. Activation and drags go to the layer through one stable `pin` event.
 *
 * A thread recorded in another render context is muted (Rule 01a1170f-c1ae): its pin shows that
 * context as a visible label, and its accessible name says it, so the state never depends on
 * color alone (Rule 01a1170f-c352).
 */
const props = defineProps<{ threadId: string; draggableOnCanvas: boolean }>()
const emit = defineEmits<{
	(e: 'pin', threadId: string, action: 'activate' | 'enter' | 'move' | 'drop' | 'cancel', point?: Readonly<{ clientX: number; clientY: number }>): void
}>()

const { t } = useI18n()
const workbench = useWorkbench()
const comments = useCanvasComments()!

const meta = computed(() => comments.pinMeta.value.get(props.threadId))
const open = computed(() => comments.openThreadId.value === props.threadId)
const lift = computed(() => comments.hoveredThreadId.value === props.threadId)
const fresh = computed(() => comments.freshThreadIds.value.has(props.threadId))
/** The recorded context of a muted thread, such as "zh-TW · mobile"; `undefined` when not muted. */
const mutedContext = computed(() => comments.mutedContexts.value.get(props.threadId))
const label = computed(() => mutedContext.value === undefined
	? meta.value?.label ?? ''
	: t('pins.muted.label', { label: meta.value?.label ?? '', context: mutedContext.value }))
/** Interact gives every click to the View: pins dim and stop taking input. */
const dim = computed(() => workbench.preview.canvasTool.value === 'interact')
const draggable = computed(() => props.draggableOnCanvas && comments.canComment.value && !meta.value?.resolved && !dim.value)
</script>

<template>
  <CommentPin
    :label="label"
    :variant="meta?.resolved ? 'resolved' : 'default'"
    :badge="meta?.badge"
    :initials="meta?.initials"
    :agent="meta?.agent"
    :open="open"
    :lift="lift"
    :fresh="fresh"
    :dim="dim"
    :context="mutedContext"
    :draggable="draggable"
    :thread-id="threadId"
    @activate="keyboard => emit('pin', threadId, keyboard ? 'enter' : 'activate')"
    @drag-move="point => emit('pin', threadId, 'move', point)"
    @drag-end="point => emit('pin', threadId, 'drop', point)"
    @drag-cancel="emit('pin', threadId, 'cancel')"
  />
</template>
