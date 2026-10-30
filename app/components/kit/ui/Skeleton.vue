<script setup lang="ts">
/**
 * The Kit skeleton: a pulsing placeholder block for content that is still loading. It is decorative
 * unless it has a `label`, which names the loading region for assistive technology (`role="status"`,
 * `aria-busy`); without a label it is hidden from it. The pulse stops under `prefers-reduced-motion`.
 */
defineProps<{
  /** Width: a number is px, a string any CSS length. Default 100%. */
  width?: number | string
  /** Height: a number is px, a string any CSS length. Default 16px. */
  height?: number | string
  /** Corner radius: a number is px, a string any CSS length. Default 4px. */
  radius?: number | string
  /** The accessible name of the loading region, such as "Loading". */
  label?: string
}>()

const length = (value: number | string | undefined): string | undefined => typeof value === 'number' ? `${value}px` : value
</script>

<template>
  <span
    class="kit-skeleton"
    :role="label ? 'status' : undefined"
    :aria-busy="label ? 'true' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    :style="{ width: length(width), height: length(height), borderRadius: length(radius) }"
  />
</template>

<style>
.kit-skeleton { display: block; width: 100%; height: 16px; border-radius: 4px; background-color: var(--kit-bg-surface-elevated); animation: kit-skeleton-pulse 1.6s ease-in-out infinite; }
@keyframes kit-skeleton-pulse { 50% { opacity: 0.5; } }
@media (prefers-reduced-motion: reduce) { .kit-skeleton { animation: none; } }
</style>
