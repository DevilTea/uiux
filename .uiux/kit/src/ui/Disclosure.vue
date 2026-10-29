<script setup lang="ts">
import { useId } from 'vue'
import Icon from './Icon.vue'

/**
 * The Kit disclosure: a header button that shows or hides its content. It is controlled: `open` is
 * the state, and a press on the header reaches the parent as `toggle`. The header carries a chevron,
 * the `label`, and a muted `meta` (a count or a status) at the end; the default slot is the content,
 * which stays in the document while closed and is hidden from sight and assistive technology. The header
 * is `aria-expanded` and `aria-controls` the content region.
 */
defineProps<{
  label?: string
  /** Muted text at the end of the header, such as a count. Alternatively fill the `trailing` slot. */
  meta?: string
  open?: boolean
  /** Leading Lucide icon name (icons.ts), before the label. */
  icon?: string
  /** Which side of the label the chevron sits on. Default `start` (right when closed, down when open); `end` shows down when closed and up when open. */
  chevron?: 'start' | 'end'
  /** `row` is a full-width row (default); `link` is a link-style toggle that is as wide as its text. */
  appearance?: 'row' | 'link'
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
}>()

const id = `kit-disclosure-${useId()}`
</script>

<template>
  <div class="kit-disclosure">
    <button
      :id="`${id}-header`"
      class="kit-disclosure__header"
      :class="{ 'is-link': appearance === 'link' }"
      type="button"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="`${id}-region`"
      @click="emit('toggle')"
    >
      <Icon
        v-if="chevron !== 'end'"
        :name="open ? 'chevron-down' : 'chevron-right'"
        :size="16"
      />
      <Icon
        v-if="icon"
        :name="icon"
        :size="16"
      />
      <span class="kit-disclosure__label"><slot name="label">{{ label }}</slot></span>
      <span class="kit-disclosure__trailing"><slot name="trailing">{{ meta }}</slot></span>
      <Icon
        v-if="chevron === 'end'"
        :name="open ? 'chevron-up' : 'chevron-down'"
        :size="16"
      />
    </button>
    <div
      v-show="open"
      :id="`${id}-region`"
      class="kit-disclosure__region"
      role="region"
      :aria-labelledby="`${id}-header`"
    >
      <slot />
    </div>
  </div>
</template>

<style>
.kit-disclosure { display: flex; flex-direction: column; gap: 4px; min-width: 0; box-sizing: border-box; }
.kit-disclosure__header {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px; box-sizing: border-box; border: 0; border-radius: 6px;
  background: transparent; color: var(--kit-text); font: inherit; font-size: 13px; line-height: 20px; text-align: start; cursor: pointer;
  min-height: var(--kit-target-min, 28px);
}
.kit-disclosure__header:hover { background-color: var(--kit-bg-surface-elevated); }
.kit-disclosure__header:focus-visible { outline: 2px solid var(--kit-primary); outline-offset: 2px; }
.kit-disclosure__header .kit-icon { color: var(--kit-text-muted); }
.kit-disclosure__label { flex: 1 1 auto; min-width: 0; font-weight: 500; color: var(--kit-text-highlighted); overflow-wrap: anywhere; }
.kit-disclosure__trailing { flex-shrink: 0; font-size: 12px; color: var(--kit-text-muted); }
.kit-disclosure__trailing:empty { display: none; }
.kit-disclosure__header.is-link { width: auto; align-self: flex-start; padding: 2px 0; color: var(--kit-text-muted); }
.kit-disclosure__header.is-link:hover { background: transparent; color: var(--kit-text-highlighted); }
.kit-disclosure__header.is-link .kit-disclosure__label { flex: 0 1 auto; font-weight: 400; color: inherit; }
.kit-disclosure__region { min-width: 0; }
</style>
