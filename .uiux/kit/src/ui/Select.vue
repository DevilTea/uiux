<script setup lang="ts">
import { computed, useId } from 'vue'
import Icon from './Icon.vue'

/**
 * The Kit select (DESIGN.md "Inputs / Fields"): a labelled trigger that shows the chosen value, and,
 * while `open`, a listbox panel that holds the default slot (SelectOption rows). It is controlled and
 * has no state of its own: `value` is the text to show (a `multiple` select shows its chosen values
 * joined with a comma and a space, as the Workbench's own select does), `open` shows the panel, and the
 * trigger press and Escape reach the parent as `toggle`. Choosing and searching belong to the product's
 * own select; this component is its look, its roles and its keyboard entry.
 *
 * The trigger is a select-only combobox: the label names it, the help text describes it, and it
 * exposes `aria-expanded`, `aria-required` and `aria-invalid`.
 */
const props = defineProps<{
  label?: string
  /** Keeps the label for assistive technology only (a select whose name is clear from its place). */
  hideLabel?: boolean
  help?: string
  /** Shown, muted, while `value` is empty. */
  placeholder?: string
  /** The chosen value as shown; literal text. */
  value?: string
  /** Marks the label with `*` and the control as required. */
  required?: boolean
  /** The panel is a multi-select listbox. */
  multiple?: boolean
  invalid?: boolean
  disabled?: boolean
  /** The listbox panel is shown. */
  open?: boolean
  /** The trigger's id; generated when omitted. */
  id?: string
}>()

const emit = defineEmits<{
  /** The trigger was pressed, or Escape asked to close: the parent flips `open`. */
  (e: 'toggle'): void
}>()

const generatedId = useId()
const triggerId = computed(() => props.id ?? `kit-select-${generatedId}`)
const labelId = computed(() => `${triggerId.value}-label`)
const listId = computed(() => `${triggerId.value}-list`)
const helpId = computed(() => `${triggerId.value}-help`)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) {
    event.preventDefault()
    emit('toggle')
  }
  else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !props.open) {
    event.preventDefault()
    emit('toggle')
  }
}
</script>

<template>
  <div class="kit-select">
    <label
      v-if="label"
      :id="labelId"
      class="kit-select__label"
      :class="{ 'is-required': required, 'is-visually-hidden': hideLabel }"
      :for="triggerId"
    >{{ label }}</label>
    <div class="kit-select__shell">
      <button
        :id="triggerId"
        class="kit-select__trigger"
        :class="{ 'is-invalid': invalid, 'is-open': open }"
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-controls="open ? listId : undefined"
        :aria-labelledby="label ? labelId : undefined"
        :aria-label="label ? undefined : (placeholder || undefined)"
        :aria-describedby="help ? helpId : undefined"
        :aria-required="required ? 'true' : undefined"
        :aria-invalid="invalid ? 'true' : undefined"
        :disabled="disabled"
        @click="emit('toggle')"
        @keydown="onKeydown"
      >
        <span
          class="kit-select__value"
          :class="{ 'is-placeholder': !value }"
        >{{ value || placeholder }}</span>
        <Icon
          name="chevron-down"
          :size="16"
        />
      </button>
      <div
        v-if="open"
        :id="listId"
        class="kit-select__panel"
        role="listbox"
        :aria-multiselectable="multiple ? 'true' : undefined"
        :aria-labelledby="label ? labelId : undefined"
        :aria-label="label ? undefined : (placeholder || undefined)"
        @keydown="onKeydown"
      >
        <slot />
      </div>
    </div>
    <p
      v-if="help"
      :id="helpId"
      class="kit-select__help"
    >
      {{ help }}
    </p>
  </div>
</template>

<style>
.kit-select { display: flex; flex-direction: column; gap: 6px; width: 100%; box-sizing: border-box; min-width: 0; }
.kit-select__label { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--kit-text); }
.kit-select__label.is-visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.kit-select__label.is-required::after { content: "*"; margin-inline-start: 2px; color: var(--kit-danger); }
.kit-select__shell { position: relative; width: 100%; }
.kit-select__trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; height: 32px; padding: 5px 10px; box-sizing: border-box;
  font-family: inherit; font-size: 13px; line-height: 20px; text-align: start; color: var(--kit-text); cursor: pointer;
  background-color: var(--kit-input-bg); border: 1px solid var(--kit-border-control); border-radius: 6px; outline: none;
  min-height: var(--kit-target-min, 0px); transition: border-color 120ms ease;
}
.kit-select__trigger:focus-visible, .kit-select__trigger.is-open { border-color: var(--kit-primary); box-shadow: 0 0 0 1px var(--kit-primary); }
.kit-select__trigger.is-invalid { border-color: var(--kit-danger); }
.kit-select__trigger:disabled { cursor: not-allowed; color: var(--kit-text-subtle); background-color: var(--kit-bg-surface-elevated); }
.kit-select__trigger .kit-icon { color: var(--kit-text-subtle); }
.kit-select__value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kit-select__value.is-placeholder { color: var(--kit-text-subtle); }
.kit-select__panel {
  position: absolute; z-index: 10; inset-inline: 0; top: 100%; margin-top: 4px; box-sizing: border-box; max-height: 240px; overflow-y: auto; padding: 4px;
  background-color: var(--kit-bg-surface); border: 1px solid var(--kit-border-subtle); border-radius: 8px; box-shadow: var(--kit-shadow-overlay);
}
.kit-select__help { font-size: 12px; line-height: 18px; color: var(--kit-text-muted); margin: 0; }
</style>
