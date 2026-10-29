<script setup lang="ts">
/**
 * The Kit breadcrumb: a path of steps in a named `<nav>` landmark, one BreadcrumbItem per step in
 * the default slot. A long path scrolls sideways instead of wrapping, so the landmark itself is the
 * focusable scroller. `label` is the landmark's accessible name, such as "Path".
 */
defineProps<{
  label?: string
}>()
</script>

<template>
  <nav
    class="kit-breadcrumb"
    :aria-label="label || undefined"
    tabindex="0"
  >
    <ol class="kit-breadcrumb__list">
      <slot />
    </ol>
  </nav>
</template>

<style>
.kit-breadcrumb { min-width: 0; overflow-x: auto; border-radius: 4px; }
.kit-breadcrumb:focus-visible { outline: 2px solid var(--kit-primary); outline-offset: 2px; }
.kit-breadcrumb__list { display: flex; flex-wrap: nowrap; align-items: center; gap: 0; margin: 0; padding: 0; list-style: none; }
</style>
