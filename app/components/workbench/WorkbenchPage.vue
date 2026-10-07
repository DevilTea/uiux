<script setup lang="ts">
/**
 * A full-width Workbench page (Overview aside): one dashboard panel whose `main` landmark
 * scrolls inside the panel, never the document. An optional `toolbar` slot sits above it, for
 * an area's own sub-navigation (the Workspace pages).
 */
defineProps<{ id: string; title?: string }>()
</script>

<template>
  <UDashboardPanel
    :id="id"
    :ui="{ root: 'min-h-0 min-w-0', body: 'gap-0 p-0 sm:p-0 overflow-hidden' }"
  >
    <template
      v-if="$slots.toolbar"
      #header
    >
      <slot name="toolbar" />
    </template>
    <template #body>
      <main
        id="main"
        data-landmark="main"
        tabindex="-1"
        class="flex min-h-0 flex-1 flex-col overflow-hidden"
        :aria-label="title"
      >
        <slot />
      </main>
    </template>
  </UDashboardPanel>
</template>
