<script setup lang="ts">
import { computed } from 'vue'
import { ICONS } from './icons'

/**
 * A Lucide icon by name, from the curated subset in icons.ts. An unknown name renders as literal
 * text, which keeps older authored glyphs working. The icon is decorative (`aria-hidden`): the
 * control that holds it carries the accessible name.
 */
const props = withDefaults(defineProps<{
  /** Lucide icon name without a prefix, such as `check`. */
  name: string
  /** Width and height in px. */
  size?: number
}>(), { size: 16 })

const body = computed(() => ICONS[props.name])
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- `body` is a static, trusted table (icons.ts), never user input. -->
  <svg
    v-if="body"
    class="kit-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    v-html="body"
  />
  <!-- eslint-enable vue/no-v-html -->
  <span
    v-else
    class="kit-glyph"
    aria-hidden="true"
  >{{ name }}</span>
</template>

<style>
.kit-icon { flex-shrink: 0; display: inline-block; vertical-align: middle; }
.kit-glyph { flex-shrink: 0; }
</style>
