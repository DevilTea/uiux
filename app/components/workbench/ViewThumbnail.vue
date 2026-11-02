<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import KitBadge from '~/components/kit/ui/Badge.vue'
import KitIcon from '~/components/kit/ui/Icon.vue'

/**
 * A View's thumbnail on the Views tab (Feature 01a19b99-ca97-7aa7-b326-345c8a26caf3): its image, a
 * placeholder while it has none (Rule 01a19b99-dd5f-79bb-bfb6-d1446d6b6526), a stale indicator
 * (Rule 01a19b99-ddf6-7460-88e7-55ad4aa5fbba) and a refreshing indicator (Rule 01a19b99-de8d-7072-8399-915de730767c).
 * The image is decorative to assistive technology; the card or row that holds it is named by the
 * View (Rule 01a19b99-e07a-7e6c-a5ac-04e44e3ee035). A thumbnail that could not be captured is the
 * placeholder, or its previous image with the stale indicator, and never an error marker
 * (Rule 01a19bac-eaeb-777f-b498-2e1c75ec706b). The box keeps its size whatever it shows, so a new
 * image replaces the old one without moving anything.
 */
const props = defineProps<{
  /** The View's name, for the placeholder's initial. */
  name: string
  /** The image to show, or none while the View has no thumbnail. */
  url?: string
  stale: boolean
  refreshing: boolean
  /** `card` fills the width of a grid card; `row` is the small one before a View's name. */
  size: 'card' | 'row'
}>()

const { t } = useI18n()
const initial = computed(() => [...props.name.trim()][0]?.toUpperCase() ?? '·')
</script>

<template>
  <span
    class="relative flex shrink-0 overflow-hidden border border-default bg-elevated"
    :class="size === 'card' ? 'aspect-8/5 w-full rounded-t-lg border-0 border-b' : 'aspect-8/5 w-16 rounded-md'"
    data-view-thumbnail
    :data-thumbnail-size="size"
    :data-thumbnail-stale="stale || undefined"
    :data-thumbnail-refreshing="refreshing || undefined"
  >
    <img
      v-if="url"
      :src="url"
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      draggable="false"
      class="size-full object-cover object-top"
      data-thumbnail-image
    >
    <span
      v-else
      class="flex size-full items-center justify-center font-semibold text-muted"
      :class="size === 'card' ? 'text-display' : 'text-sm'"
      aria-hidden="true"
      data-thumbnail-placeholder
    >{{ initial }}</span>
    <span
      v-if="stale || refreshing"
      class="absolute inset-s-1 top-1 flex max-w-[calc(100%-0.5rem)] flex-wrap gap-1"
    >
      <template v-if="size === 'card'">
        <KitBadge
          v-if="stale"
          tone="warning"
          icon="history"
          :label="t('overview.thumbnail.stale')"
          data-thumbnail-stale-indicator
        />
        <KitBadge
          v-if="refreshing"
          tone="neutral"
          icon="loader-circle"
          spin
          :label="t('overview.thumbnail.refreshing')"
          data-thumbnail-refreshing-indicator
        />
      </template>
      <template v-else>
        <!-- A row's thumbnail is too small for text: an icon with its name. -->
        <span
          v-if="stale"
          class="inline-flex size-4 items-center justify-center rounded-full bg-default text-warning"
          :title="t('overview.thumbnail.stale')"
          data-thumbnail-stale-indicator
        >
          <KitIcon
            name="history"
            :size="12"
          />
          <span class="sr-only">{{ t('overview.thumbnail.stale') }}</span>
        </span>
        <span
          v-if="refreshing"
          class="inline-flex size-4 items-center justify-center rounded-full bg-default text-muted"
          :title="t('overview.thumbnail.refreshing')"
          data-thumbnail-refreshing-indicator
        >
          <KitIcon
            name="loader-circle"
            :size="12"
            class="animate-spin motion-reduce:animate-none"
          />
          <span class="sr-only">{{ t('overview.thumbnail.refreshing') }}</span>
        </span>
      </template>
    </span>
  </span>
</template>
