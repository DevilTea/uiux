<script setup lang="ts">
import Icon from './Icon.vue'

/**
 * One step of a Kit breadcrumb: the step `index` (mono), a `variant` (the state the step shows,
 * emphasized), a `label` (what it belongs to, muted) and a `trailing` note. It is a list item of the
 * breadcrumb's `<ol>`, and `current` marks the step the path ends on (`aria-current="step"`). A
 * chevron separates it from the step before it. The step is not a link: it only shows where the path has been.
 */
defineProps<{
  /** The step's number, such as 3. */
  index?: number | string
  /** The step's subject, such as a View name. */
  label?: string
  /** The state of the subject at this step, such as a Variant name. */
  variant?: string
  /** The path ends on this step. */
  current?: boolean
  /** A note after the step, such as how it was reached. */
  trailing?: string
  /** Leading Lucide icon name (icons.ts). */
  icon?: string
}>()
</script>

<template>
  <li
    class="kit-breadcrumb-item"
    :class="{ 'is-current': current }"
    :aria-current="current ? 'step' : undefined"
  >
    <Icon
      v-if="icon"
      :name="icon"
      :size="14"
    />
    <span
      v-if="index !== undefined && index !== ''"
      class="kit-breadcrumb-item__index"
    >{{ index }}</span>
    <span
      v-if="variant"
      class="kit-breadcrumb-item__variant"
    >{{ variant }}</span>
    <span
      v-if="label"
      class="kit-breadcrumb-item__label"
    >{{ label }}</span>
    <span
      v-if="trailing"
      class="kit-breadcrumb-item__trailing"
    >{{ trailing }}</span>
  </li>
</template>

<style>
.kit-breadcrumb-item { display: inline-flex; align-items: baseline; flex-shrink: 0; gap: 6px; font-size: 13px; line-height: 20px; white-space: nowrap; color: var(--kit-text-muted); }
.kit-breadcrumb-item + .kit-breadcrumb-item::before { content: "\203A" / ""; margin-inline: 6px; color: var(--kit-text-subtle); }
.kit-breadcrumb-item > .kit-icon { align-self: center; }
.kit-breadcrumb-item__index { font-family: var(--kit-font-mono); font-feature-settings: var(--kit-font-mono-features); font-size: 12px; font-variant-numeric: tabular-nums; color: var(--kit-text-subtle); }
.kit-breadcrumb-item__variant { max-width: 14rem; overflow: hidden; text-overflow: ellipsis; font-weight: 500; color: var(--kit-text); }
.kit-breadcrumb-item__label { max-width: 10rem; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--kit-text-muted); }
.kit-breadcrumb-item__trailing { font-size: 12px; color: var(--kit-text-subtle); }
.kit-breadcrumb-item.is-current .kit-breadcrumb-item__variant { color: var(--kit-text-highlighted); }
.kit-breadcrumb-item.is-current .kit-breadcrumb-item__index { color: var(--kit-text-muted); }
</style>
