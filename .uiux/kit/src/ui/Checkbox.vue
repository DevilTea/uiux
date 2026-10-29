<script setup lang="ts">
import { nextTick, onMounted, useId, useTemplateRef, watch } from 'vue'
import Icon from './Icon.vue'

/**
 * The Kit checkbox: a native `<input type="checkbox">` with its label, an optional description and a
 * mono `meta` at the end. It is controlled: `checked` is the state, and a change reaches the parent as
 * `toggle` with the requested value; the box shows the `checked` it is given, so a parent that does
 * not accept the change leaves it as it was. `indeterminate` is the mixed state, which a press clears.
 * The label names the control and the description describes it. A `warning` description carries an
 * icon, so color is never the only signal.
 */
const props = defineProps<{
  label?: string
  /** Secondary text under the label. */
  description?: string
  /** Default `muted`. */
  descriptionTone?: 'muted' | 'warning'
  checked?: boolean
  indeterminate?: boolean
  disabled?: boolean
  /** Literal mono text at the end of the row, such as an id or a count. */
  meta?: string
  /** The label is mono 12px text, for ids and file names. */
  mono?: boolean
  /** The whole row is a 44px target, centered on its content. */
  touch?: boolean
  name?: string
  /** The control's id; generated when omitted. */
  id?: string
}>()

const emit = defineEmits<{
  (e: 'toggle', checked: boolean): void
}>()

const generatedId = useId()
const controlId = `kit-checkbox-${generatedId}`
const input = useTemplateRef<HTMLInputElement>('input')

/** The native control shows exactly what the props say; a press does not own the state. */
function sync(): void {
  if (!input.value) return
  input.value.checked = Boolean(props.checked)
  input.value.indeterminate = Boolean(props.indeterminate)
}
onMounted(sync)
watch(() => [props.checked, props.indeterminate], sync)

function onChange(event: Event): void {
  emit('toggle', (event.target as HTMLInputElement).checked)
  void nextTick(sync)
}
</script>

<template>
  <label
    class="kit-checkbox"
    :class="{ 'is-disabled': disabled, 'is-mono': mono, 'is-touch': touch }"
  >
    <input
      :id="id ?? controlId"
      ref="input"
      class="kit-checkbox__control"
      type="checkbox"
      :name="name"
      :checked="checked"
      :disabled="disabled"
      :aria-labelledby="label ? `${controlId}-label` : undefined"
      :aria-describedby="description ? `${controlId}-description` : undefined"
      @change="onChange"
    >
    <span class="kit-checkbox__text">
      <span
        v-if="label"
        :id="`${controlId}-label`"
        class="kit-checkbox__label"
      >{{ label }}</span>
      <span
        v-if="description"
        :id="`${controlId}-description`"
        class="kit-checkbox__description"
        :class="`is-${descriptionTone ?? 'muted'}`"
      >
        <Icon
          v-if="descriptionTone === 'warning'"
          name="triangle-alert"
          :size="14"
        />{{ description }}
      </span>
    </span>
    <span
      v-if="meta"
      class="kit-checkbox__meta"
    >{{ meta }}</span>
  </label>
</template>

<style>
.kit-checkbox { display: flex; align-items: flex-start; gap: 8px; min-width: 0; box-sizing: border-box; cursor: pointer; font-size: 13px; line-height: 20px; color: var(--kit-text); }
.kit-checkbox.is-disabled { cursor: not-allowed; color: var(--kit-text-subtle); }
.kit-checkbox.is-touch { align-items: center; min-height: 44px; }
.kit-checkbox.is-touch .kit-checkbox__control { margin: 0; }
.kit-checkbox.is-mono .kit-checkbox__label { font-family: var(--kit-font-mono); font-size: 12px; font-weight: 400; line-height: 16px; }
.kit-checkbox__control { flex-shrink: 0; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--kit-primary); cursor: inherit; }
.kit-checkbox__control:focus-visible { outline: 2px solid var(--kit-primary); outline-offset: 2px; }
.kit-checkbox__text { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.kit-checkbox__label { font-weight: 500; overflow-wrap: anywhere; }
.kit-checkbox__description { display: flex; align-items: flex-start; gap: 4px; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.kit-checkbox__description.is-muted { color: var(--kit-text-muted); }
.kit-checkbox__description.is-warning { color: var(--kit-warning); }
.kit-checkbox__description .kit-icon { margin-top: 2px; }
.kit-checkbox__meta { flex-shrink: 0; font-family: var(--kit-font-mono); font-size: 12px; line-height: 20px; color: var(--kit-text-muted); }
</style>
