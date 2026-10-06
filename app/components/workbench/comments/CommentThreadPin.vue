<script setup lang="ts">
import { computed } from 'vue'
import { useWorkbench } from '../../../composables/useWorkbench'
import { useCanvasComments } from '../../../composables/useCanvasComments'
import CommentPin from './CommentPin.vue'

/**
 * One thread's pin on the canvas. It derives its own look from the thread (each flag is its own
 * computed), so the pin layer can re-render its list of anchors without re-rendering pins whose
 * thread did not change. Activation and drags go to the layer through one stable `pin` event.
 */
const props = defineProps<{ threadId: string; draggableOnCanvas: boolean }>()
const emit = defineEmits<{
	(e: 'pin', threadId: string, action: 'activate' | 'enter' | 'move' | 'drop' | 'cancel', point?: Readonly<{ clientX: number; clientY: number }>): void
}>()

const workbench = useWorkbench()
const comments = useCanvasComments()!

const meta = computed(() => comments.pinMeta.value.get(props.threadId))
const open = computed(() => comments.openThreadId.value === props.threadId)
const lift = computed(() => comments.hoveredThreadId.value === props.threadId)
const fresh = computed(() => comments.freshThreadIds.value.has(props.threadId))
/** Interact gives every click to the View: pins dim and stop taking input. */
const dim = computed(() => workbench.preview.canvasTool.value === 'interact')
const draggable = computed(() => props.draggableOnCanvas && comments.canComment.value && !meta.value?.resolved && !dim.value)
</script>

<template>
  <CommentPin
    :label="meta?.label ?? ''"
    :variant="meta?.resolved ? 'resolved' : 'default'"
    :badge="meta?.badge"
    :initials="meta?.initials"
    :agent="meta?.agent"
    :open="open"
    :lift="lift"
    :fresh="fresh"
    :dim="dim"
    :draggable="draggable"
    :thread-id="threadId"
    @activate="keyboard => emit('pin', threadId, keyboard ? 'enter' : 'activate')"
    @drag-move="point => emit('pin', threadId, 'move', point)"
    @drag-end="point => emit('pin', threadId, 'drop', point)"
    @drag-cancel="emit('pin', threadId, 'cancel')"
  />
</template>
