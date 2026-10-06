<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../../composables/useWorkbench'
import { useMediaQuery } from '../../../composables/useMediaQuery'
import { statusKey, useCanvasComments, VIEW_ANCHOR_WIDGET_ID, type CommentFilter, type CommentThread } from '../../../composables/useCanvasComments'
import CommentRow from './CommentRow.vue'
import { flattenWidgetTree } from '../../../../src/preview/widget-tree'
import { MAX_TRACKED_WIDGETS } from '../../../../src/preview/protocol/schema'

/**
 * The Comments tab: the list companion to the pins (brief c, section 6). Grouped Ready, Open,
 * Can't be placed, Other Variants (and Resolved when the filter shows it); filtered like the
 * pins; hovering a row lifts its pin; Enter or a click opens the bubble.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const comments = useCanvasComments()!
const { preview, widgetTreeResult, selectedVariant } = workbench
const phone = useMediaQuery('(max-width: 767.98px)')

const typeById = computed(() => {
	const tree = widgetTreeResult.value
	return new Map(tree?.status === 'valid' ? flattenWidgetTree(tree.root).map(node => [node.id, node.type]) : [])
})

type Group = Readonly<{ key: string; label: string; icon?: string; rows: readonly CommentThread[] }>

/** Threads that cannot be drawn in any context of this View: the Widget is gone, or every named Variant is. */
function unplaceable(item: CommentThread): boolean {
	return !item.anchorValid || (item.variantNames.length > 0 && item.missingVariants.length === item.variantNames.length)
}

const groups = computed<readonly Group[]>(() => {
	const all = comments.threads.value.filter(comments.inFilter)
	const placeable = all.filter(item => !unplaceable(item))
	const notOnCanvas = new Set(comments.notOnCanvas.value.ids)
	const here = placeable.filter(item => item.inScope && !notOnCanvas.has(item.id))
	// Threads on the View as a whole (the RootShell anchor) lead, apart from the Widget threads.
	const onView = (item: CommentThread) => item.anchor.widgetId === VIEW_ANCHOR_WIDGET_ID
	const result: Group[] = [
		{ key: 'view', label: t('comments.group.view'), icon: 'i-lucide-app-window', rows: here.filter(item => onView(item) && item.status !== 'resolved') },
		{ key: 'ready', label: t('comments.group.ready'), rows: here.filter(item => !onView(item) && item.status === 'ready-for-review') },
		{ key: 'open', label: t('comments.group.open'), rows: here.filter(item => !onView(item) && item.status === 'open') },
		// Decision 6: Widgets beyond the tracking cap get no stream and no pin; they are listed here instead.
		{ key: 'overcap', label: t('pins.notOnCanvasGroup'), icon: 'i-lucide-eye-off', rows: placeable.filter(item => item.inScope && notOnCanvas.has(item.id)) },
		{ key: 'unplaced', label: t('comments.group.unplaced'), icon: 'i-lucide-triangle-alert', rows: all.filter(unplaceable) },
		{ key: 'other', label: t('pins.otherVariants', { n: placeable.filter(item => !item.inScope).length }), rows: placeable.filter(item => !item.inScope) },
		{ key: 'resolved', label: t('comments.group.resolved'), rows: here.filter(item => item.status === 'resolved') },
	]
	return result.filter(group => group.rows.length)
})

const counts = computed(() => {
	const result = { open: 0, ready: 0, resolved: 0 }
	for (const item of comments.threads.value) result[statusKey(item.status)]++
	return result
})
const visibleCount = computed(() => groups.value.reduce((sum, group) => sum + group.rows.length, 0))
const allResolved = computed(() => comments.threads.value.length > 0 && comments.threads.value.every(item => item.status === 'resolved'))

const FILTERS: ReadonlyArray<{ key: keyof CommentFilter; icon: string }> = [
	{ key: 'open', icon: 'i-lucide-circle-dot' },
	{ key: 'ready', icon: 'i-lucide-eye' },
	{ key: 'resolved', icon: 'i-lucide-circle-check' },
]

function openRow(item: CommentThread): void {
	if (!comments.open(item.id)) return
	comments.requestReveal(item.id)
}

function reanchor(item: CommentThread): void {
	preview.startReanchor(item.id)
}

function startCommenting(): void {
	comments.toggleCommentMode()
}

/** "Comment on this View": a blocked one says why (tooltip, then a toast when used anyway). */
const viewCommentBlocked = computed(() => comments.createBlockedReason.value)

// J / K move between rows (brief c, section 11).
const list = ref<HTMLElement>()
function onListKeydown(event: KeyboardEvent): void {
	if (event.metaKey || event.ctrlKey || event.altKey) return
	if (event.key !== 'j' && event.key !== 'k') return
	const rows = [...(list.value?.querySelectorAll<HTMLElement>('[data-comment-row]') ?? [])]
	if (!rows.length) return
	const index = rows.findIndex(row => row === document.activeElement)
	const next = rows[event.key === 'j' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1)]
	event.preventDefault()
	void nextTick(() => next?.focus())
}
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col"
    data-comments-tab
  >
    <div class="flex flex-wrap items-center gap-1 border-b border-default px-2 py-1.5">
      <div
        role="group"
        :aria-label="t('comments.filterLabel')"
        class="flex flex-wrap items-center gap-1"
      >
        <UButton
          v-for="item in FILTERS"
          :key="item.key"
          size="xs"
          color="neutral"
          :variant="comments.filter.value[item.key] ? 'soft' : 'ghost'"
          :icon="item.icon"
          :aria-pressed="comments.filter.value[item.key]"
          :data-comment-filter="item.key"
          @click="comments.setFilter(item.key, !comments.filter.value[item.key])"
        >
          {{ t(`thread.status.${item.key}`) }}
          <span class="text-muted tabular-nums">{{ counts[item.key] }}</span>
        </UButton>
      </div>
      <!-- Phones never start comments (DESIGN.md "Mobile"); the canvas pill says so there. -->
      <UTooltip
        v-if="!phone && !workbench.isReadOnly.value"
        :text="viewCommentBlocked ?? t('comments.commentOnViewHint')"
      >
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-message-square-plus"
          class="ms-auto"
          :class="viewCommentBlocked ? 'cursor-not-allowed text-dimmed' : ''"
          :aria-disabled="viewCommentBlocked ? 'true' : undefined"
          :aria-description="viewCommentBlocked"
          data-comment-on-view="tab"
          :data-blocked="viewCommentBlocked ? '' : undefined"
          @click="comments.commentOnView()"
        >
          {{ t('comments.commentOnViewShort') }}
        </UButton>
      </UTooltip>
    </div>

    <UAlert
      v-if="comments.loadError.value"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="comments.loadError.value.message"
      :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => { void comments.refreshReviews() } }]"
      class="rounded-none"
    />

    <div
      ref="list"
      class="min-h-0 flex-1 overflow-y-auto"
      role="region"
      :aria-label="t('comments.listLabel')"
      @keydown="onListKeydown"
    >
      <template v-if="visibleCount">
        <section
          v-for="group in groups"
          :key="group.key"
          :aria-label="group.label"
          :data-comment-group="group.key"
        >
          <h2 class="flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs font-medium text-muted">
            {{ group.key === 'other' ? group.label : `${group.label} · ${group.rows.length}` }}
            <UIcon
              v-if="group.icon"
              :name="group.icon"
              class="size-3.5"
              :class="group.key === 'overcap' || group.key === 'view' ? 'text-muted' : 'text-warning'"
            />
          </h2>
          <p
            v-if="group.key === 'overcap'"
            class="px-3 pb-1 text-xs text-muted"
            data-comment-overcap-hint
          >
            {{ comments.notOnCanvas.value.reason === 'single-stream' ? t('pins.singleStreamHint') : t('pins.overCapHint', { cap: MAX_TRACKED_WIDGETS }) }}
          </p>
          <!-- Each group is its own list, named by its heading. -->
          <div
            role="list"
            :aria-label="group.label"
          >
            <div
              v-for="item in group.rows"
              :key="item.id"
              role="listitem"
              class="group/row relative"
              @mouseenter="comments.hoveredThreadId.value = item.id"
              @mouseleave="comments.hoveredThreadId.value = undefined"
            >
              <CommentRow
                :item="item"
                :widget-type="item.anchorValid ? (typeById.get(item.anchor.widgetId) ?? 'Widget') : undefined"
                :unplaceable="unplaceable(item)"
                :current="comments.openThreadId.value === item.id"
                @hover="comments.hoveredThreadId.value = item.id"
                @leave="comments.hoveredThreadId.value = undefined"
                @open="openRow(item)"
              />
              <div
                v-if="group.key === 'unplaced' && comments.canComment.value && !item.anchorValid && !phone"
                class="px-3 pb-2 ps-[3.75rem]"
              >
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-crosshair"
                  :label="t('thread.reanchor')"
                  @click="reanchor(item)"
                />
              </div>
              <div
                v-else-if="group.key === 'other' && item.variantNames[0]"
                class="px-3 pb-2 ps-[3.75rem]"
              >
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  icon="i-lucide-layers"
                  :label="t('comments.switchTo', { variant: item.variantNames.find(name => !item.missingVariants.includes(name)) ?? item.variantNames[0] })"
                  @click="selectedVariant = item.variantNames.find(name => !item.missingVariants.includes(name)) ?? item.variantNames[0]!"
                />
              </div>
            </div>
          </div>
        </section>
      </template>

      <div
        v-else-if="allResolved"
        class="grid justify-items-start gap-2 px-4 py-6"
        data-comments-empty="resolved"
      >
        <UIcon
          name="i-lucide-circle-check"
          class="size-5 text-success"
        />
        <p class="text-sm font-medium text-highlighted">
          {{ t('allCaughtUp', { n: counts.resolved }) }}
        </p>
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          :label="t('comments.showResolved')"
          @click="comments.setFilter('resolved', true)"
        />
      </div>

      <UEmpty
        v-else
        icon="i-lucide-message-circle"
        :title="comments.threads.value.length ? t('comments.noneInFilter') : t('empty.title')"
        :description="comments.canComment.value && !phone ? t('empty.body') : undefined"
        variant="naked"
        size="sm"
        :actions="comments.canComment.value && !phone && !comments.threads.value.length ? [{ label: t('comments.startCommenting'), icon: 'i-lucide-message-circle-plus', color: 'neutral', variant: 'outline', onClick: startCommenting }] : undefined"
        data-comments-empty="none"
      />
    </div>
  </div>
</template>
