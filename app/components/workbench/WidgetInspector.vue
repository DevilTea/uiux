<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n, useToast } from '#imports'
import type { BreadcrumbItem, TableColumn } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import { useWidgetInspection, type WidgetThreadRow } from '../../composables/useWidgetInspection'
import { actorInitials, formatStateValue, relativeTime, truncateMiddle, widgetTypeIcon } from '../../utils/widget-inspection'

/**
 * The Inspect tab (brief e): a property sheet for the selected Widget. It answers what the Widget
 * is, where it sits, how this Variant changes it, and what is wrong with it or said about it.
 * Identities beyond the Widget id, revisions and raw state wait behind "Details".
 */
const emit = defineEmits<{
	(e: 'comment', widgetId: string): void
	(e: 'openThread', threadId: string): void
	(e: 'openChecks'): void
}>()

const { t, locale } = useI18n()
const toast = useToast()
const workbench = useWorkbench()
const { selectedView, selectedWidgetId, reviewReadOnly, workspace } = workbench
const inspection = useWidgetInspection(workbench)
/** Phones read, reply and resolve; they never create canvas comments (decided). */
const isPhone = useMediaQuery(WORKBENCH_BREAKPOINTS.handset)
const {
	hasSelection, node, missing, irNode, ancestry, label, variantName, variantInvalid, variantFaults,
	overrides, findings, geometry, visibility, threads,
} = inspection

const THREAD_ROWS = 6
const detailsOpen = ref(false)
watch(() => selectedView.value?.key, () => { detailsOpen.value = false })

/** Workspace content is authored in the primary Locale; label excerpts carry it as `lang`. */
const authoredLang = computed(() => workspace.value?.resource.i18n?.defaultLocale || undefined)

const slotItems = computed<BreadcrumbItem[]>(() => {
	const path = ancestry.value
	const current = path.at(-1)
	if (!current) return []
	// Ancestors by Widget id (each selects that Widget), then the Slot this Widget occupies.
	const items: BreadcrumbItem[] = path.slice(0, -1).map(ancestor => ({ label: ancestor.id }))
	items.push({ label: current.slotName !== undefined ? `${current.slotName}[${current.slotIndex}]` : current.id })
	return items
})

const size = computed(() => {
	const rect = geometry.value?.rect
	if (!rect) return undefined
	return {
		size: t('canvas.dimensions', { width: Math.round(rect.width), height: Math.round(rect.height) }),
		position: `${Math.round(rect.x)}, ${Math.round(rect.y)}`,
	}
})

type DiffRow = { property: string; value: string }
const diffRows = computed<DiffRow[]>(() => overrides.value.map(item => ({ property: item.property, value: formatStateValue(item.value) })))
const diffColumns = computed<TableColumn<DiffRow>[]>(() => [
	{ accessorKey: 'property', header: t('inspect.property'), meta: { class: { td: 'text-default' } } },
	{ id: 'base', header: t('inspect.base') },
	{ accessorKey: 'value', header: variantName.value ?? '', meta: { class: { th: 'font-mono', td: 'bg-selection-subtle text-selection-text' } } },
])

const visibleThreads = computed(() => threads.value.slice(0, THREAD_ROWS))

const details = computed(() => {
	const view = selectedView.value
	if (!node.value || !view) return []
	return [
		{ label: t('inspect.detail.type'), value: node.value.type },
		{ label: t('inspect.detail.widgetId'), value: node.value.id, copy: true },
		{ label: t('inspect.detail.depth'), value: String(node.value.depth) },
		{ label: t('inspect.detail.variant'), value: variantName.value ?? t('inspect.detail.baseState'), mono: !!variantName.value },
		{ label: t('inspect.detail.viewId'), value: view.key, copy: true },
		{ label: t('inspect.detail.revision'), value: view.revision, copy: true },
		...(geometry.value ? [{ label: t('inspect.detail.geometry'), value: String(geometry.value.geometryRevision) }] : []),
	]
})

const rawState = computed(() => {
	const config = irNode.value?.config
	const state = variantName.value && node.value ? selectedView.value?.resource.variants[variantName.value]?.state?.[node.value.id] : undefined
	return JSON.stringify({ config: config ?? {}, ...(variantName.value ? { variantState: state ?? {} } : {}) }, null, 2)
})

function statusIcon(status: WidgetThreadRow['status']): string {
	if (status === 'resolved') return 'i-lucide-circle-check'
	if (status === 'ready-for-review') return 'i-lucide-eye'
	return 'i-lucide-circle-dot'
}

function statusClass(status: WidgetThreadRow['status']): string {
	if (status === 'resolved') return 'text-success'
	if (status === 'ready-for-review') return 'text-info'
	return 'text-annotation'
}

function statusLabel(status: WidgetThreadRow['status']): string {
	if (status === 'resolved') return t('reviews.status.resolved')
	if (status === 'ready-for-review') return t('reviews.status.readyForReview')
	return t('reviews.status.open')
}

async function copy(value: string, labelText: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(value)
		toast.add({ title: labelText, color: 'neutral', icon: 'i-lucide-copy' })
	}
	catch {
		toast.add({ title: t('inspect.copyFailed'), color: 'error', icon: 'i-lucide-circle-alert', duration: 0 })
	}
}

function copyWidgetId(): void {
	if (!node.value) return
	const id = `#${node.value.id}`
	void copy(id, t('inspect.copied', { id }))
}

/** `⌘C` / `Ctrl+C` copies the Widget id while focus is in the Inspector and no text is selected. */
function onKeydown(event: KeyboardEvent): void {
	if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'c') return
	const target = event.target as HTMLElement | null
	if (target?.closest('input, textarea, [contenteditable="true"]')) return
	if (!globalThis.getSelection()?.isCollapsed) return
	if (!node.value) return
	event.preventDefault()
	copyWidgetId()
}
</script>

<template>
  <section
    class="flex min-h-0 flex-1 flex-col overflow-y-auto"
    :aria-label="t('inspect.label')"
    data-inspector
    @keydown="onKeydown"
  >
    <!-- Deep link or structure change: the selection names a Widget the View no longer has. -->
    <div
      v-if="missing"
      class="border-b border-default p-3"
    >
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-unlink"
        :title="t('canvas.widgetMissing', { id: `#${selectedWidgetId}` })"
        :actions="[{ label: t('inspect.clearSelection'), color: 'neutral', variant: 'outline', size: 'sm', onClick: () => workbench.selectWidget('root') }]"
        data-widget-missing
      />
    </div>

    <UEmpty
      v-else-if="!hasSelection || !node"
      size="sm"
      variant="naked"
      icon="i-lucide-mouse-pointer-2"
      :title="t('inspect.empty.title')"
      :description="t('inspect.empty.body')"
      class="flex-1"
    />

    <template v-else>
      <!-- What: type, label, and the two things a reviewer does with a Widget. -->
      <header class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 border-b border-default p-3">
        <UIcon
          :name="widgetTypeIcon(node.type, node.children.length > 0)"
          class="mt-0.5 size-5 text-muted"
        />
        <div class="min-w-0">
          <h2
            class="truncate text-title font-semibold text-highlighted"
            translate="no"
          >
            {{ node.type }}
          </h2>
          <p
            v-if="label?.text"
            class="line-clamp-2 text-sm text-muted"
            :lang="authoredLang"
          >
            {{ t('inspect.quoted', { text: label.text }) }}
          </p>
          <p
            v-else-if="label?.messageKey"
            class="truncate font-mono text-xs text-dimmed"
            translate="no"
          >
            {{ label.messageKey }}
          </p>
        </div>
        <div class="flex items-center gap-1">
          <UButton
            v-if="!reviewReadOnly && !isPhone"
            color="annotation"
            variant="soft"
            size="sm"
            icon="i-lucide-message-circle-plus"
            :label="t('tool.comment')"
            data-inspector-comment
            @click="emit('comment', node.id)"
          />
          <UTooltip
            :text="t('inspect.copyId')"
            :kbds="['meta', 'c']"
          >
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-lucide-copy"
              :aria-label="t('inspect.copyId')"
              data-inspector-copy
              @click="copyWidgetId"
            />
          </UTooltip>
        </div>
        <p
          v-if="visibility === 'hidden'"
          class="col-span-3 mt-2 flex items-center gap-1.5 text-sm text-muted"
          data-widget-not-visible
        >
          <UIcon
            name="i-lucide-eye-off"
            class="size-4 shrink-0"
          />
          {{ t('canvas.notVisible') }}
        </p>
      </header>

      <!-- Where. A definition list: no Nuxt UI component renders <dl> semantics. -->
      <dl
        class="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 border-b border-default p-3"
        data-inspector-properties
      >
        <dt class="text-xs/5 text-muted">
          {{ t('inspect.identity') }}
        </dt>
        <dd class="min-w-0">
          <UBadge
            color="neutral"
            variant="soft"
            class="max-w-full font-mono"
            translate="no"
          >
            <span class="truncate">#{{ node.id }}</span>
          </UBadge>
        </dd>

        <template v-if="slotItems.length > 1">
          <dt class="text-xs/5 text-muted">
            {{ t('inspect.slot') }}
          </dt>
          <dd class="min-w-0">
            <UBreadcrumb
              :items="slotItems"
              :aria-label="t('inspect.slotPath')"
              :ui="{ list: 'flex-wrap gap-x-1 gap-y-1', item: 'min-w-0', link: 'p-0 font-mono text-xs', separatorIcon: 'size-3 text-dimmed' }"
              translate="no"
            >
              <template #item="{ item, index }">
                <ULink
                  v-if="index < slotItems.length - 1"
                  as="button"
                  type="button"
                  class="inline-flex min-h-6 items-center rounded-sm font-mono text-xs text-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-coarse:min-h-11"
                  :aria-label="t('inspect.selectWidget', { id: item.label })"
                  @click="workbench.selectWidget(String(item.label))"
                >
                  {{ item.label }}
                </ULink>
                <span
                  v-else
                  class="font-mono text-xs text-default"
                >{{ item.label }}</span>
              </template>
            </UBreadcrumb>
          </dd>
        </template>

        <template v-if="visibility !== 'hidden' && visibility !== 'none'">
          <dt class="text-xs/5 text-muted">
            {{ t('inspect.size') }}
          </dt>
          <dd
            class="min-w-0 text-sm"
            data-inspector-size
          >
            <i18n-t
              v-if="size"
              keypath="inspect.sizeAt"
              tag="span"
              class="text-dimmed"
            >
              <template #size>
                <span
                  class="font-mono text-xs text-default"
                  translate="no"
                >{{ size.size }}</span>
              </template>
              <template #position>
                <span
                  class="font-mono text-xs text-default"
                  translate="no"
                >{{ size.position }}</span>
              </template>
            </i18n-t>
            <span
              v-else-if="visibility === 'offscreen'"
              class="text-muted"
            >{{ t('inspect.offscreen') }}</span>
            <span
              v-else
              class="text-dimmed"
            >{{ t('inspect.measuring') }}</span>
          </dd>
        </template>
      </dl>

      <!-- How this Variant differs. -->
      <section
        v-if="variantName"
        class="grid gap-2 border-b border-default p-3"
        aria-labelledby="inspect-variant-heading"
        data-inspector-variant
      >
        <h3
          id="inspect-variant-heading"
          class="flex min-w-0 items-center gap-2 text-sm font-semibold text-highlighted"
        >
          {{ t('inspect.inVariant') }}
          <UBadge
            color="neutral"
            variant="soft"
            class="min-w-0 font-mono"
            translate="no"
          >
            <span class="truncate">{{ variantName }}</span>
          </UBadge>
        </h3>
        <UAlert
          v-if="variantInvalid || variantFaults.length"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="t('canvas.variantInvalid')"
        >
          <template #description>
            <ul
              v-if="variantFaults.length"
              class="list-disc space-y-0.5 ps-4"
            >
              <li
                v-for="fault in variantFaults"
                :key="fault.code + fault.path"
              >
                <span
                  class="font-mono"
                  translate="no"
                >{{ fault.code }}</span> {{ fault.message }}
              </li>
            </ul>
            <span v-else>{{ t('canvas.variantInvalidHint', { variant: variantName }) }}</span>
          </template>
        </UAlert>
        <UTable
          v-else-if="diffRows.length"
          :data="diffRows"
          :columns="diffColumns"
          :caption="t('inspect.diffCaption', { variant: variantName })"
          :ui="{
            root: 'overflow-visible',
            base: 'w-full table-fixed',
            tbody: 'divide-y divide-(--ui-border-muted)',
            th: 'px-1.5 py-1 text-xs font-medium text-muted border-b border-default',
            td: 'px-1.5 py-1 align-top font-mono text-xs whitespace-normal break-all text-muted',
          }"
        >
          <template #base-cell>
            <span class="font-sans text-dimmed">{{ t('inspect.widgetDefault') }}</span>
          </template>
          <template #value-cell="{ row }">
            <span translate="no">{{ row.original.value }}</span>
            <span class="sr-only">{{ ` ${t('inspect.changed')}` }}</span>
          </template>
        </UTable>
        <p
          v-else
          class="text-sm text-muted"
        >
          {{ t('inspect.noOverrides') }}
        </p>
      </section>

      <!-- What's wrong. -->
      <section
        class="grid gap-1 border-b border-default p-3"
        aria-labelledby="inspect-findings-heading"
        data-inspector-findings
      >
        <h3
          id="inspect-findings-heading"
          class="flex items-center gap-2 text-sm font-semibold text-highlighted"
        >
          {{ t('inspect.findings') }}
          <UBadge
            v-if="findings.length"
            color="warning"
            variant="soft"
          >
            {{ findings.length }}
          </UBadge>
        </h3>
        <ul
          v-if="findings.length"
          class="-mx-1.5 grid grid-cols-[minmax(0,1fr)]"
        >
          <li
            v-for="finding in findings"
            :key="finding.code + finding.path"
            class="min-w-0"
          >
            <UButton
              color="neutral"
              variant="ghost"
              block
              class="h-auto min-w-0 items-start justify-start px-1.5 py-1.5 text-start font-normal"
              :aria-label="t('inspect.openFinding', { code: finding.code })"
              @click="emit('openChecks')"
            >
              <span class="grid w-full grid-cols-[1rem_minmax(0,1fr)_1rem] gap-x-2 gap-y-0.5">
                <UIcon
                  name="i-lucide-triangle-alert"
                  class="mt-0.5 size-4 text-warning"
                />
                <span
                  class="truncate font-mono text-xs/5 text-default"
                  translate="no"
                >{{ finding.code }}</span>
                <UIcon
                  name="i-lucide-chevron-right"
                  class="mt-0.5 size-4 text-dimmed rtl:rotate-180"
                />
                <span class="col-start-2 text-sm text-muted">{{ finding.message }}</span>
              </span>
            </UButton>
          </li>
        </ul>
        <p
          v-else
          class="text-sm text-muted"
        >
          {{ t('inspect.noFindings') }}
        </p>
      </section>

      <!-- What's been said. -->
      <section
        class="grid gap-1 border-b border-default p-3"
        aria-labelledby="inspect-comments-heading"
        data-inspector-comments
      >
        <h3
          id="inspect-comments-heading"
          class="flex items-center gap-2 text-sm font-semibold text-highlighted"
        >
          {{ t('inspect.commentsHere') }}
          <UBadge
            v-if="threads.length"
            color="annotation"
            variant="soft"
          >
            {{ threads.length }}
          </UBadge>
        </h3>
        <ul
          v-if="threads.length"
          class="-mx-1.5 grid grid-cols-[minmax(0,1fr)]"
        >
          <li
            v-for="thread in visibleThreads"
            :key="thread.key"
            class="min-w-0"
          >
            <UButton
              color="neutral"
              variant="ghost"
              block
              class="h-auto min-w-0 justify-start gap-2 px-1.5 py-1.5 text-start font-normal"
              :aria-label="t('inspect.openThread', { excerpt: thread.excerpt || t('inspect.noMessage') })"
              @click="emit('openThread', thread.key)"
            >
              <UIcon
                :name="statusIcon(thread.status)"
                :class="['size-4 shrink-0', statusClass(thread.status)]"
              />
              <span class="sr-only">{{ statusLabel(thread.status) }}</span>
              <UAvatar
                v-if="thread.author"
                :text="actorInitials(thread.author)"
                :alt="thread.author"
                size="2xs"
              />
              <span class="min-w-0 flex-1 truncate text-sm text-default">{{ thread.excerpt || t('inspect.noMessage') }}</span>
              <time
                v-if="thread.at"
                :datetime="thread.at"
                class="shrink-0 text-xs text-dimmed"
              >{{ relativeTime(thread.at, locale) }}</time>
            </UButton>
          </li>
        </ul>
        <p
          v-else
          class="text-sm text-muted"
        >
          {{ t('inspect.noComments') }}
        </p>
        <UButton
          v-if="threads.length > THREAD_ROWS"
          color="neutral"
          variant="link"
          size="sm"
          class="justify-self-start px-0"
          :label="t('inspect.allInComments')"
          @click="emit('openThread', '')"
        />
      </section>

      <!-- Details: identities, revisions and raw state, one click away and never in the reading path. -->
      <UCollapsible
        v-model:open="detailsOpen"
        class="border-b border-default"
        :ui="{ content: 'px-3 pb-3' }"
      >
        <UButton
          color="neutral"
          variant="ghost"
          block
          class="justify-start rounded-none px-3 py-2 text-muted"
          :label="t('inspect.details')"
          :icon="detailsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          data-inspector-details-toggle
        />
        <template #content>
          <dl
            class="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5"
            data-inspector-details
          >
            <template
              v-for="item in details"
              :key="item.label"
            >
              <dt class="text-xs/5 text-muted">
                {{ item.label }}
              </dt>
              <dd class="flex min-w-0 items-center gap-1">
                <span
                  :class="['min-w-0 truncate text-xs', item.mono === false ? '' : 'font-mono text-default']"
                  :title="item.value"
                  translate="no"
                >{{ item.copy ? truncateMiddle(item.value, 20) : item.value }}</span>
                <UTooltip
                  v-if="item.copy"
                  :text="t('inspect.copyValue', { label: item.label })"
                >
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-copy"
                    :aria-label="t('inspect.copyValue', { label: item.label })"
                    @click="copy(item.value, t('inspect.copiedValue', { label: item.label }))"
                  />
                </UTooltip>
              </dd>
            </template>
          </dl>
          <h4 class="mt-3 mb-1 text-xs font-medium text-muted">
            {{ t('inspect.detail.raw') }}
          </h4>
          <UScrollArea
            class="max-h-56 rounded-md bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            tabindex="0"
            :aria-label="t('inspect.detail.raw')"
          >
            <pre
              class="p-2 font-mono text-xs text-default"
              translate="no"
            >{{ rawState }}</pre>
          </UScrollArea>
        </template>
      </UCollapsible>
    </template>
  </section>
</template>
