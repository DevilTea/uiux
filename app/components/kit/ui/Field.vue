<script setup lang="ts">
import { computed, onMounted, ref, useAttrs, useId } from 'vue'
import Icon from './Icon.vue'
import Kbd from './Kbd.vue'

/**
 * The Kit field (DESIGN.md "Inputs / Fields"): a text input or textarea with its label, help text
 * and error text. It is controlled: `modelValue` is the text, and a change leaves it as
 * `update:modelValue`. The error text shows only while `invalid` is true, and then replaces the help
 * text. All text arrives as props, so a product's own i18n decides it.
 *
 * Attributes: `class`, `style` and `data-*` stay on the root element (a host that identifies the
 * field, such as a Widget id, finds it there); every other attribute (`autocomplete`, `maxlength`,
 * `aria-*`, ...) goes to the input or textarea. The control is described by the error text while it
 * shows, else by the help text, and by the character counter when there is one.
 */
defineOptions({ inheritAttrs: false })
const props = defineProps<{
  /** The text; default empty. */
  modelValue?: string
  label?: string
  /** The label is for assistive technology only: it names the control but takes no room. */
  hideLabel?: boolean
  placeholder?: string
  help?: string
  error?: string
  invalid?: boolean
  /** Marks the label with `*` and the control as required. */
  required?: boolean
  readonly?: boolean
  disabled?: boolean
  /** Leading Lucide icon name (icons.ts). */
  icon?: string
  /** A keyboard shortcut hint at the end of the field. */
  kbd?: string
  /** Mono text, for identities and codes. */
  mono?: boolean
  /** Renders a textarea with this many rows; `1` is one line at the height of an input. */
  rows?: number
  /** Takes the focus when the field is mounted (a dialog's first field), so its focus ring shows. */
  autofocus?: boolean
  /** The most characters the field takes (its `maxlength`), shown as a "count / max" counter after the help line. */
  counter?: number
  /** 44px target and 16px text, for a touch render context. */
  touch?: boolean
  /** The `type` of a single-line input; default `text`. */
  type?: string
  name?: string
  /** The control's id; generated when omitted. */
  id?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const attrs = useAttrs()
const generatedId = useId()
const fieldId = computed(() => props.id ?? `kit-field-${generatedId}`)
const helpId = computed(() => `${fieldId.value}-help`)
const errorId = computed(() => `${fieldId.value}-error`)
const counterId = computed(() => `${fieldId.value}-counter`)
const showsError = computed(() => Boolean(props.invalid && props.error))
const hasCounter = computed(() => typeof props.counter === 'number' && props.counter > 0)
const count = computed(() => (props.modelValue ?? '').length)
const control = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)
onMounted(() => {
  if (props.autofocus) control.value?.focus()
})

const isRootAttribute = (name: string): boolean => name === 'class' || name === 'style' || name.startsWith('data-')
/** The attributes that stay on the root. Read at render, since `useAttrs()` is not reactive. */
function rootAttrs(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).filter(([name]) => isRootAttribute(name)))
}
/** The attributes for the control, with the ids of the text that describes it added to a given `aria-describedby`. */
function controlAttrs(): Record<string, unknown> {
  const own = Object.fromEntries(Object.entries(attrs).filter(([name]) => !isRootAttribute(name)))
  const describedBy = [own['aria-describedby'], showsError.value ? errorId.value : props.help ? helpId.value : undefined, hasCounter.value ? counterId.value : undefined].filter(Boolean).join(' ')
  const limit = hasCounter.value ? { maxlength: props.counter } : {}
  return describedBy ? { ...own, ...limit, 'aria-describedby': describedBy } : { ...own, ...limit }
}

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement | HTMLTextAreaElement).value)
}
</script>

<template>
  <div
    class="kit-field"
    :class="{ 'has-counter': hasCounter }"
    v-bind="rootAttrs()"
  >
    <label
      v-if="label"
      class="kit-field__label"
      :class="{ 'is-required': required, 'is-visually-hidden': hideLabel }"
      :for="fieldId"
    >{{ label }}</label>
    <div class="kit-field__shell">
      <Icon
        v-if="icon"
        :name="icon"
        :size="16"
      />
      <textarea
        v-if="rows"
        :id="fieldId"
        ref="control"
        class="kit-field__control"
        :class="{ 'has-icon': icon, 'has-kbd': kbd, 'is-mono': mono, 'is-invalid': invalid, 'is-single-row': rows === 1 }"
        :name="name"
        :rows="rows"
        :value="modelValue ?? ''"
        :placeholder="placeholder"
        :readonly="readonly"
        :disabled="disabled"
        :aria-label="label ? undefined : (placeholder || undefined)"
        :aria-invalid="invalid ? 'true' : undefined"
        :aria-required="required ? 'true' : undefined"
        v-bind="controlAttrs()"
        @input="onInput"
      />
      <input
        v-else
        :id="fieldId"
        ref="control"
        class="kit-field__control"
        :class="{ 'has-icon': icon, 'has-kbd': kbd, 'is-mono': mono, 'is-touch': touch, 'is-invalid': invalid }"
        :type="type ?? 'text'"
        :name="name"
        :value="modelValue ?? ''"
        :placeholder="placeholder"
        :readonly="readonly"
        :disabled="disabled"
        :aria-label="label ? undefined : (placeholder || undefined)"
        :aria-invalid="invalid ? 'true' : undefined"
        :aria-required="required ? 'true' : undefined"
        v-bind="controlAttrs()"
        @input="onInput"
      >
      <Kbd
        v-if="kbd"
        :keys="kbd"
        class="kit-field__kbd"
      />
    </div>
    <p
      v-if="showsError"
      :id="errorId"
      class="kit-field__error"
      role="alert"
    >
      <Icon
        name="circle-alert"
        :size="14"
      /><span>{{ error }}</span>
    </p>
    <p
      v-else-if="help"
      :id="helpId"
      class="kit-field__help"
    >
      {{ help }}
    </p>
    <p
      v-if="hasCounter"
      :id="counterId"
      class="kit-field__counter"
      :class="{ 'is-full': count >= (counter ?? 0) }"
    >
      {{ count }} / {{ counter }}
    </p>
  </div>
</template>

<style>
.kit-field { display: flex; flex-direction: column; gap: 6px; width: 100%; box-sizing: border-box; min-width: 0; }
.kit-field__label { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--kit-text); }
.kit-field__label.is-visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.kit-field__label.is-required::after { content: "*"; margin-inline-start: 2px; color: var(--kit-danger); }
.kit-field__shell { position: relative; display: flex; align-items: center; width: 100%; }
.kit-field__shell > .kit-icon { position: absolute; left: 10px; color: var(--kit-text-subtle); pointer-events: none; }
.kit-field__shell > .kit-field__kbd { position: absolute; right: 6px; }
.kit-field__control {
  width: 100%; height: 32px; padding: 5px 10px; font-size: 13px; line-height: 20px; box-sizing: border-box;
  background-color: var(--kit-input-bg); color: var(--kit-text);
  border: 1px solid var(--kit-border-control); border-radius: 6px; outline: none; font-family: inherit;
  min-height: var(--kit-target-min, 0px);
  transition: border-color 120ms ease;
}
textarea.kit-field__control { height: auto; min-height: 64px; resize: none; }
textarea.kit-field__control.is-single-row { height: 32px; min-height: 32px; overflow: hidden; }
.kit-field__control.has-icon { padding-left: 32px; }
.kit-field__control.has-kbd { padding-right: 44px; }
.kit-field__control.is-mono { font-family: var(--kit-font-mono); font-feature-settings: var(--kit-font-mono-features); font-size: 12px; }
.kit-field__control.is-touch { height: 44px; font-size: 16px; }
.kit-field__control:focus { border-color: var(--kit-primary); box-shadow: 0 0 0 1px var(--kit-primary); }
.kit-field__control::placeholder { color: var(--kit-text-subtle); }
.kit-field__control[readonly] { background-color: var(--kit-bg-muted); }
.kit-field__control:disabled { cursor: not-allowed; color: var(--kit-text-subtle); background-color: var(--kit-bg-surface-elevated); }
.kit-field__control.is-invalid { border-color: var(--kit-danger); }
.kit-field__help { font-size: 12px; line-height: 18px; color: var(--kit-text-muted); margin: 0; }
.kit-field.has-counter { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; }
.kit-field.has-counter > * { grid-column: 1 / -1; }
.kit-field.has-counter > .kit-field__help, .kit-field.has-counter > .kit-field__error { grid-column: 1; }
.kit-field.has-counter > .kit-field__counter { grid-column: 2; }
.kit-field__counter { margin: 0; font-size: 12px; line-height: 18px; color: var(--kit-text-muted); font-feature-settings: var(--kit-font-mono-features); white-space: nowrap; }
.kit-field__counter.is-full { color: var(--kit-warning); }
.kit-field__error { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; line-height: 18px; color: var(--kit-danger); margin: 0; }
</style>
