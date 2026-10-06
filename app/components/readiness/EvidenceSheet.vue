<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '#imports'
import type { EvidenceEntry } from '../../composables/useReadiness'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { copyText } from '../../utils/copy-text'
import type { CaptureContext, EvidenceFreshness } from '../../utils/readiness'

/**
 * The Evidence contact sheet (brief f, blueprint register): one tile per formal capture,
 * labelled with its mono render context and freshness, and a viewer with the capture at full
 * size. Digests and revisions stay one click away under Details.
 */
const props = defineProps<{
	entries: readonly EvidenceEntry[]
	viewName: string
	canCapture: boolean
}>()
const emit = defineEmits<{
	(e: 'captureAgain', contexts: readonly CaptureContext[]): void
	(e: 'apply', context: CaptureContext): void
}>()

const { t } = useI18n()
const uiux = useUiuxClient()
const feedback = useWorkbenchFeedback()

const openDigest = ref<string>()
const actualSize = ref(false)
const viewerOpen = computed({
	get: () => openDigest.value !== undefined,
	set: (value: boolean) => { if (!value) openDigest.value = undefined },
})
const current = computed(() => props.entries.find(entry => entry.digest === openDigest.value))

const sorted = computed(() => [...props.entries].sort((a, b) => sortKey(a).localeCompare(sortKey(b))))
function sortKey(entry: EvidenceEntry): string {
	const context = entry.context
	return context ? [context.variantName ?? '', context.viewportId, context.locale, context.themeId].join('\u0000') : `~${entry.digest}`
}

function screenshot(entry: EvidenceEntry): string | undefined {
	const artifact = entry.record.artifactRefs[0]
	return artifact ? uiux.artifactUrl(artifact) : undefined
}

function lines(entry: EvidenceEntry): string[] {
	const context = entry.context
	if (!context) return [t('evidence.context.unknown')]
	return [
		context.variantName ?? t('ctx.base'),
		context.viewportId,
		`${context.viewport.width} × ${context.viewport.height}`,
		`${context.locale} · ${context.themeId}`,
	]
}

function altText(entry: EvidenceEntry): string {
	const context = entry.context
	if (!context) return t('evidence.thumbAltUnknown', { view: props.viewName })
	return t('evidence.thumbAlt', {
		view: props.viewName,
		context: [context.variantName ?? t('ctx.base'), `${context.viewportId} ${context.viewport.width} × ${context.viewport.height}`, context.locale, context.themeId].join(', '),
	})
}

const BADGE: Record<EvidenceFreshness['state'], { color: 'success' | 'warning' | 'neutral'; icon: string }> = {
	fresh: { color: 'success', icon: 'i-lucide-circle-check' },
	stale: { color: 'warning', icon: 'i-lucide-history' },
	unknown: { color: 'neutral', icon: 'i-lucide-circle-help' },
}

function reasonText(freshness: EvidenceFreshness): string {
	if (!freshness.reason) return ''
	return t(`evidence.reason.${freshness.reason}`, { subject: freshness.subject ?? '' })
}

async function copy(value: string): Promise<void> {
	if (await copyText(value)) feedback.success(t('evidence.copied'))
	else feedback.error(undefined, t('evidence.copyFailed'))
}

function middle(value: string): string {
	const bare = value.replace(/^sha256:/, '')
	return bare.length > 20 ? `${bare.slice(0, 10)}…${bare.slice(-6)}` : bare
}

function open(entry: EvidenceEntry): void {
	actualSize.value = false
	openDigest.value = entry.digest
}
</script>

<template>
  <div>
    <ul
      class="grid grid-cols-2 gap-2"
      :aria-label="t('evidence.sheetLabel')"
      data-evidence-sheet
    >
      <li
        v-for="entry in sorted"
        :key="entry.digest"
        :data-evidence-tile="entry.freshness.state"
      >
        <button
          type="button"
          class="group flex w-full flex-col overflow-hidden rounded-lg border border-default bg-default text-start hover:border-accented focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          :aria-label="`${altText(entry)}. ${t(`evidence.state.${entry.freshness.state}`)}`"
          @click="open(entry)"
        >
          <span class="block aspect-[16/10] w-full overflow-hidden border-b border-default bg-elevated">
            <img
              v-if="screenshot(entry)"
              :src="screenshot(entry)"
              alt=""
              loading="lazy"
              class="size-full object-cover object-top"
            >
          </span>
          <span class="flex flex-col gap-1 p-2">
            <span
              v-for="(line, index) in lines(entry)"
              :key="index"
              class="truncate text-xs leading-4"
              :class="index === 0 ? 'font-medium text-highlighted' : 'font-mono text-muted'"
            >{{ line }}</span>
            <UBadge
              :color="BADGE[entry.freshness.state].color"
              :icon="BADGE[entry.freshness.state].icon"
              variant="subtle"
              size="sm"
              class="mt-0.5 self-start"
            >
              {{ t(`evidence.state.${entry.freshness.state}`) }}
            </UBadge>
          </span>
        </button>
      </li>
    </ul>

    <UModal
      v-model:open="viewerOpen"
      :title="current ? `${viewName} · ${lines(current).join(' · ')}` : t('evidence.viewerTitle')"
      :ui="{ content: 'sm:max-w-5xl', body: 'space-y-4', title: 'truncate' }"
    >
      <template #body>
        <template v-if="current">
          <UAlert
            v-if="current.freshness.state !== 'fresh'"
            :color="current.freshness.state === 'stale' ? 'warning' : 'neutral'"
            variant="subtle"
            :icon="BADGE[current.freshness.state].icon"
            :title="t(`evidence.stateTitle.${current.freshness.state}`)"
            :description="reasonText(current.freshness)"
          />
          <div
            class="overflow-auto rounded-md border border-default bg-elevated"
            :class="actualSize ? 'max-h-[70vh]' : ''"
          >
            <img
              v-if="screenshot(current)"
              :src="screenshot(current)"
              :alt="altText(current)"
              class="mx-auto"
              :class="actualSize ? 'max-w-none' : 'max-h-[60vh] max-w-full object-contain'"
            >
          </div>
          <UCollapsible :ui="{ content: 'pt-2' }">
            <UButton
              variant="ghost"
              size="sm"
              trailing-icon="i-lucide-chevron-down"
              class="-ms-2"
            >
              {{ t('evidence.details') }}
            </UButton>
            <template #content>
              <dl class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm">
                <dt class="text-muted">
                  {{ t('evidence.digest') }}
                </dt>
                <dd class="truncate font-mono text-xs text-highlighted">
                  {{ middle(current.digest) }}
                </dd>
                <dd>
                  <UButton
                    size="xs"
                    variant="ghost"
                    icon="i-lucide-copy"
                    :aria-label="t('evidence.copyDigest')"
                    @click="copy(current.digest)"
                  />
                </dd>
                <template
                  v-for="resource in current.record.provenance.resources"
                  :key="`${String(resource.identity.type)}:${String(resource.identity.id)}`"
                >
                  <dt class="text-muted">
                    {{ t('evidence.revisionOf', { kind: String(resource.identity.type ?? '') }) }}
                  </dt>
                  <dd
                    class="col-span-2 truncate font-mono text-xs text-default"
                    :title="resource.revision"
                  >
                    {{ middle(resource.revision) }}
                  </dd>
                </template>
                <dt class="text-muted">
                  {{ t('evidence.uiuxVersion') }}
                </dt>
                <dd class="col-span-2 font-mono text-xs text-default">
                  {{ current.record.provenance.versions?.uiux ?? '—' }}
                </dd>
              </dl>
            </template>
          </UCollapsible>
        </template>
      </template>
      <template #footer>
        <div
          v-if="current"
          class="flex w-full flex-wrap items-center justify-end gap-2"
        >
          <UButton
            variant="ghost"
            :icon="actualSize ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
            class="me-auto"
            :aria-pressed="actualSize"
            @click="actualSize = !actualSize"
          >
            {{ actualSize ? t('evidence.fit') : t('evidence.actualSize') }}
          </UButton>
          <UButton
            v-if="current.context"
            icon="i-lucide-crosshair"
            @click="emit('apply', current.context!); viewerOpen = false"
          >
            {{ t('evidence.applyContext') }}
          </UButton>
          <UButton
            v-if="canCapture && current.context && current.freshness.state !== 'fresh'"
            color="primary"
            variant="solid"
            icon="i-lucide-camera"
            @click="emit('captureAgain', [current.context!]); viewerOpen = false"
          >
            {{ t('evidence.captureAgain') }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
