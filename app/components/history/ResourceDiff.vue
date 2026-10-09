<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import type { ResourceDiff } from '../../../src/domain/history/diff'
import { CHANGE_ICONS } from '../../composables/useHistoryLabels'
import { describeResourceDiff, formatDiffValue, pointerItems } from '../../utils/version-diff'
import HistoryImage from './HistoryImage.vue'

/**
 * The semantic diff of one resource (Rule 01a11a5e-11e0-7f39-84a7-fde3faa43340), rendered from the
 * server's B5 model for every kind: View, Flow, Locale, Workspace settings, Asset (with its images
 * before and after), the structural and digest-only fallbacks, and a kind this build cannot diff.
 * Values are Workspace content and identifiers, so they stay as written (`translate="no"`).
 */
const props = defineProps<{
	diff: ResourceDiff
	/** For an Asset image on the `current` side: the Asset's current content address. */
	currentImageUrl?: string
	/** The resource's display name, for image alternative text. */
	name: string
}>()
const { t } = useI18n()

const described = computed(() => describeResourceDiff(props.diff))
/** Prose wraps by word; JSON and digests are mono and may break anywhere. */
function valueClass(value: unknown): string {
	return typeof value === 'string' ? 'break-words' : 'font-mono break-all'
}
const hasContent = computed(() => described.value.sections.length > 0 || !!described.value.image)
</script>

<template>
  <div
    class="space-y-3"
    :data-diff-type="diff.type"
  >
    <p
      v-if="described.unsupported"
      class="flex items-start gap-1.5 text-sm text-muted"
      data-diff-unsupported
    >
      <UIcon
        name="i-lucide-info"
        class="mt-0.5 size-4 shrink-0"
      />{{ t('history.diff.unsupported') }}
    </p>
    <p
      v-else-if="!hasContent"
      class="text-sm text-muted"
    >
      {{ t('history.diff.empty') }}
    </p>

    <div
      v-if="described.image"
      class="grid grid-cols-1 gap-2 sm:grid-cols-2"
      data-diff-image
    >
      <figure class="space-y-1">
        <figcaption class="text-xs font-medium text-muted">
          {{ t('history.diff.before') }}
        </figcaption>
        <HistoryImage
          v-if="described.image.before"
          :digest="described.image.before.digest"
          :media-type="described.image.before.mediaType"
          :alt="t('history.diff.imageAlt', { name, side: t('history.diff.before') })"
        />
        <p
          v-else
          class="text-xs text-muted"
        >
          {{ t('history.diff.noImage') }}
        </p>
      </figure>
      <figure class="space-y-1">
        <figcaption class="text-xs font-medium text-muted">
          {{ t('history.diff.after') }}
        </figcaption>
        <HistoryImage
          v-if="described.image.after"
          :digest="described.image.after.digest"
          :media-type="described.image.after.mediaType"
          :fallback-url="currentImageUrl"
          :alt="t('history.diff.imageAlt', { name, side: t('history.diff.after') })"
        />
        <p
          v-else
          class="text-xs text-muted"
        >
          {{ t('history.diff.noImage') }}
        </p>
      </figure>
    </div>

    <section
      v-for="section in described.sections"
      :key="section.key"
      class="space-y-1"
      :data-diff-section="section.key"
    >
      <h5 class="text-xs font-medium text-muted">
        {{ t(`history.diff.section.${section.key}`) }}
      </h5>
      <ul class="space-y-1">
        <li
          v-for="(item, index) in section.items"
          :key="index"
          class="rounded-md border border-default px-2 py-1.5 text-xs"
          data-diff-item
          :data-op="item.op"
        >
          <p class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <UIcon
              :name="CHANGE_ICONS[item.op]!"
              class="size-3.5 shrink-0 text-muted"
            />
            <span class="shrink-0 font-medium text-default">{{ t(`history.diff.op.${item.op}`) }}</span>
            <span
              v-if="item.field"
              class="shrink-0 text-muted"
            >{{ t(`history.diff.field.${item.field}`) }}</span>
            <code
              v-if="item.label"
              class="min-w-0 font-mono break-all text-highlighted"
              translate="no"
            >{{ item.label }}</code>
          </p>
          <p
            v-if="item.before !== undefined || item.after !== undefined"
            class="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5"
            translate="no"
          >
            <del
              v-if="item.before !== undefined"
              class="min-w-0 text-muted"
              :class="valueClass(item.before)"
            >{{ formatDiffValue(item.before) }}</del>
            <UIcon
              v-if="item.before !== undefined && item.after !== undefined"
              name="i-lucide-arrow-right"
              class="size-3 shrink-0 self-center text-muted"
            />
            <ins
              v-if="item.after !== undefined"
              class="min-w-0 text-highlighted no-underline"
              :class="valueClass(item.after)"
            >{{ formatDiffValue(item.after) }}</ins>
          </p>
          <ul
            v-if="item.changes?.length"
            class="mt-1 space-y-0.5 border-s border-default ps-2"
          >
            <li
              v-for="(change, changeIndex) in pointerItems(item.changes)"
              :key="changeIndex"
              class="flex min-w-0 flex-wrap items-baseline gap-x-1.5"
            >
              <UIcon
                :name="CHANGE_ICONS[change.op]!"
                class="size-3 shrink-0 self-center text-muted"
              />
              <span class="sr-only">{{ t(`history.diff.op.${change.op}`) }}</span>
              <code
                class="font-mono text-muted"
                translate="no"
              >{{ change.label }}</code>
              <del
                v-if="change.before !== undefined"
                class="min-w-0 text-muted"
                :class="valueClass(change.before)"
                translate="no"
              >{{ formatDiffValue(change.before) }}</del>
              <UIcon
                v-if="change.before !== undefined && change.after !== undefined"
                name="i-lucide-arrow-right"
                class="size-3 shrink-0 self-center text-muted"
              />
              <ins
                v-if="change.after !== undefined"
                class="min-w-0 text-highlighted no-underline"
                :class="valueClass(change.after)"
                translate="no"
              >{{ formatDiffValue(change.after) }}</ins>
            </li>
          </ul>
        </li>
      </ul>
    </section>
  </div>
</template>
