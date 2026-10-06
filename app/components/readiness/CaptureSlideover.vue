<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { useReadiness } from '../../composables/useReadiness'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import type { FetchErrorDetails } from '../../utils/fetch-error'
import { contextKey, expandContexts, type CaptureContext, type CaptureDimension } from '../../utils/readiness'
import { diagnosticLines } from '../../utils/diagnostic-copy'

/**
 * Capture Evidence for the current View (brief f, section 5): an explicit list of resolved
 * render contexts. The "All …" buttons expand the visible list first; Capture runs exactly the
 * checked rows, one context at a time, so each result (or fault) lands on its own row and one
 * failure never hides the others (Part 10: no automatic Cartesian expansion).
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ initialContexts: readonly CaptureContext[] }>()
const emit = defineEmits<{ (e: 'captured'): void }>()

const { t } = useI18n()
const workbench = useWorkbench()
const { selectedView, contextOptions, currentActiveContext } = workbench
const readiness = useReadiness()
const uiux = useUiuxClient()
const feedback = useWorkbenchFeedback()

type RowStatus = 'idle' | 'queued' | 'running' | 'captured' | 'failed'
type Row = { key: string; context: CaptureContext; checked: boolean; status: RowStatus; digest?: string; error?: FetchErrorDetails; added?: boolean }

const rows = ref<Row[]>([])
const running = ref(false)
let stopRequested = false
function requestStop(): void { stopRequested = true }
const announcement = ref('')
let lastAnnounced = 0
let announceTimer: ReturnType<typeof setTimeout> | undefined

const options = computed(() => {
	const state = contextOptions.value
	return {
		variants: ['', ...state.variants.available],
		locales: state.locales.available.length ? [...state.locales.available] : [state.locales.defaultLocale],
		viewports: state.viewports.available.map(viewport => ({ id: viewport.id, width: viewport.width, height: viewport.height })),
		themes: state.themes.available.length ? [...state.themes.available] : [state.themes.selected],
	}
})

// The "Add context" row, defaulting to what the canvas shows now.
const draft = ref({ variant: '', locale: '', viewport: '', theme: '' })
function resetDraft(): void {
	const active = currentActiveContext.value
	draft.value = {
		variant: active?.variantName ?? '',
		locale: active?.locale ?? options.value.locales[0] ?? '',
		viewport: active?.viewportId ?? options.value.viewports[0]?.id ?? '',
		theme: active?.themeId ?? options.value.themes[0] ?? '',
	}
}

const BASE = '__base__'
const variantItems = computed(() => options.value.variants.map(name => ({ label: name || t('ctx.base'), value: name || BASE })))
const localeItems = computed(() => options.value.locales.map(locale => ({ label: locale, value: locale })))
const viewportItems = computed(() => options.value.viewports.map(viewport => ({ label: `${viewport.id} · ${viewport.width} × ${viewport.height}`, value: viewport.id })))
const themeItems = computed(() => options.value.themes.map(theme => ({ label: theme, value: theme })))
const draftVariant = computed({
	get: () => draft.value.variant || BASE,
	set: (value: string) => { draft.value.variant = value === BASE ? '' : value },
})

function toRow(context: CaptureContext, added = false): Row {
	return { key: contextKey(context), context, checked: true, status: 'idle', ...(added ? { added } : {}) }
}

function addContexts(contexts: readonly CaptureContext[], added = true): void {
	const known = new Set(rows.value.map(row => row.key))
	for (const context of contexts) {
		const row = toRow(context, added)
		if (known.has(row.key)) continue
		known.add(row.key)
		rows.value.push(row)
	}
}

function addDraft(): void {
	const view = selectedView.value
	const viewport = options.value.viewports.find(item => item.id === draft.value.viewport)
	if (!view || !viewport) return
	addContexts([{
		viewId: view.key,
		...(draft.value.variant ? { variantName: draft.value.variant } : {}),
		locale: draft.value.locale,
		viewportId: viewport.id,
		viewport: { width: viewport.width, height: viewport.height },
		themeId: draft.value.theme,
	}])
}

/** Convenience expansion: the list grows visibly; nothing runs until Capture. */
function expand(dimension: CaptureDimension): void {
	const base = rows.value.filter(row => row.checked).map(row => row.context)
	addContexts(expandContexts(base.length ? base : rows.value.map(row => row.context), dimension, options.value))
}

function remove(key: string): void {
	rows.value = rows.value.filter(row => row.key !== key)
}

const checkedRows = computed(() => rows.value.filter(row => row.checked && row.status !== 'captured'))
const done = computed(() => rows.value.filter(row => row.status === 'captured' || row.status === 'failed').length)
const total = computed(() => rows.value.filter(row => row.status !== 'idle').length)

function contextLabel(context: CaptureContext): string {
	return [context.variantName || t('ctx.base'), `${context.viewportId} ${context.viewport.width} × ${context.viewport.height}`, context.locale, context.themeId].join(' · ')
}

function announce(text: string, force = false): void {
	const now = Date.now()
	if (announceTimer) clearTimeout(announceTimer)
	if (force || now - lastAnnounced >= 1000) {
		announcement.value = text
		lastAnnounced = now
		return
	}
	announceTimer = setTimeout(() => { announcement.value = text; lastAnnounced = Date.now() }, 1000 - (now - lastAnnounced))
}

async function capture(): Promise<void> {
	if (running.value) return
	const queue = checkedRows.value
	if (!queue.length) return
	running.value = true
	stopRequested = false
	for (const row of queue) {
		row.status = 'queued'
		delete row.error
	}
	let captured = 0
	let failed = 0
	for (const row of queue) {
		if (stopRequested) { row.status = 'idle'; continue }
		row.status = 'running'
		const outcome = await readiness.captureContext(row.context)
		if (outcome.status === 'captured') {
			row.status = 'captured'
			if (outcome.evidenceDigest) row.digest = outcome.evidenceDigest
			captured += 1
		}
		else {
			row.status = 'failed'
			if (outcome.error) row.error = outcome.error
			failed += 1
		}
		announce(t('evidence.progress', { done: captured + failed, total: queue.length }))
	}
	running.value = false
	await readiness.loadEvidence(true)
	announce(failed ? t('evidence.result.partial', { captured, failed }) : t('evidence.result.done', captured), true)
	if (captured) {
		emit('captured')
		if (!failed) feedback.success(t('evidence.result.done', captured))
	}
}

function thumbnail(row: Row): string | undefined {
	if (!row.digest) return undefined
	const entry = readiness.evidenceEntries.value.find(item => item.digest === row.digest)
	const artifact = entry?.record.artifactRefs[0]
	return artifact ? uiux.artifactUrl(artifact) : undefined
}

watch(open, (isOpen) => {
	if (!isOpen) {
		stopRequested = true
		return
	}
	rows.value = props.initialContexts.map(context => toRow(context))
	resetDraft()
	announcement.value = ''
}, { immediate: true })

onBeforeUnmount(() => {
	stopRequested = true
	if (announceTimer) clearTimeout(announceTimer)
})

const statusIcon: Record<RowStatus, string> = {
	idle: 'i-lucide-circle-dashed',
	queued: 'i-lucide-clock',
	running: 'i-lucide-loader-circle',
	captured: 'i-lucide-circle-check',
	failed: 'i-lucide-circle-x',
}
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    :title="t('evidence.captureTitle', { view: selectedView?.resource.name || t('common.unnamed') })"
    :description="t('evidence.captureDescription')"
    :dismissible="!running"
    :ui="{ content: 'max-w-xl', body: 'flex min-h-0 flex-col gap-4 p-4 sm:p-4' }"
  >
    <template #body>
      <section
        class="space-y-2"
        :aria-label="t('evidence.addContext')"
      >
        <h3 class="text-xs font-medium text-muted">
          {{ t('evidence.addContext') }}
        </h3>
        <div class="grid grid-cols-2 gap-2">
          <USelect
            v-model="draftVariant"
            :items="variantItems"
            :aria-label="t('ctx.variant')"
            icon="i-lucide-layers"
          />
          <USelect
            v-model="draft.locale"
            :items="localeItems"
            :aria-label="t('ctx.locale')"
            icon="i-lucide-languages"
          />
          <USelect
            v-model="draft.viewport"
            :items="viewportItems"
            :aria-label="t('ctx.viewport')"
            icon="i-lucide-monitor-smartphone"
          />
          <USelect
            v-model="draft.theme"
            :items="themeItems"
            :aria-label="t('ctx.theme')"
            icon="i-lucide-sun-moon"
          />
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <UButton
            size="sm"
            icon="i-lucide-plus"
            :disabled="running"
            data-capture-add
            @click="addDraft"
          >
            {{ t('evidence.addToList') }}
          </UButton>
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <span class="me-1 text-xs text-muted">{{ t('evidence.expandLabel') }}</span>
          <UButton
            v-for="dimension in (['variants', 'locales', 'viewports', 'themes'] as const)"
            :key="dimension"
            size="sm"
            variant="ghost"
            :disabled="running || !rows.length"
            :data-capture-expand="dimension"
            @click="expand(dimension)"
          >
            {{ t(`evidence.expand.${dimension}`) }}
          </UButton>
        </div>
      </section>

      <section
        class="flex min-h-0 flex-1 flex-col"
        :aria-label="t('evidence.listTitle')"
      >
        <div class="flex items-center justify-between pb-1.5">
          <h3 class="text-xs font-medium text-muted">
            {{ t('evidence.listTitle') }}
          </h3>
          <span class="text-xs text-muted tabular-nums">{{ t('evidence.selectedCount', checkedRows.length) }}</span>
        </div>
        <p
          v-if="!rows.length"
          class="rounded-md border border-dashed border-default px-3 py-6 text-center text-sm text-muted"
        >
          {{ t('evidence.listEmpty') }}
        </p>
        <ul
          v-else
          class="min-h-0 divide-y divide-(--ui-border) overflow-y-auto rounded-md border border-default"
          data-capture-list
        >
          <li
            v-for="row in rows"
            :key="row.key"
            class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 px-2 py-1.5"
            :class="row.added && row.status === 'idle' ? 'bg-muted' : ''"
            :data-capture-row="row.status"
          >
            <UCheckbox
              v-model="row.checked"
              :disabled="running || row.status === 'captured'"
              :aria-label="t('evidence.includeRow', { context: contextLabel(row.context) })"
              class="mt-0.5"
            />
            <div class="min-w-0">
              <p class="truncate font-mono text-xs leading-5 text-highlighted">
                {{ contextLabel(row.context) }}
              </p>
              <p
                v-if="row.status === 'failed'"
                class="text-xs text-error"
                data-capture-error
              >
                {{ row.error?.message ?? t('evidence.result.failed') }}
                <span
                  v-for="line in diagnosticLines(row.error?.message ?? '', row.error?.diagnostics ?? [])"
                  :key="line"
                  class="block text-muted"
                >{{ line }}</span>
              </p>
            </div>
            <div class="flex items-center gap-1.5">
              <img
                v-if="row.status === 'captured' && thumbnail(row)"
                :src="thumbnail(row)"
                :alt="t('evidence.thumbAlt', { view: selectedView?.resource.name ?? '', context: contextLabel(row.context) })"
                class="h-8 w-12 rounded-sm border border-default object-cover object-top"
              >
              <UIcon
                v-if="row.status !== 'idle'"
                :name="statusIcon[row.status]"
                class="size-4"
                :class="{
                  'text-dimmed': row.status === 'queued',
                  'animate-spin text-muted': row.status === 'running',
                  'text-success': row.status === 'captured',
                  'text-error': row.status === 'failed',
                }"
              />
              <span class="sr-only">{{ t(`evidence.rowStatus.${row.status}`) }}</span>
              <UButton
                v-if="row.status === 'idle' || row.status === 'failed'"
                size="xs"
                variant="ghost"
                icon="i-lucide-x"
                :disabled="running"
                :aria-label="t('evidence.removeRow', { context: contextLabel(row.context) })"
                @click="remove(row.key)"
              />
            </div>
          </li>
        </ul>
      </section>

      <p
        class="sr-only"
        aria-live="polite"
        role="status"
      >
        {{ announcement }}
      </p>
    </template>

    <template #footer>
      <div class="w-full space-y-2">
        <UProgress
          v-if="total"
          :model-value="done"
          :max="total"
          size="sm"
          :aria-label="t('evidence.progress', { done, total })"
        />
        <div class="flex items-center justify-end gap-2">
          <span
            v-if="total"
            class="me-auto text-xs text-muted tabular-nums"
          >{{ t('evidence.progress', { done, total }) }}</span>
          <UButton
            v-if="running"
            @click="requestStop"
          >
            {{ t('evidence.stop') }}
          </UButton>
          <UButton
            v-else
            @click="open = false"
          >
            {{ done ? t('common.close') : t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            variant="solid"
            icon="i-lucide-camera"
            :loading="running"
            :disabled="!checkedRows.length"
            data-capture-run
            @click="capture"
          >
            {{ t('evidence.captureN', checkedRows.length) }}
          </UButton>
        </div>
      </div>
    </template>
  </USlideover>
</template>
