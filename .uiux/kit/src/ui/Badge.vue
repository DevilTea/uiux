<script setup lang="ts">
import Icon from './Icon.vue'

/**
 * The Kit badge and chip (DESIGN.md "Chips and badges"): a status badge, a mono identity chip
 * (`variant="mono"`, the blueprint register) or a count pill (`variant="count"`). It carries an
 * optional leading icon so color is never the only signal. It is controlled and has no state: the
 * text arrives as the `label` prop or the default slot.
 */
defineProps<{
  label?: string
  /** Default `neutral`. */
  tone?: 'neutral' | 'primary' | 'annotation' | 'success' | 'warning' | 'danger' | 'info'
  /** Default `subtle`. */
  variant?: 'subtle' | 'soft' | 'solid' | 'outline' | 'mono' | 'count'
  /** Leading Lucide icon name (icons.ts). */
  icon?: string
  /** Spins the leading icon, for work in progress (use `loader-circle`). It stands still under `prefers-reduced-motion`. */
  spin?: boolean
}>()
</script>

<template>
  <span
    class="kit-badge"
    :class="[`kit-badge--tone-${tone ?? 'neutral'}`, `kit-badge--${variant ?? 'subtle'}`, { 'is-spin': spin }]"
  >
    <slot name="leading"><Icon
      v-if="icon"
      :name="icon"
      :size="14"
    /></slot>
    <slot>{{ label }}</slot>
  </span>
</template>

<style>
.kit-badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; min-height: 20px; box-sizing: border-box;
  font-size: 12px; font-weight: 500; line-height: 16px; border-radius: 4px; white-space: nowrap;
  border: 1px solid transparent; flex-shrink: 0;
}
.kit-badge .kit-icon { width: 14px; height: 14px; }
.kit-badge.is-spin .kit-icon { animation: kit-badge-spin 1s linear infinite; }
@keyframes kit-badge-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .kit-badge.is-spin .kit-icon { animation: none; } }
.kit-badge.kit-badge--tone-neutral { --kit-badge-fg: var(--kit-text-muted); --kit-badge-bg: var(--kit-bg-surface-elevated); --kit-badge-border: var(--kit-border); --kit-badge-solid: var(--kit-text-muted); }
.kit-badge.kit-badge--tone-primary { --kit-badge-fg: var(--kit-primary); --kit-badge-bg: var(--kit-primary-subtle); --kit-badge-border: var(--kit-primary-border); --kit-badge-solid: var(--kit-primary); }
.kit-badge.kit-badge--tone-annotation { --kit-badge-fg: var(--kit-annotation); --kit-badge-bg: var(--kit-annotation-subtle); --kit-badge-border: var(--kit-annotation-border); --kit-badge-solid: var(--kit-pin); }
.kit-badge.kit-badge--tone-success { --kit-badge-fg: var(--kit-success); --kit-badge-bg: var(--kit-success-subtle); --kit-badge-border: var(--kit-success-border); --kit-badge-solid: var(--kit-success); }
.kit-badge.kit-badge--tone-warning { --kit-badge-fg: var(--kit-warning); --kit-badge-bg: var(--kit-warning-subtle); --kit-badge-border: var(--kit-warning-border); --kit-badge-solid: var(--kit-warning); }
.kit-badge.kit-badge--tone-danger { --kit-badge-fg: var(--kit-danger); --kit-badge-bg: var(--kit-danger-subtle); --kit-badge-border: var(--kit-danger-border); --kit-badge-solid: var(--kit-danger); }
.kit-badge.kit-badge--tone-info { --kit-badge-fg: var(--kit-info); --kit-badge-bg: var(--kit-info-subtle); --kit-badge-border: var(--kit-info-border); --kit-badge-solid: var(--kit-info); }
.kit-badge.kit-badge--subtle { color: var(--kit-badge-fg); background-color: var(--kit-badge-bg); border-color: var(--kit-badge-border); }
.kit-badge.kit-badge--soft { color: var(--kit-badge-fg); background-color: var(--kit-badge-bg); }
.kit-badge.kit-badge--outline { color: var(--kit-badge-fg); background-color: transparent; border-color: var(--kit-badge-border); }
.kit-badge.kit-badge--solid { color: var(--kit-bg-surface); background-color: var(--kit-badge-solid); border-color: var(--kit-badge-solid); }
.kit-badge.kit-badge--mono { font-family: var(--kit-font-mono); font-weight: 400; color: var(--kit-text-muted); background-color: var(--kit-bg-surface-elevated); }
.kit-badge.kit-badge--count { min-width: 20px; justify-content: center; color: var(--kit-badge-fg); background-color: var(--kit-badge-bg); }
</style>
