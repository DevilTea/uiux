<script setup lang="ts">
import Icon from './Icon.vue'
import Kbd from './Kbd.vue'

/**
 * The Kit button (DESIGN.md "Buttons"): neutral outline by default, one solid `primary` per region
 * (`neutral` is the solid neutral one, for the current choice of a group; `link` is a primary link and
 * `link-muted` a quiet one). It is controlled and has no state of its own: it renders from its props and its click reaches the
 * parent as the native `click` event. The label arrives as the `label` prop or the default slot;
 * `icon-only` shows only the icon and keeps the label as the accessible name.
 *
 * `soft` is the quiet filled look (an elevated fill, no border) and is also how a pressed toggle looks (`pressed`);
 * `expanded` turns the trailing icon half a turn for a disclosure toggle; `truncate` ends a long label in an
 * ellipsis (the button then yields to the width its parent gives it, `max-width: 100%`). Buttons placed side by
 * side in a `ButtonGroup` join into one control.
 */
// `pressed` and `expanded` default to `undefined` on purpose: Vue casts an absent Boolean prop to `false`, which would make every
// Button a toggle and a disclosure. The other optional props stay unset, as before.
/* eslint-disable vue/require-default-prop */
const props = withDefaults(defineProps<{
  /** The label text, which is also the accessible name of an icon-only button. */
  label?: string
  /** Default `secondary`. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'annotation' | 'link' | 'link-muted' | 'brand' | 'display' | 'neutral' | 'soft'
  /** Default `md`. `xs` is 24px, for a dense row. */
  size?: 'xs' | 'sm' | 'md' | 'lg'
  /** Leading Lucide icon name (icons.ts). */
  icon?: string
  /** Trailing Lucide icon name. */
  trailingIcon?: string
  /** A keyboard shortcut hint shown after the label. */
  kbd?: string
  iconOnly?: boolean
  fullWidth?: boolean
  /**
   * Makes the button a toggle: `aria-pressed` is `true` or `false`, and a pressed button takes the `soft` look
   * over its variant. Leave it out for a button that is not a toggle (no `aria-pressed`).
   */
  pressed?: boolean
  /**
   * For a button that opens and closes something: `aria-expanded` is `true` or `false`, and while expanded the
   * trailing icon (a chevron) turns 180 degrees. Leave it out for a button that discloses nothing.
   */
  expanded?: boolean
  /** A long label ends in an ellipsis instead of widening the button, and the `label` text is its `title`. */
  truncate?: boolean
  /** 44px target, for a touch render context. */
  touch?: boolean
  disabled?: boolean
  /**
   * Work is in progress: a spinning icon replaces the leading icon (or is the whole content of an
   * icon-only button), the button is busy (`aria-busy`) and does not press, and it looks disabled.
   */
  loading?: boolean
  /** Default `button`. */
  type?: 'button' | 'submit' | 'reset'
}>(), { pressed: undefined, expanded: undefined })
/* eslint-enable vue/require-default-prop */
</script>

<template>
  <button
    class="kit-btn"
    :class="[`kit-btn--${variant ?? 'secondary'}`, `kit-btn--${size ?? 'md'}`, { 'is-touch': touch, 'is-icon-only': iconOnly, 'is-full-width': fullWidth, 'is-loading': loading, 'is-pressed': pressed, 'is-expanded': expanded, 'is-truncate': truncate }]"
    :type="type ?? 'button'"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
    :aria-pressed="props.pressed"
    :aria-expanded="props.expanded"
    :aria-label="iconOnly ? label : undefined"
    :title="iconOnly || truncate ? label : undefined"
  >
    <slot name="leading">
      <Icon
        v-if="loading"
        class="kit-btn__spinner"
        name="loader-circle"
        :size="16"
      />
      <Icon
        v-else-if="icon"
        :name="icon"
        :size="16"
      />
    </slot>
    <span
      v-if="!iconOnly"
      class="kit-btn__label"
    ><slot>{{ label }}</slot></span>
    <Kbd
      v-if="kbd && !iconOnly"
      :keys="kbd"
      class="kit-btn__kbd"
    />
    <slot name="trailing">
      <Icon
        v-if="trailingIcon && !iconOnly"
        class="kit-btn__trailing"
        :name="trailingIcon"
        :size="14"
      />
    </slot>
  </button>
</template>

<style>
.kit-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; box-sizing: border-box;
  font-family: inherit; font-weight: 500; border-radius: 6px; cursor: pointer;
  border: 1px solid transparent; white-space: nowrap; user-select: none; line-height: 20px; flex-shrink: 0;
  min-height: var(--kit-target-min, 0px);
  transition: background-color 120ms cubic-bezier(0.2, 0, 0, 1), border-color 120ms cubic-bezier(0.2, 0, 0, 1), color 120ms cubic-bezier(0.2, 0, 0, 1);
}
.kit-btn:focus-visible { outline: 2px solid var(--kit-primary); outline-offset: 2px; }
.kit-btn:disabled { cursor: not-allowed; color: var(--kit-text-subtle); background-color: var(--kit-bg-surface-elevated); border-color: var(--kit-border); }
.kit-btn.kit-btn--xs { padding: 3px 8px; gap: 4px; font-size: 12px; line-height: 16px; height: 24px; }
.kit-btn.kit-btn--sm { padding: 3px 8px; font-size: 13px; height: 28px; }
.kit-btn.kit-btn--md { padding: 5px 10px; font-size: 13px; height: 32px; }
.kit-btn.kit-btn--lg { padding: 8px 14px; font-size: 14px; height: 40px; }
.kit-btn.is-touch { min-height: 44px; }
.kit-btn.is-icon-only.kit-btn--xs { width: 24px; padding: 0; }
.kit-btn.is-icon-only.kit-btn--sm { width: 28px; padding: 0; }
.kit-btn.is-icon-only.kit-btn--md { width: 32px; padding: 0; }
.kit-btn.is-icon-only.kit-btn--lg { width: 40px; padding: 0; }
.kit-btn.is-icon-only.is-touch { width: 44px; height: 44px; }
.kit-btn.is-full-width { width: 100%; }
.kit-btn.kit-btn--primary { background-color: var(--kit-primary); color: var(--kit-on-primary); border-color: var(--kit-primary); }
.kit-btn.kit-btn--primary:disabled { opacity: 0.6; }
.kit-btn.kit-btn--neutral { background-color: var(--kit-text-highlighted); color: var(--kit-text-inverted); border-color: var(--kit-text-highlighted); }
.kit-btn.kit-btn--neutral:hover:not(:disabled) { opacity: 0.9; }
.kit-btn.kit-btn--neutral:disabled { opacity: 0.6; }
.kit-btn.is-loading { cursor: progress; }
.kit-btn .kit-btn__spinner { animation: kit-btn-spin 1s linear infinite; }
@keyframes kit-btn-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .kit-btn .kit-btn__spinner { animation: none; } }
.kit-btn.kit-btn--primary:hover:not(:disabled) { background-color: var(--kit-primary-hover); border-color: var(--kit-primary-hover); }
.kit-btn.kit-btn--secondary, .kit-btn.kit-btn--outline { background-color: var(--kit-bg-surface); color: var(--kit-text); border-color: var(--kit-border-control); }
.kit-btn.kit-btn--secondary:hover:not(:disabled), .kit-btn.kit-btn--outline:hover:not(:disabled) { background-color: var(--kit-bg-surface-elevated); }
.kit-btn.kit-btn--ghost { background-color: transparent; color: var(--kit-text-muted); }
.kit-btn.kit-btn--ghost:hover:not(:disabled) { background-color: var(--kit-bg-surface-elevated); color: var(--kit-text-highlighted); }
.kit-btn.kit-btn--ghost:disabled { background-color: transparent; border-color: transparent; color: var(--kit-text-muted); opacity: 0.6; }
.kit-btn.kit-btn--annotation { background-color: var(--kit-annotation-subtle); color: var(--kit-annotation); border-color: var(--kit-annotation-border); }
.kit-btn.kit-btn--annotation:hover:not(:disabled) { background-color: var(--kit-annotation-hover); }
.kit-btn.kit-btn--danger { background-color: var(--kit-danger-subtle); color: var(--kit-danger); border-color: var(--kit-danger-border); }
.kit-btn.kit-btn--danger:hover:not(:disabled) { background-color: var(--kit-danger-hover); }
.kit-btn.kit-btn--link { background: none; border-color: transparent; color: var(--kit-primary); padding-inline: 0; text-decoration: underline; text-underline-offset: 3px; }
.kit-btn.kit-btn--link-muted { background: none; border-color: transparent; color: var(--kit-text-muted); padding-inline: 0; }
.kit-btn.kit-btn--link-muted:hover:not(:disabled) { color: var(--kit-text-highlighted); }
.kit-btn.kit-btn--link:disabled, .kit-btn.kit-btn--link-muted:disabled { background: none; border-color: transparent; opacity: 0.6; }
.kit-btn.kit-btn--brand:not(:disabled) { background-color: var(--kit-brand); color: var(--kit-on-brand); border-color: var(--kit-brand); }
.kit-btn.kit-btn--brand:hover:not(:disabled) { background-color: var(--kit-brand-hover); }
.kit-btn.kit-btn--display { background: transparent; border-color: transparent; height: auto; min-height: 40px; padding: 0 4px; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -0.012em; color: var(--kit-text-highlighted); white-space: normal; text-align: left; }
.kit-btn.kit-btn--display:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 1px; }
.kit-btn.kit-btn--display.is-touch { min-height: 44px; font-size: 18px; line-height: 26px; }
.kit-btn.kit-btn--soft:not(:disabled), .kit-btn.is-pressed:not(:disabled) { background-color: var(--kit-bg-surface-elevated); color: var(--kit-text); border-color: transparent; }
.kit-btn.kit-btn--soft:hover:not(:disabled), .kit-btn.is-pressed:hover:not(:disabled) { background-color: color-mix(in oklab, var(--kit-bg-accented) 75%, transparent); }
.kit-btn.is-truncate { max-width: 100%; min-width: 0; flex-shrink: 1; }
.kit-btn.is-truncate .kit-btn__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kit-btn .kit-btn__trailing { transition: transform 150ms cubic-bezier(0.2, 0, 0, 1); }
.kit-btn.is-expanded .kit-btn__trailing { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) { .kit-btn .kit-btn__trailing { transition: none; } }
.kit-btn .kit-btn__kbd { margin-left: 2px; height: 18px; min-width: 18px; }
.kit-btn.kit-btn--primary .kit-btn__kbd { background: transparent; color: inherit; border-color: currentColor; opacity: 1; }
</style>
