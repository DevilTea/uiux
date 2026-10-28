<script setup lang="ts">
/** A keyboard shortcut hint, such as `⌘K`. The text is the shortcut itself, never translated copy. */
defineProps<{
  /** The shortcut as shown. Alternatively fill the default slot. */
  keys?: string
}>()
</script>

<template>
  <kbd class="kit-kbd"><slot>{{ keys }}</slot></kbd>
</template>

<style>
.kit-kbd {
  display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 5px;
  box-sizing: border-box; font-family: var(--kit-font-mono); font-size: 12px; line-height: 16px; color: var(--kit-text-muted);
  background: var(--kit-bg-surface); border: 1px solid var(--kit-border); border-bottom-width: 2px; border-radius: 4px; white-space: nowrap;
}
</style>
