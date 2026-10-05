<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../../composables/useWorkbench'
import { relativeTime } from '../../../utils/widget-inspection'
import { useMediaQuery } from '../../../composables/useMediaQuery'
import { threadAuthorInitials, statusKey, useCanvasComments, type CommentFilter, type CommentThread } from '../../../composables/useCanvasComments'
import { flattenWidgetTree } from '../../../../src/preview/widget-tree'

/**
 * The Comments tab: the list companion to the pins (brief c, section 6). Grouped Ready, Open,
 * Can't be placed, Other Variants (and Resolved when the filter shows it); filtered like the
 * pins; hovering a row lifts its pin; Enter or a click opens the bubble.
 */
const { t, locale } = useI18n()
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
	const here = placeable.filter(item => item.inScope)
	const result: Group[] = [
		{ key: 'ready', label: t('comments.group.ready'), rows: here.filter(item => item.status === 'ready-for-review') },
		{ key: 'open', label: t('comments.group.open'), rows: here.filter(item => item.status === 'open') },
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

/** One short line under the title: why the pin is not drawn, when it is not. */
function note(item: CommentThread): string | undefined {
	if (!item.anchorValid) return t('comments.widgetRemoved')
	if (item.missingVariants.length) return t('pins.variantMissing', { name: item.missingVariants.join(', ') })
	const placement = comments.placementById.value.get(item.id)
	if (!placement || placement.state === 'visible') return undefined
	if (placement.state === 'offscreen') return t('comments.reason.offscreen')
	switch (placement.reason) {
		case 'point-not-visible': return t('comments.reason.pointNotVisible')
		case 'not-rendered':
		case 'no-visible-region': return t('pins.notVisible')
		case 'over-cap':
		case 'single-stream': return t('comments.reason.overCap')
		case 'mapping-unavailable': return t('comments.reason.mapping')
		default: return undefined
	}
}

function statusIcon(item: CommentThread): { name: string; class: string } {
	if (unplaceable(item)) return { name: 'i-lucide-triangle-alert', class: 'text-warning' }
	if (item.status === 'ready-for-review') return { name: 'i-lucide-eye', class: 'text-info' }
	if (item.status === 'resolved') return { name: 'i-lucide-circle-check', class: 'text-success' }
	return { name: 'i-lucide-circle-dot', class: 'text-annotation' }
}

function openRow(item: CommentThread): void {
	if (!comments.open(item.id)) return
	comments.requestReveal(item.id)
}

function reanchor(item: CommentThread): void {
	preview.startReanchor(item.id)
}

function startCommenting(): void {
	preview.setCanvasTool('comment')
}

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
          :icon="comments.filter.value[item.key] ? 'i-lucide-check' : item.icon"
          :aria-pressed="comments.filter.value[item.key]"
          :data-comment-filter="item.key"
          @click="comments.setFilter(item.key, !comments.filter.value[item.key])"
        >
          {{ t(`thread.status.${item.key}`) }}
          <span class="text-dimmed tabular-nums">{{ counts[item.key] }}</span>
        </UButton>
      </div>
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
      role="list"
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
          <h3 class="flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs font-medium text-muted">
            {{ group.key === 'other' ? group.label : `${group.label} · ${group.rows.length}` }}
            <UIcon
              v-if="group.icon"
              :name="group.icon"
              class="size-3.5 text-warning"
            />
          </h3>
          <div
            v-for="item in group.rows"
            :key="item.id"
            role="listitem"
            class="group/row relative"
            @mouseenter="comments.hoveredThreadId.value = item.id"
            @mouseleave="comments.hoveredThreadId.value = undefined"
          >
            <button
              type="button"
              class="grid w-full grid-cols-[16px_24px_minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-2 text-start hover:bg-muted focus-visible:bg-muted"
              :class="comments.openThreadId.value === item.id ? 'bg-elevated' : ''"
              :aria-current="comments.openThreadId.value === item.id ? 'true' : undefined"
              :data-comment-row="item.id"
              @focus="comments.hoveredThreadId.value = item.id"
              @blur="comments.hoveredThreadId.value = undefined"
              @click="openRow(item)"
            >
              <UIcon
                :name="statusIcon(item).name"
                class="mt-1 size-4"
                :class="statusIcon(item).class"
              />
              <UAvatar
                :text="item.author?.type === 'agent' ? undefined : threadAuthorInitials(item.author)"
                :icon="item.author?.type === 'agent' ? 'i-lucide-bot' : undefined"
                size="xs"
                aria-hidden="true"
              />
              <span class="min-w-0">
                <span class="block truncate text-sm text-highlighted">{{ item.title ?? `#${item.anchor.widgetId}` }}</span>
                <span class="mt-0.5 block truncate text-xs text-muted">
                  {{ item.author?.displayName ?? t('comments.unknownAuthor') }} ·
                  <span class="font-mono">{{ item.anchorValid ? `${typeById.get(item.anchor.widgetId) ?? 'Widget'} · ` : '' }}#{{ item.anchor.widgetId }}</span>
                  <span
                    v-if="item.variantNames.length"
                    class="font-mono"
                  > · {{ item.variantNames.join(', ') }}</span>
                </span>
                <span
                  v-if="note(item)"
                  class="mt-0.5 block text-xs text-warning"
                  :class="item.anchorValid && !item.missingVariants.length ? 'text-muted' : ''"
                  data-comment-note
                >{{ note(item) }}</span>
              </span>
              <span class="flex items-center gap-2 text-xs leading-5 whitespace-nowrap text-dimmed">
                <time
                  v-if="item.latestActivityAt"
                  :datetime="item.latestActivityAt"
                >{{ relativeTime(item.latestActivityAt, locale) }}</time>
                <span class="inline-flex items-center gap-0.5">
                  <UIcon
                    name="i-lucide-message-circle"
                    class="size-3"
                  />{{ item.messageCount }}
                  <span class="sr-only">{{ t('reviews.messageCount', item.messageCount) }}</span>
                </span>
              </span>
            </button>
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
