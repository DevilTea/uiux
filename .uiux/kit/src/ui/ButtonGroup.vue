<script setup lang="ts">
/**
 * Joins the `Button`s of its default slot into one control: the inner corners square off and neighbors share one
 * border, as in a split button and its menu trigger. It is a `group` landmark, so give it `label` when the buttons
 * need a common name for assistive technology. It is layout only: each button keeps its own variant, size, state
 * and click, and the group has no state or events.
 */
defineProps<{
  /** The accessible name of the group (`aria-label`). Leave it out when the buttons name themselves. */
  label?: string
}>()
</script>

<template>
  <div
    class="kit-btn-group"
    role="group"
    :aria-label="label"
  >
    <slot />
  </div>
</template>

<style>
.kit-btn-group { display: inline-flex; align-items: stretch; max-width: 100%; }
.kit-btn-group > .kit-btn:not(:first-child) { margin-inline-start: -1px; border-start-start-radius: 0; border-end-start-radius: 0; }
.kit-btn-group > .kit-btn:not(:last-child) { border-start-end-radius: 0; border-end-end-radius: 0; }
.kit-btn-group > .kit-btn:hover:not(:disabled), .kit-btn-group > .kit-btn:focus-visible { position: relative; z-index: 1; }
</style>
