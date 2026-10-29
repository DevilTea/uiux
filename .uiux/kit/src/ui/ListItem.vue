<script setup lang="ts">
/**
 * The Kit list item: one generic row for lists, timelines, step lists and trees. Three slots hold
 * what the row shows: `leading` (an icon, a marker or a number), `content` (the default slot works
 * too) and `trailing` (a badge, a time or an action). It is controlled and has no state: `selected`,
 * `dimmed`, `level` (the indent, 16px per level) and `divided` (a hairline below) render from props.
 *
 * `interactive` makes the whole row one button-like target: focusable, and Enter or Space press it.
 * Its press reaches the parent as the native `click` event. An interactive row must not hold another
 * interactive control in `trailing`, since the row is already the control.
 */
const props = defineProps<{
  /** The row is the current one: a primary tint and a 2px primary bar. */
  selected?: boolean
  /** The row is de-emphasized, such as a version after the one shown. */
  dimmed?: boolean
  /** Indent depth, 16px per level. Default 0. */
  level?: number
  /** A hairline below the row. */
  divided?: boolean
  /** The row is pressable. */
  interactive?: boolean
  /** The row's minimum height: `sm` 28px (default), `md` 36px, `lg` 48px (a 44px touch target with padding). */
  size?: 'sm' | 'md' | 'lg'
  /** Where `leading` and `trailing` sit across a tall row. Default `center`. */
  align?: 'center' | 'start'
  /** How the current row looks: `accent` is a primary tint with a 2px bar (default), `neutral` an elevated neutral fill. */
  selectedLook?: 'accent' | 'neutral'
}>()

function onKeydown(event: KeyboardEvent): void {
  if (!props.interactive || event.target !== event.currentTarget) return
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).click()
}
</script>

<template>
  <div
    class="kit-list-item"
    :class="[
      `kit-list-item--${size ?? 'sm'}`,
      { 'is-selected': selected, 'is-dimmed': dimmed, 'is-divided': divided, 'is-interactive': interactive, 'is-align-start': align === 'start', 'is-selected-neutral': selectedLook === 'neutral' },
    ]"
    :style="level ? { '--kit-list-item-level': level } : undefined"
    :role="interactive ? 'button' : undefined"
    :tabindex="interactive ? 0 : undefined"
    :aria-current="selected ? 'true' : undefined"
    @keydown="onKeydown"
  >
    <div class="kit-list-item__leading">
      <slot name="leading" />
    </div>
    <div class="kit-list-item__content">
      <slot name="content">
        <slot />
      </slot>
    </div>
    <div class="kit-list-item__trailing">
      <slot name="trailing" />
    </div>
  </div>
</template>

<style>
.kit-list-item {
  position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; box-sizing: border-box; min-height: 28px;
  padding: 4px 8px; padding-inline-start: calc(8px + 16px * var(--kit-list-item-level, 0));
  font-size: 13px; line-height: 20px; color: var(--kit-text); border-radius: 6px;
}
.kit-list-item.kit-list-item--md { min-height: 36px; }
.kit-list-item.kit-list-item--lg { min-height: 48px; }
.kit-list-item__leading, .kit-list-item__trailing { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.kit-list-item.is-align-start { align-items: flex-start; }
.kit-list-item.is-align-start .kit-list-item__leading, .kit-list-item.is-align-start .kit-list-item__trailing { align-items: flex-start; }
.kit-list-item__content { display: flex; flex-direction: column; justify-content: center; flex: 1 1 auto; min-width: 0; }
.kit-list-item__leading:empty, .kit-list-item__trailing:empty { display: none; }
.kit-list-item.is-divided { border-bottom: 1px solid var(--kit-border-subtle); border-radius: 0; }
.kit-list-item.is-interactive { cursor: pointer; user-select: none; transition: background-color 120ms ease; }
.kit-list-item.is-interactive:hover { background-color: var(--kit-hover-bg); }
.kit-list-item.is-interactive:focus-visible { outline: 2px solid var(--kit-primary); outline-offset: -2px; }
.kit-list-item.is-selected { background-color: var(--kit-primary-subtle); color: var(--kit-text-highlighted); }
.kit-list-item.is-selected::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background-color: var(--kit-primary); }
.kit-list-item.is-selected.is-interactive:hover { background-color: var(--kit-primary-subtle); }
.kit-list-item.is-selected.is-selected-neutral { background-color: var(--kit-bg-surface-elevated); }
.kit-list-item.is-selected.is-selected-neutral::before { content: none; }
.kit-list-item.is-selected.is-selected-neutral.is-interactive:hover { background-color: var(--kit-bg-surface-elevated); }
.kit-list-item.is-dimmed { opacity: 0.6; }
</style>
