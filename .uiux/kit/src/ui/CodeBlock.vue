<script setup lang="ts">
/**
 * The Kit code block: literal text in the mono face, such as JSON, a diff or a log. `code` is shown
 * exactly as given (never translated). A long line scrolls sideways, or wraps with `wrap`; `maxHeight`
 * bounds the block, which then scrolls vertically. A scrolling block is focusable so the keyboard can
 * scroll it, and with a `label` it is a named region.
 */
defineProps<{
  code?: string
  /** A number is px, a string any CSS length. The block scrolls beyond it. */
  maxHeight?: number | string
  /** Wrap long lines instead of scrolling sideways. */
  wrap?: boolean
  /** The accessible name of the region, such as "Request body". */
  label?: string
}>()

const length = (value: number | string | undefined): string | undefined => typeof value === 'number' ? `${value}px` : value
</script>

<template>
  <pre
    class="kit-code-block"
    :class="{ 'is-wrap': wrap }"
    :role="label ? 'region' : undefined"
    :aria-label="label || undefined"
    tabindex="0"
    translate="no"
    :style="{ maxHeight: length(maxHeight) }"
  ><code>{{ code }}</code></pre>
</template>

<style>
.kit-code-block {
  margin: 0; padding: 8px 10px; box-sizing: border-box; width: 100%; min-width: 0; overflow: auto;
  font-family: var(--kit-font-mono); font-size: 12px; line-height: 18px; color: var(--kit-text);
  background-color: var(--kit-bg-muted); border: 1px solid var(--kit-border); border-radius: 6px; white-space: pre;
}
.kit-code-block.is-wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.kit-code-block:focus-visible { outline: 2px solid var(--kit-primary); outline-offset: 2px; }
.kit-code-block code { font: inherit; }
</style>
