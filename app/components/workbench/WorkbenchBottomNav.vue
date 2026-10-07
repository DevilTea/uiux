<script setup lang="ts">
import { computed } from 'vue'
import { useI18n, useRoute } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'

/**
 * The phone's primary navigation (DESIGN.md "Mobile"; brief a, section 6): a 56px bar of three
 * areas, icon over a 12px label, above the home indicator. Reviews carries the waiting count
 * because triage is the phone's job; the Workspace entry lives in the ☰ menu. Overview holds the
 * one list of every View, so a View page marks it.
 */
const { t } = useI18n()
const route = useRoute()
const { unresolvedReviewCount, isReadOnly } = useWorkbench()

const items = computed(() => [
	{ to: '/', label: t('nav.overview'), icon: 'i-lucide-layout-dashboard', active: route.path === '/' || route.path.startsWith('/views') },
	{ to: '/flows', label: t('nav.flows'), icon: 'i-lucide-workflow', active: route.path.startsWith('/flows') },
	{ to: '/reviews', label: t('nav.reviews'), icon: 'i-lucide-inbox', active: route.path.startsWith('/reviews'), count: isReadOnly.value ? 0 : unresolvedReviewCount.value },
])
</script>

<template>
  <nav
    class="shrink-0 border-t border-default bg-default pb-[env(safe-area-inset-bottom)] md:hidden"
    :aria-label="t('shell.primaryNav')"
    data-bottom-nav
  >
    <ul class="grid h-14 grid-cols-3">
      <li
        v-for="item in items"
        :key="item.to"
        class="min-w-0"
      >
        <NuxtLink
          :to="item.to"
          class="relative flex h-full min-w-0 flex-col items-center justify-center gap-0.5 px-1 text-xs outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
          :class="item.active ? 'font-medium text-highlighted' : 'text-muted'"
          :aria-current="item.active ? 'page' : undefined"
          :aria-label="item.count ? t('nav.reviewsLabel', item.count) : undefined"
          :data-bottom-nav-item="item.to"
        >
          <span
            v-if="item.active"
            class="absolute inset-x-5 top-0 h-0.5 rounded-full bg-primary"
            aria-hidden="true"
          />
          <span class="relative">
            <UIcon
              :name="item.icon"
              class="size-5"
              :class="item.active ? 'text-primary' : ''"
            />
            <span
              v-if="item.count"
              class="absolute -end-2.5 -top-1.5 min-w-4 rounded-full bg-annotation px-1 text-center text-xs/4 font-medium text-inverted tabular-nums"
              aria-hidden="true"
            >{{ item.count > 99 ? '99+' : item.count }}</span>
          </span>
          <span class="max-w-full truncate">{{ item.label }}</span>
        </NuxtLink>
      </li>
    </ul>
  </nav>
</template>
