<script setup lang="ts">
import Icon from './Icon.vue'
import Kbd from './Kbd.vue'

/**
 * The Kit button (DESIGN.md "Buttons"): neutral outline by default, one solid `primary` per region.
 * It is controlled and has no state of its own: it renders from its props and its click reaches the
 * parent as the native `click` event. The label arrives as the `label` prop or the default slot;
 * `icon-only` shows only the icon and keeps the label as the accessible name.
 */
defineProps<{
  /** The label text, which is also the accessible name of an icon-only button. */
  label?: string
  /** Default `secondary`. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'annotation' | 'link' | 'brand' | 'display'
  /** Default `md`. */
  size?: 'sm' | 'md' | 'lg'
  /** Leading Lucide icon name (icons.ts). */
  icon?: string
  /** Trailing Lucide icon name. */
  trailingIcon?: string
  /** A keyboard shortcut hint shown after the label. */
  kbd?: string
  iconOnly?: boolean
  fullWidth?: boolean
  /** 44px target, for a touch render context. */
  touch?: boolean
  disabled?: boolean
  /** Default `button`. */
  type?: 'button' | 'submit' | 'reset'
}>()
</script>

<template>
  <button
    class="kit-btn"
    :class="[`kit-btn--${variant ?? 'secondary'}`, `kit-btn--${size ?? 'md'}`, { 'is-touch': touch, 'is-icon-only': iconOnly, 'is-full-width': fullWidth }]"
    :type="type ?? 'button'"
    :disabled="disabled"
    :aria-label="iconOnly ? label : undefined"
    :title="iconOnly ? label : undefined"
  >
    <slot name="leading">
      <Icon
        v-if="icon"
        :name="icon"
        :size="16"
      />
    </slot>
    <span v-if="!iconOnly"><slot>{{ label }}</slot></span>
    <Kbd
      v-if="kbd && !iconOnly"
      :keys="kbd"
      class="kit-btn__kbd"
    />
    <slot name="trailing">
      <Icon
        v-if="trailingIcon && !iconOnly"
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
.kit-btn.kit-btn--sm { padding: 3px 8px; font-size: 13px; height: 28px; }
.kit-btn.kit-btn--md { padding: 5px 10px; font-size: 13px; height: 32px; }
.kit-btn.kit-btn--lg { padding: 8px 14px; font-size: 14px; height: 40px; }
.kit-btn.is-touch { min-height: 44px; }
.kit-btn.is-icon-only.kit-btn--sm { width: 28px; padding: 0; }
.kit-btn.is-icon-only.kit-btn--md { width: 32px; padding: 0; }
.kit-btn.is-icon-only.kit-btn--lg { width: 40px; padding: 0; }
.kit-btn.is-icon-only.is-touch { width: 44px; height: 44px; }
.kit-btn.is-full-width { width: 100%; }
.kit-btn.kit-btn--primary:not(:disabled) { background-color: var(--kit-primary); color: var(--kit-on-primary); border-color: var(--kit-primary); }
.kit-btn.kit-btn--primary:hover:not(:disabled) { background-color: var(--kit-primary-hover); border-color: var(--kit-primary-hover); }
.kit-btn.kit-btn--secondary, .kit-btn.kit-btn--outline { background-color: var(--kit-bg-surface); color: var(--kit-text); border-color: var(--kit-border-control); }
.kit-btn.kit-btn--secondary:hover:not(:disabled), .kit-btn.kit-btn--outline:hover:not(:disabled) { background-color: var(--kit-bg-surface-elevated); }
.kit-btn.kit-btn--ghost { background-color: transparent; color: var(--kit-text-muted); }
.kit-btn.kit-btn--ghost:hover:not(:disabled) { background-color: var(--kit-bg-surface-elevated); color: var(--kit-text-highlighted); }
.kit-btn.kit-btn--annotation { background-color: var(--kit-annotation-subtle); color: var(--kit-annotation); border-color: var(--kit-annotation-border); }
.kit-btn.kit-btn--annotation:hover:not(:disabled) { background-color: var(--kit-annotation-hover); }
.kit-btn.kit-btn--danger { background-color: var(--kit-danger-subtle); color: var(--kit-danger); border-color: var(--kit-danger-border); }
.kit-btn.kit-btn--danger:hover:not(:disabled) { background-color: var(--kit-danger-hover); }
.kit-btn.kit-btn--link { background: none; border-color: transparent; color: var(--kit-primary); padding-inline: 0; text-decoration: underline; text-underline-offset: 3px; }
.kit-btn.kit-btn--brand:not(:disabled) { background-color: var(--kit-brand); color: var(--kit-on-brand); border-color: var(--kit-brand); }
.kit-btn.kit-btn--brand:hover:not(:disabled) { background-color: var(--kit-brand-hover); }
.kit-btn.kit-btn--display { background: transparent; border-color: transparent; height: auto; min-height: 40px; padding: 0 4px; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -0.012em; color: var(--kit-text-highlighted); white-space: normal; text-align: left; }
.kit-btn.kit-btn--display:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 1px; }
.kit-btn.kit-btn--display.is-touch { min-height: 44px; font-size: 18px; line-height: 26px; }
.kit-btn .kit-btn__kbd { margin-left: 2px; height: 18px; min-width: 18px; }
.kit-btn.kit-btn--primary .kit-btn__kbd { background: transparent; color: inherit; border-color: currentColor; opacity: 1; }
</style>
