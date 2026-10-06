<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { navigateTo, useI18n } from '#imports'
import type { TabsItem } from '@nuxt/ui'
import type { ReviewResolution } from '../../../src/domain/reviews/schema'
import { useReviewInbox } from '../../composables/useReviewInbox'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'
import { relativeTime } from '../../utils/widget-inspection'
import { memberInitials } from '../../utils/member-initials'
import {
	activeFacetCount,
	DEFAULT_INBOX_STATUS,
	DISMISS_RESOLUTIONS,
	INBOX_RESOLUTIONS,
	isDismissal,
	RESOLVE_RESOLUTIONS,
	VIEW_WIDE_SCOPE,
	WORKSPACE_VIEW_TOKEN,
	type InboxFilter,
	type InboxStatus,
	type InboxThread,
} from '../../utils/review-inbox'
import ReviewInboxFilters from './ReviewInboxFilters.vue'
import WbErrorDescription from './WbErrorDescription.vue'

/**
 * The Reviews queue (brief d): status tabs, quick toggles, structured filters and the grouped,
 * keyboard-first list. Ready for review comes before Open, each by latest activity (Part 7 10a).
 * The list is a listbox: J / K or the arrow keys move, Enter opens.
 */
const props = withDefaults(defineProps<{ phone?: boolean; keyboard?: boolean }>(), { phone: false, keyboard: true })
const emit = defineEmits<{ (e: 'open', threadId: string): void; (e: 'compose'): void }>()

const { t, locale } = useI18n()
const fmt = useWorkbenchFormat()
const inbox = useReviewInbox()

/** The same words and counts as the Overview attention line: "1 waiting for review · 4 open". */
const waitingSummary = computed(() => {
	const ready = inbox.totals.value['ready-for-review']
	const open = inbox.totals.value.open
	const parts = [ready ? t('overview.attentionReady', ready) : '', open ? t('overview.attentionOpen', open) : ''].filter(Boolean)
	return parts.length ? parts.join(' · ') : t('inbox.waiting', 0)
})

// ---------------------------------------------------------------------------------------------
// Status tabs: Inbox (ready + open), Ready, Open, Resolved (verified, answered), Dismissed
// ---------------------------------------------------------------------------------------------

type TabValue = 'inbox' | 'ready' | 'open' | 'resolved' | 'dismissed'
const TAB_STATUS: Record<TabValue, readonly InboxStatus[]> = {
	inbox: DEFAULT_INBOX_STATUS,
	ready: ['ready-for-review'],
	open: ['open'],
	resolved: ['resolved'],
	dismissed: ['dismissed'],
}
const TABS: readonly TabValue[] = ['inbox', 'ready', 'open', 'resolved', 'dismissed']

const tab = computed<TabValue | undefined>({
	get: () => TABS.find((value) => {
		const wanted = TAB_STATUS[value]
		const status = inbox.filter.value.status
		return wanted.length === status.length && wanted.every(item => status.includes(item))
	}),
	set: (value) => {
		if (!value) return
		inbox.setFilter({ status: [...TAB_STATUS[value]], resolution: [] })
	},
})

const tabItems = computed<TabsItem[]>(() => {
	const counts = inbox.counts.value
	const badge = (n: number, annotation = false) => n ? { label: String(n), color: annotation ? 'annotation' as const : 'neutral' as const, variant: 'soft' as const, size: 'sm' as const } : undefined
	return [
		{ value: 'inbox', label: t('inbox.tab.inbox'), badge: badge(counts['ready-for-review'] + counts.open) },
		// Five tabs share the 440px list: the short "Ready" keeps every label whole (the group heading says it in full).
		{ value: 'ready', label: t('inbox.tab.ready'), badge: badge(counts['ready-for-review']) },
		{ value: 'open', label: t('inbox.group.open'), badge: badge(counts.open, true) },
		{ value: 'resolved', label: t('inbox.group.resolved') },
		{ value: 'dismissed', label: t('inbox.group.dismissed') },
	]
})

function selectTab(index: number): void {
	const value = TABS[index]
	if (value) tab.value = value
}

/** Resolution chips follow the tab: Resolved narrows Answered / Verified, Dismissed the three dismissals. */
const resolutionChips = computed<readonly ReviewResolution[]>(() => {
	const status = inbox.filter.value.status
	if (!status.length) return INBOX_RESOLUTIONS
	return [...(status.includes('resolved') ? RESOLVE_RESOLUTIONS : []), ...(status.includes('dismissed') ? DISMISS_RESOLUTIONS : [])]
})

function toggleResolution(resolution: ReviewResolution): void {
	const current = inbox.filter.value.resolution
	inbox.setFilter({ resolution: current.includes(resolution) ? current.filter(item => item !== resolution) : [...current, resolution] })
}

// ---------------------------------------------------------------------------------------------
// Search (debounced into the URL), quick toggles, filter chips
// ---------------------------------------------------------------------------------------------

const search = ref(inbox.filter.value.search)
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, (value) => {
	clearTimeout(searchTimer)
	searchTimer = setTimeout(() => {
		if (value !== inbox.filter.value.search) inbox.setFilter({ search: value })
	}, 200)
})
watch(() => inbox.filter.value.search, (value) => {
	if (value !== search.value) search.value = value
})

const filtersOpen = ref(false)
const facetCount = computed(() => activeFacetCount({ ...inbox.filter.value, resolution: [] }))

type Chip = Readonly<{ key: string; label: string; remove: () => void }>
const chips = computed<readonly Chip[]>(() => {
	const filter = inbox.filter.value
	const threads = inbox.threads.value
	const result: Chip[] = []
	const drop = <K extends keyof InboxFilter>(key: K, value: string) => () => inbox.setFilter({ [key]: (filter[key] as readonly string[]).filter(item => item !== value) } as Partial<InboxFilter>)
	for (const id of filter.views) {
		const name = id === WORKSPACE_VIEW_TOKEN ? t('inbox.filter.workspace') : threads.find(item => item.viewId === id)?.viewName ?? t('inbox.viewMissing')
		result.push({ key: `view-${id}`, label: t('inbox.chip.view', { value: name }), remove: drop('views', id) })
	}
	for (const scope of filter.scopes)
		result.push({ key: `scope-${scope}`, label: t('inbox.chip.scope', { value: scope === VIEW_WIDE_SCOPE ? t('inbox.filter.viewWide') : scope }), remove: drop('scopes', scope) })
	for (const author of filter.authors) {
		const actor = threads.find(item => item.author && (item.author.id ?? `name:${item.author.displayName ?? item.author.type}`) === author)?.author
		result.push({ key: `author-${author}`, label: t('inbox.chip.author', { value: actor?.displayName ?? author }), remove: drop('authors', author) })
	}
	for (const state of filter.anchor)
		result.push({ key: `anchor-${state}`, label: t('inbox.chip.anchor', { value: t(state === 'valid' ? 'inbox.filter.anchorValid' : state === 'stale' ? 'inbox.filter.stale' : 'inbox.filter.missing') }), remove: drop('anchor', state) })
	for (const domain of filter.domains)
		result.push({ key: `domain-${domain}`, label: t('inbox.chip.domain', { value: domain }), remove: drop('domains', domain) })
	return result
})

const hasNarrowing = computed(() => {
	const filter = inbox.filter.value
	return chips.value.length > 0 || filter.mine || filter.unread || !!filter.search.trim() || filter.resolution.length > 0
})

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

const STATUS_ICON = {
	'open': { name: 'i-lucide-circle-dot', class: 'text-annotation' },
	'ready-for-review': { name: 'i-lucide-eye', class: 'text-info' },
	'resolved': { name: 'i-lucide-circle-check', class: 'text-success' },
	'dismissed': { name: 'i-lucide-circle-slash', class: 'text-muted' },
} as const

function groupLabel(status: InboxStatus): string {
	return t(status === 'ready-for-review' ? 'inbox.group.ready' : status === 'open' ? 'inbox.group.open' : status === 'dismissed' ? 'inbox.group.dismissed' : 'inbox.group.resolved')
}

/** "Workspace" for a Workspace thread, else the View name (or that it is missing). */
function placeText(item: InboxThread): string {
	return item.scope === 'workspace' ? t('inbox.workspaceRow') : item.viewName ?? t('inbox.viewMissing')
}

function authorName(item: InboxThread): string {
	return item.author?.displayName ?? item.author?.id ?? t('comments.unknownAuthor')
}

function scopeText(item: InboxThread): string {
	return item.variantNames.length ? fmt.list(item.variantNames) : t('inbox.filter.viewWide')
}

/** The row's accessible name joins status, author, title, place and time (brief d, section 11). */
function rowLabel(item: InboxThread): string {
	return [
		groupLabel(item.inboxStatus),
		item.status === 'resolved' && item.resolution ? t(`comments.resolution.${item.resolution}`) : '',
		inbox.isUnread(item) ? t('inbox.updated') : '',
		authorName(item),
		item.title ?? '',
		item.scope === 'workspace' ? t('comments.workspaceComment') : `${placeText(item)}${t('common.clauseSeparator')}${scopeText(item)}`,
		item.widgetId ? `#${item.widgetId}` : '',
		item.anchorState === 'missing' ? t('inbox.anchorMissing') : item.anchorState === 'stale' ? t('comments.staleWord') : '',
		item.latestActivityAt ? relativeTime(item.latestActivityAt, locale.value) : '',
		t('reviews.messageCount', item.messageCount),
	].filter(Boolean).join(t('common.clauseSeparator'))
}

const listbox = ref<HTMLElement>()

function activate(id: string): void {
	inbox.select(id)
	emit('open', id)
}

function scrollSelectedIntoView(): void {
	void nextTick(() => {
		const id = inbox.selectedId.value
		if (id) listbox.value?.querySelector<HTMLElement>(`[data-review-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
	})
}
watch(() => inbox.selectedId.value, scrollSelectedIntoView)

function onListKeydown(event: KeyboardEvent): void {
	if (event.metaKey || event.ctrlKey || event.altKey) return
	const id = inbox.selectedId.value
	if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
		event.preventDefault()
		const next = id ? inbox.neighbour(id, event.key === 'ArrowDown' ? 1 : -1) : inbox.ordered.value[0]?.id
		if (next) inbox.select(next)
	}
	else if (event.key === 'Home' || event.key === 'End') {
		event.preventDefault()
		const list = inbox.ordered.value
		const next = event.key === 'Home' ? list[0] : list.at(-1)
		if (next) inbox.select(next.id)
	}
	else if (event.key === 'Enter' && id) {
		event.preventDefault()
		emit('open', id)
	}
}

const searchInput = ref<{ inputRef?: HTMLInputElement }>()

const heading = ref<HTMLElement>()

defineExpose({
	focusList: () => listbox.value?.focus(),
	focusHeading: () => heading.value?.focus(),
	focusSearch: () => searchInput.value?.inputRef?.focus(),
	openFilters: () => { filtersOpen.value = true },
	selectTab,
	scrollSelectedIntoView,
})

// ---------------------------------------------------------------------------------------------
// Empty states (brief d, section 9)
// ---------------------------------------------------------------------------------------------

const total = computed(() => inbox.threads.value.length)
const emptyKind = computed<'none' | 'caught-up' | 'no-match' | undefined>(() => {
	if (inbox.ordered.value.length) return undefined
	if (!total.value) return 'none'
	const defaultQueue = tab.value === 'inbox' && !hasNarrowing.value
	if (defaultQueue && inbox.totals.value.resolved + inbox.totals.value.dismissed === total.value) return 'caught-up'
	return 'no-match'
})
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col"
    data-review-inbox
  >
    <div class="grid gap-3 px-4 pt-4 pb-2">
      <div class="flex min-w-0 items-center gap-2">
        <!-- Phones already title the page in the top bar; the heading stays for assistive tech. -->
        <h1
          ref="heading"
          tabindex="-1"
          class="shrink-0 text-headline font-semibold text-highlighted outline-none"
          :class="props.phone ? 'sr-only' : ''"
          data-review-heading
        >
          {{ t('inbox.title') }}
        </h1>
        <span
          v-if="inbox.loaded.value"
          class="min-w-0 truncate text-xs text-dimmed tabular-nums"
          :title="waitingSummary"
        >{{ waitingSummary }}</span>
        <span class="flex-1" />
        <UButton
          v-if="inbox.canReply.value"
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-message-square-plus"
          :label="t('inbox.newComment')"
          data-review-new-comment
          @click="emit('compose')"
        />
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-refresh-cw"
          :loading="inbox.loading.value"
          :aria-label="t('common.refresh')"
          data-review-refresh
          @click="inbox.loadSummaries()"
        />
      </div>

      <div class="flex min-w-0 items-center gap-2">
        <UInput
          ref="searchInput"
          v-model="search"
          type="search"
          icon="i-lucide-search"
          :placeholder="t('inbox.search')"
          :aria-label="t('inbox.search')"
          class="min-w-0 flex-1"
          :ui="{ base: 'pointer-coarse:text-base' }"
          data-review-search
          @keydown.escape="search = ''"
        >
          <template
            v-if="keyboard && !search"
            #trailing
          >
            <UKbd value="/" />
          </template>
        </UInput>
        <UDrawer
          v-if="phone"
          v-model:open="filtersOpen"
          :title="t('inbox.filters')"
          :ui="{ body: 'pb-[max(1rem,env(safe-area-inset-bottom))]' }"
        >
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-list-filter"
            :aria-label="facetCount ? t('inbox.filtersActive', { n: facetCount }) : t('inbox.filters')"
            data-review-filters-toggle
          >
            <UBadge
              v-if="facetCount"
              color="neutral"
              variant="soft"
              size="sm"
              :label="String(facetCount)"
            />
          </UButton>
          <template #body>
            <ReviewInboxFilters />
          </template>
        </UDrawer>
        <UPopover
          v-else
          v-model:open="filtersOpen"
          :content="{ align: 'end' }"
        >
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-list-filter"
            :label="t('inbox.filters')"
            data-review-filters-toggle
          >
            <template
              v-if="facetCount"
              #trailing
            >
              <UBadge
                color="neutral"
                variant="soft"
                size="sm"
                :label="String(facetCount)"
              />
            </template>
          </UButton>
          <template #content>
            <div class="w-80 max-w-[calc(100vw-2rem)] p-3">
              <ReviewInboxFilters />
            </div>
          </template>
        </UPopover>
      </div>

      <div
        class="flex flex-wrap items-center gap-1"
        role="group"
        :aria-label="t('inbox.quickFilters')"
      >
        <UTooltip
          v-if="inbox.me.value"
          :text="t('inbox.mineHint')"
        >
          <UButton
            size="xs"
            color="neutral"
            :variant="inbox.filter.value.mine ? 'soft' : 'ghost'"
            :icon="inbox.filter.value.mine ? 'i-lucide-check' : 'i-lucide-user-round'"
            :aria-pressed="inbox.filter.value.mine"
            :label="t('inbox.mine')"
            data-review-toggle="mine"
            @click="inbox.setFilter({ mine: !inbox.filter.value.mine })"
          />
        </UTooltip>
        <UTooltip :text="t('inbox.updatedHint')">
          <UButton
            size="xs"
            color="neutral"
            :variant="inbox.filter.value.unread ? 'soft' : 'ghost'"
            :icon="inbox.filter.value.unread ? 'i-lucide-check' : 'i-lucide-bell-dot'"
            :aria-pressed="inbox.filter.value.unread"
            :label="t('inbox.updated')"
            data-review-toggle="unread"
            @click="inbox.setFilter({ unread: !inbox.filter.value.unread })"
          />
        </UTooltip>
        <template v-if="chips.length">
          <span
            class="mx-1 h-4 w-px bg-accented"
            aria-hidden="true"
          />
          <UButton
            v-for="chip in chips"
            :key="chip.key"
            size="xs"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-x"
            :label="chip.label"
            :aria-label="t('inbox.removeFilter', { filter: chip.label })"
            class="max-w-full"
            :ui="{ label: 'truncate' }"
            data-review-chip
            @click="chip.remove()"
          />
        </template>
        <UButton
          v-if="hasNarrowing"
          size="xs"
          color="neutral"
          variant="link"
          :label="t('inbox.clearAll')"
          data-review-clear
          @click="inbox.clearFilters()"
        />
      </div>
    </div>

    <UTabs
      v-model="tab"
      :items="tabItems"
      :content="false"
      variant="link"
      color="primary"
      :aria-label="t('inbox.statusLabel')"
      :ui="{ root: 'shrink-0 gap-0', list: 'border-b border-default px-2 overflow-x-auto', trigger: 'shrink-0 px-2', label: 'whitespace-nowrap', trailingBadge: 'tabular-nums' }"
      data-review-tabs
    />

    <div
      v-if="resolutionChips.length"
      class="flex flex-wrap items-center gap-1 border-b border-default px-4 py-2"
      role="group"
      :aria-label="t('inbox.resolutionLabel')"
      data-review-resolutions
    >
      <UButton
        v-for="resolution in resolutionChips"
        :key="resolution"
        size="xs"
        color="neutral"
        :variant="inbox.filter.value.resolution.includes(resolution) ? 'soft' : 'ghost'"
        :icon="inbox.filter.value.resolution.includes(resolution) ? 'i-lucide-check' : undefined"
        :aria-pressed="inbox.filter.value.resolution.includes(resolution)"
        :label="t(`comments.resolution.${resolution}`)"
        :data-review-resolution-filter="resolution"
        @click="toggleResolution(resolution)"
      />
    </div>

    <UAlert
      v-if="inbox.loadError.value"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="inbox.loadError.value.message"
      :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => { void inbox.loadSummaries() } }]"
      class="rounded-none"
    >
      <template #description>
        <WbErrorDescription
          :headline="inbox.loadError.value.message"
          :diagnostics="inbox.loadError.value.diagnostics"
          :status-code="inbox.loadError.value.statusCode"
        />
      </template>
    </UAlert>

    <div
      ref="listbox"
      class="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      role="listbox"
      tabindex="0"
      :aria-label="t('inbox.listLabel')"
      :aria-activedescendant="inbox.selectedId.value && inbox.threadById.value.has(inbox.selectedId.value) ? `review-row-${inbox.selectedId.value}` : undefined"
      data-review-list
      @keydown="onListKeydown"
    >
      <div
        v-if="!inbox.loaded.value"
        class="grid gap-3 px-4 py-3"
        aria-hidden="true"
      >
        <div
          v-for="index in 6"
          :key="index"
          class="grid grid-cols-[16px_24px_minmax(0,1fr)] items-start gap-x-2"
        >
          <USkeleton
            class="mt-1 size-4 rounded-full"
            :aria-label="t('common.loading')"
          />
          <USkeleton
            class="size-6 rounded-full"
            :aria-label="t('common.loading')"
          />
          <div class="grid gap-1.5">
            <USkeleton
              class="h-4 w-4/5"
              :aria-label="t('common.loading')"
            />
            <USkeleton
              class="h-3 w-1/2"
              :aria-label="t('common.loading')"
            />
          </div>
        </div>
      </div>

      <template v-else-if="inbox.ordered.value.length">
        <div
          v-for="group in inbox.groups.value"
          :key="group.status"
          role="group"
          :aria-label="t('inbox.groupLabel', { group: groupLabel(group.status), n: group.threads.length })"
          :data-review-group="group.status"
        >
          <div
            class="sticky top-0 z-1 flex items-center gap-1.5 bg-default px-4 pt-3 pb-1 text-xs font-medium text-muted"
            role="presentation"
          >
            {{ groupLabel(group.status) }}
            <span class="text-dimmed tabular-nums">{{ group.threads.length }}</span>
          </div>
          <div
            v-for="item in group.threads"
            :id="`review-row-${item.id}`"
            :key="item.id"
            role="option"
            :aria-selected="inbox.selectedId.value === item.id"
            :aria-label="rowLabel(item)"
            class="relative grid cursor-pointer grid-cols-[16px_24px_minmax(0,1fr)_auto] items-start gap-x-2 px-4 hover:bg-muted"
            :class="[
              phone ? 'min-h-15 py-2.5' : 'py-2',
              inbox.selectedId.value === item.id ? 'bg-selection-subtle hover:bg-selection-subtle' : '',
            ]"
            :data-review-row="item.id"
            :data-review-status="item.status"
            :data-review-inbox-status="item.inboxStatus"
            :data-review-scope="item.scope"
            :data-unread="inbox.isUnread(item) ? '' : undefined"
            @click="activate(item.id)"
          >
            <span
              v-if="inbox.selectedId.value === item.id"
              class="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary"
              aria-hidden="true"
            />
            <UIcon
              :name="STATUS_ICON[item.inboxStatus].name"
              class="mt-0.5 size-4"
              :class="STATUS_ICON[item.inboxStatus].class"
              aria-hidden="true"
            />
            <UAvatar
              :text="item.author && item.author.type === 'human' ? memberInitials(authorName(item)) : undefined"
              :icon="item.author?.type === 'agent' ? 'i-lucide-bot' : item.author ? (item.author.type === 'human' ? undefined : 'i-lucide-cog') : 'i-lucide-message-circle'"
              size="xs"
              aria-hidden="true"
            />
            <span
              class="min-w-0"
              aria-hidden="true"
            >
              <span class="flex min-w-0 items-center gap-1.5">
                <span
                  v-if="inbox.isUnread(item)"
                  class="size-1.5 shrink-0 rounded-full bg-inverted"
                />
                <span
                  class="truncate text-sm text-highlighted"
                  :class="inbox.isUnread(item) ? 'font-semibold' : ''"
                >{{ item.title ?? (inbox.detailErrors.value.has(item.id) ? t('inbox.unreadableTitle') : item.scope === 'workspace' ? t('comments.workspaceComment') : `#${item.widgetId ?? ''}`) }}</span>
              </span>
              <span class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
                <span class="inline-flex min-w-0 items-center gap-1 truncate">{{ authorName(item) }} ·
                  <UIcon
                    v-if="item.scope === 'workspace'"
                    name="i-lucide-globe"
                    class="size-3.5 shrink-0"
                    data-review-workspace-icon
                  />{{ placeText(item) }}{{ item.variantNames.length ? ` › ${scopeText(item)}` : '' }}</span>
                <span
                  v-if="item.widgetId"
                  class="font-mono"
                  :class="item.anchorState === 'missing' ? 'text-warning' : ''"
                >#{{ item.widgetId }}</span>
                <span
                  v-if="item.anchorState !== 'valid'"
                  class="inline-flex items-center gap-0.5 text-warning"
                  data-review-anchor-warning
                >
                  <UIcon
                    :name="item.anchorState === 'missing' ? 'i-lucide-unlink' : 'i-lucide-history'"
                    class="size-3.5"
                  />{{ item.anchorState === 'missing' ? t('inbox.anchorMissing') : t('comments.staleWord') }}
                </span>
                <template v-if="item.status === 'ready-for-review'">
                  <span
                    v-for="domain in item.domains"
                    :key="domain"
                    class="rounded-sm border border-default px-1 font-mono"
                  >{{ domain }}</span>
                </template>
                <span
                  v-if="item.status === 'resolved' && item.resolution"
                  class="inline-flex items-center gap-0.5"
                  :class="isDismissal(item.resolution) ? 'text-muted' : 'text-success'"
                  :data-row-resolution="item.resolution"
                >
                  <UIcon
                    :name="isDismissal(item.resolution) ? 'i-lucide-circle-slash' : 'i-lucide-circle-check'"
                    class="size-3.5"
                  />{{ isDismissal(item.resolution) ? t('inbox.timeline.dismissedChip', { resolution: t(`comments.resolution.${item.resolution}`) }) : t(`comments.resolution.${item.resolution}`) }}
                </span>
              </span>
            </span>
            <span
              class="flex items-center gap-2 text-xs leading-5 whitespace-nowrap text-muted"
              aria-hidden="true"
            >
              <time
                v-if="item.latestActivityAt"
                :datetime="item.latestActivityAt"
                :title="fmt.dateTime(item.latestActivityAt)"
              >{{ relativeTime(item.latestActivityAt, locale) }}</time>
              <span class="inline-flex items-center gap-0.5 tabular-nums">
                <UIcon
                  name="i-lucide-message-circle"
                  class="size-3"
                />{{ item.messageCount }}
              </span>
            </span>
          </div>
        </div>
      </template>

      <div
        v-else-if="emptyKind === 'caught-up'"
        class="grid justify-items-start gap-2 px-4 py-8"
        data-review-empty="caught-up"
      >
        <UIcon
          name="i-lucide-circle-check"
          class="size-5 text-success"
        />
        <p class="text-title font-semibold text-highlighted">
          {{ t('inbox.caughtUp') }}
        </p>
        <p class="text-sm text-muted">
          {{ [inbox.totals.value.resolved ? t('inbox.resolvedCount', inbox.totals.value.resolved) : '', inbox.totals.value.dismissed ? t('inbox.dismissedCount', { n: inbox.totals.value.dismissed }) : ''].filter(Boolean).join(' · ') }}
        </p>
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          :label="t('comments.showResolved')"
          @click="tab = 'resolved'"
        />
      </div>

      <UEmpty
        v-else-if="emptyKind === 'no-match'"
        icon="i-lucide-list-filter"
        :title="t('inbox.noMatch')"
        variant="naked"
        size="sm"
        :actions="hasNarrowing ? [{ label: t('inbox.clearFilters'), color: 'neutral', variant: 'outline', onClick: () => inbox.clearFilters() }] : [{ label: t('inbox.tab.inbox'), color: 'neutral', variant: 'outline', onClick: () => { tab = 'inbox' } }]"
        data-review-empty="no-match"
      />

      <UEmpty
        v-else
        icon="i-lucide-inbox"
        :title="t('inbox.empty.title')"
        :description="t('inbox.empty.body')"
        variant="naked"
        size="sm"
        :actions="[{ label: t('inbox.goToViews'), icon: 'i-lucide-app-window', color: 'neutral', variant: 'outline', onClick: () => { void navigateTo('/views') } }]"
        data-review-empty="none"
      />
    </div>

    <p
      v-if="keyboard && inbox.ordered.value.length"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-default px-4 py-2 text-xs text-muted"
      data-review-keys
    >
      <span class="inline-flex items-center gap-1"><UKbd value="J" /><UKbd value="K" />{{ t('inbox.keys.move') }}</span>
      <span class="inline-flex items-center gap-1"><UKbd value="R" />{{ t('inbox.keys.reply') }}</span>
      <span class="inline-flex items-center gap-1"><UKbd value="E" />{{ t('inbox.keys.resolve') }}</span>
      <span class="inline-flex items-center gap-1"><UKbd value="O" />{{ t('inbox.keys.open') }}</span>
    </p>
  </div>
</template>
