<script setup lang="ts">
import Icon from './Icon.vue'

/**
 * One option of a Kit select's listbox panel. It is controlled: `selected` shows the check, and its
 * press reaches the parent as the native `click` event (Enter and Space press it too, once it has focus).
 * A disabled option is muted, `aria-disabled` and presses nothing. The label arrives as the `label`
 * prop or the default slot.
 */
const props = defineProps<{
  label?: string
  selected?: boolean
  disabled?: boolean
}>()

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled || event.target !== event.currentTarget) return
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).click()
}
</script>

<template>
  <div
    class="kit-select-option"
    :class="{ 'is-selected': selected, 'is-disabled': disabled }"
    role="option"
    tabindex="-1"
    :aria-selected="selected ? 'true' : 'false'"
    :aria-disabled="disabled ? 'true' : undefined"
    @keydown="onKeydown"
  >
    <span class="kit-select-option__label"><slot>{{ label }}</slot></span>
    <Icon
      v-if="selected"
      name="check"
      :size="16"
    />
  </div>
</template>

<style>
.kit-select-option { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; padding: 4px 8px; box-sizing: border-box; font-size: 13px; line-height: 20px; color: var(--kit-text); border-radius: 6px; cursor: pointer; outline: none; }
.kit-select-option:hover { background-color: var(--kit-bg-surface-elevated); }
.kit-select-option:focus-visible { outline: 2px solid var(--kit-primary); outline-offset: -2px; }
.kit-select-option.is-selected { color: var(--kit-text-highlighted); font-weight: 500; }
.kit-select-option.is-selected .kit-icon { color: var(--kit-primary); }
.kit-select-option.is-disabled { cursor: not-allowed; color: var(--kit-text-subtle); }
.kit-select-option.is-disabled:hover { background-color: transparent; }
.kit-select-option__label { min-width: 0; overflow-wrap: anywhere; }
</style>
