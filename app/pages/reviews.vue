<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { defineShortcuts, useI18n } from '#imports'
import { provideReviewInbox } from '../composables/useReviewInbox'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../composables/useMediaQuery'
import { useWorkbenchShell } from '../composables/useWorkbenchShell'
import ReviewInboxList from '../components/workbench/ReviewInboxList.vue'
import ReviewThreadDetail from '../components/workbench/ReviewThreadDetail.vue'

/**
 * The Reviews inbox, the review desk's home (brief d; roadmap R8). Desktop is master–detail;
 * tablet opens the thread in a slide-over; a phone opens it in a bottom sheet where a reviewer
 * reads, replies, resolves and reopens. The filter and the open thread ride in the URL.
 */
const { t } = useI18n()
const inbox = provideReviewInbox()
const shell = useWorkbenchShell()

const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const isPhone = useMediaQuery('(max-width: 767.98px)')
/** Touch: no keyboard hints (brief c, section 9); the shortcuts still work with a keyboard. */
const coarse = useMediaQuery('(pointer: coarse)')

const list = ref<InstanceType<typeof ReviewInboxList>>()
const detail = ref<InstanceType<typeof ReviewThreadDetail>>()

onMounted(() => { void inbox.loadSummaries() })

/** A deep link to a thread this Workspace does not have. */
const missingThread = computed(() => inbox.loaded.value && !!inbox.selectedId.value && !inbox.selected.value)

/**
 * Below desktop the thread opens over the list; closing it clears `?thread`. The sheet mounts
 * closed and opens a frame later: a drawer mounted already open (a deep link) reports itself
 * closed at once, which would drop the thread from the URL.
 */
const overlayMounted = ref(false)
onMounted(() => requestAnimationFrame(() => { overlayMounted.value = true }))
const overlayOpen = computed({
	get: () => overlayMounted.value && !isDesktop.value && !!inbox.selected.value,
	set: (open: boolean) => {
		// The sheet also reports its initial closed state; only a real dismissal closes the thread.
		if (!open && overlayMounted.value && !isDesktop.value && inbox.selected.value) closeDetail()
	},
})

/** The sheet and slide-over open on the thread title, never on a button or the keyboard-raising reply. */
const overlayContent = { onOpenAutoFocus: (event: Event) => event.preventDefault() }
watch(() => overlayOpen.value && inbox.selectedId.value, (open) => {
	if (open) void detailReady().then(view => view?.focusHeading())
})

function closeDetail(): void {
	inbox.select(undefined)
	void nextTick(() => list.value?.focusList())
}

/** Waits for the detail to mount (a slide-over or sheet mounts lazily). */
async function detailReady(): Promise<InstanceType<typeof ReviewThreadDetail> | undefined> {
	for (let frame = 0; frame < 30 && !detail.value; frame++) {
		await nextTick()
		await new Promise(resolve => requestAnimationFrame(resolve))
	}
	return detail.value
}

function onOpen(): void {
	if (isDesktop.value) void detailReady().then(view => view?.focusHeading())
}

/** After a resolve: desktop moves on to the next thread in the queue; tablet and phone return to the list. */
function onResolved(next: string | undefined): void {
	if (isDesktop.value) inbox.select(next)
	else closeDetail()
}

// ---------------------------------------------------------------------------------------------
// Keyboard triage (brief d, section 10): J/K, R, E, Shift+E, O, /, F, 1–4
// ---------------------------------------------------------------------------------------------

/** Another menu, select or dialog owns the keyboard (the thread's own sheet does not count). */
function keyboardBusy(): boolean {
	return !!document.querySelector('[data-reka-popper-content-wrapper] :is([role="menu"], [role="listbox"], [role="dialog"]), [role="dialog"][data-state="open"]:not(:has([data-review-detail]))')
}

// `G` then `R` is the shell's "go to Reviews"; its `R` is not a reply.
let lastG = 0
function onKeydown(event: KeyboardEvent): void {
	const target = event.target as HTMLElement | null
	if (target?.closest('input, textarea, [contenteditable="true"]')) return
	if (event.key === 'g' && !event.metaKey && !event.ctrlKey && !event.altKey) lastG = Date.now()
}
onMounted(() => window.addEventListener('keydown', onKeydown, { capture: true }))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, { capture: true }))

function guard(run: () => void): () => void {
	return () => {
		if (keyboardBusy() || Date.now() - lastG < 800) return
		run()
	}
}

function move(step: 1 | -1): void {
	const id = inbox.selectedId.value
	const next = id && inbox.selected.value ? inbox.neighbour(id, step) : inbox.ordered.value[0]?.id
	if (next) inbox.select(next)
}

function withThread(run: (view: InstanceType<typeof ReviewThreadDetail>) => void): void {
	if (!inbox.selected.value) return
	void detailReady().then(view => view && run(view))
}

defineShortcuts(computed(() => shell.singleKeyShortcuts.value
	? {
			'j': guard(() => move(1)),
			'k': guard(() => move(-1)),
			'r': guard(() => withThread(view => view.focusReply())),
			'e': guard(() => withThread(view => void view.resolvePrimary())),
			'shift_e': guard(() => withThread(view => view.openResolveMenu())),
			'o': guard(() => { if (inbox.selected.value) inbox.openInCanvas(inbox.selected.value) }),
			'/': guard(() => list.value?.focusSearch()),
			'f': guard(() => list.value?.openFilters()),
			'1': guard(() => list.value?.selectTab(0)),
			'2': guard(() => list.value?.selectTab(1)),
			'3': guard(() => list.value?.selectTab(2)),
			'4': guard(() => list.value?.selectTab(3)),
		}
	: {}))
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <UDashboardPanel
      id="reviews-list"
      :resizable="isDesktop"
      :default-size="isDesktop ? 440 : undefined"
      :min-size="isDesktop ? 360 : undefined"
      :max-size="isDesktop ? 640 : undefined"
      :ui="{ root: isDesktop ? 'min-h-0 border-e border-default' : 'min-h-0 min-w-0', body: 'gap-0 p-0 sm:p-0 overflow-hidden' }"
    >
      <template #body>
        <main
          id="main"
          data-landmark="main"
          tabindex="-1"
          class="flex min-h-0 flex-1 flex-col"
          :aria-label="t('inbox.title')"
        >
          <UAlert
            v-if="missingThread && !isDesktop"
            color="warning"
            variant="subtle"
            icon="i-lucide-search-x"
            :title="t('inbox.threadMissing')"
            :actions="[{ label: t('common.dismiss'), size: 'xs', color: 'neutral', variant: 'outline', onClick: () => inbox.select(undefined) }]"
            class="rounded-none"
            data-review-thread-missing
          />
          <ReviewInboxList
            ref="list"
            :phone="isPhone"
            :keyboard="!isPhone && !coarse && shell.singleKeyShortcuts.value"
            @open="onOpen"
          />
        </main>
      </template>
    </UDashboardPanel>

    <UDashboardPanel
      v-if="isDesktop"
      id="reviews-thread"
      :ui="{ root: 'min-h-0 min-w-0', body: 'gap-0 p-0 sm:p-0 overflow-hidden' }"
    >
      <template #body>
        <section
          data-landmark="complementary"
          :aria-label="inbox.selected.value?.title ?? t('inbox.threadPane')"
          class="flex min-h-0 flex-1 flex-col"
        >
          <div class="flex min-h-0 w-full flex-1 flex-col">
            <ReviewThreadDetail
              v-if="inbox.selected.value"
              ref="detail"
              layout="pane"
              @resolved="(_, next) => onResolved(next)"
            />
            <UEmpty
              v-else-if="missingThread"
              icon="i-lucide-search-x"
              :title="t('inbox.threadMissing')"
              :description="t('inbox.threadMissingHint')"
              variant="naked"
              :actions="[{ label: t('inbox.backToQueue'), color: 'neutral', variant: 'outline', onClick: () => inbox.select(undefined) }]"
              class="my-auto"
              data-review-thread-missing
            />
            <UEmpty
              v-else-if="inbox.ordered.value.length"
              icon="i-lucide-mouse-pointer-click"
              :title="t('inbox.selectTitle')"
              :description="shell.singleKeyShortcuts.value ? t('inbox.selectHint') : t('inbox.selectHintNoKeys')"
              variant="naked"
              class="my-auto"
              data-review-detail-empty
            />
          </div>
        </section>
      </template>
    </UDashboardPanel>

    <UDrawer
      v-if="isPhone"
      v-model:open="overlayOpen"
      :title="inbox.selected.value?.title ?? t('inbox.threadPane')"
      :description="t('inbox.sheetDescription')"
      :content="overlayContent"
      :ui="{ content: 'max-h-[92dvh]', header: 'sr-only', body: 'flex min-h-0 flex-1 flex-col p-0 sm:p-0', container: 'gap-0 p-0 pt-2' }"
    >
      <template #body>
        <ReviewThreadDetail
          ref="detail"
          layout="sheet"
          @close="closeDetail"
          @resolved="(_, next) => onResolved(next)"
        />
      </template>
    </UDrawer>

    <USlideover
      v-else-if="!isDesktop"
      v-model:open="overlayOpen"
      side="right"
      :title="inbox.selected.value?.title ?? t('inbox.threadPane')"
      :description="t('inbox.sheetDescription')"
      :close="false"
      :content="overlayContent"
      :ui="{ content: 'max-w-xl', header: 'sr-only', body: 'flex min-h-0 flex-1 flex-col p-0 sm:p-0' }"
    >
      <template #body>
        <ReviewThreadDetail
          ref="detail"
          layout="slideover"
          @close="closeDetail"
          @resolved="(_, next) => onResolved(next)"
        />
      </template>
    </USlideover>

    <div
      class="sr-only"
      role="status"
      aria-live="polite"
    >
      {{ inbox.announcement.value }}
    </div>
  </div>
</template>
