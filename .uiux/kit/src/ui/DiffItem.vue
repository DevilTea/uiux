<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'

/**
 * The Kit diff item: one change in a semantic diff (DESIGN.md "Chips and badges" for the tones). The
 * `op` (`added`, `removed`, `changed`, `moved`) picks the icon and the tone, and `opLabel` is its
 * words, so color is never the only signal. `field` is the translated name of what changed and
 * `label` the changed thing itself, a mono identifier or path. `before` and `after` show a value
 * change, struck and inserted; `changes` lists finer changes under it, each `{ label, before, after }`
 * with an optional `opLabel` that assistive technology reads. Values and labels are content, so they
 * are literal text and never translated (`translate="no"`); `opLabel` and `field` arrive translated.
 */
const props = defineProps<{
  op: 'added' | 'removed' | 'changed' | 'moved'
  /** The operation in words, such as "Added". */
  opLabel?: string
  /** What kind of thing changed, translated, such as "Name". */
  field?: string
  /** The changed thing as written: an identifier or a path. */
  label?: string
  before?: string
  after?: string
  /** Finer changes under this one. */
  changes?: Array<{
    label?: string
    before?: string
    after?: string
    /** The change's operation in words, read by assistive technology. */
    opLabel?: string
  }>
}>()

const ICONS = { added: 'plus', removed: 'minus', changed: 'diff', moved: 'git-compare-arrows' } as const
const icon = computed(() => ICONS[props.op] ?? 'diff')
</script>

<template>
  <div
    class="kit-diff-item"
    :class="`kit-diff-item--${op}`"
    :data-op="op"
  >
    <p class="kit-diff-item__head">
      <Icon
        :name="icon"
        :size="14"
      />
      <span
        v-if="opLabel"
        class="kit-diff-item__op"
      >{{ opLabel }}</span>
      <span
        v-if="field"
        class="kit-diff-item__field"
      >{{ field }}</span>
      <code
        v-if="label"
        class="kit-diff-item__label"
        translate="no"
      >{{ label }}</code>
    </p>
    <p
      v-if="before !== undefined || after !== undefined"
      class="kit-diff-item__values"
      translate="no"
    >
      <del
        v-if="before !== undefined"
        class="kit-diff-item__before"
      >{{ before }}</del>
      <Icon
        v-if="before !== undefined && after !== undefined"
        name="arrow-right"
        :size="12"
      />
      <ins
        v-if="after !== undefined"
        class="kit-diff-item__after"
      >{{ after }}</ins>
    </p>
    <ul
      v-if="changes?.length"
      class="kit-diff-item__changes"
    >
      <li
        v-for="(change, index) in changes"
        :key="index"
      >
        <span
          v-if="change.opLabel"
          class="kit-diff-item__sr"
        >{{ change.opLabel }}</span>
        <code
          v-if="change.label"
          class="kit-diff-item__change-label"
          translate="no"
        >{{ change.label }}</code>
        <del
          v-if="change.before !== undefined"
          class="kit-diff-item__before"
          translate="no"
        >{{ change.before }}</del>
        <Icon
          v-if="change.before !== undefined && change.after !== undefined"
          name="arrow-right"
          :size="12"
        />
        <ins
          v-if="change.after !== undefined"
          class="kit-diff-item__after"
          translate="no"
        >{{ change.after }}</ins>
      </li>
    </ul>
  </div>
</template>

<style>
.kit-diff-item { box-sizing: border-box; min-width: 0; padding: 6px 8px; font-size: 12px; line-height: 18px; color: var(--kit-text); background-color: var(--kit-bg-surface); border: 1px solid var(--kit-border); border-left-width: 2px; border-left-color: var(--kit-diff-tone, var(--kit-border)); border-radius: 6px; }
.kit-diff-item--added { --kit-diff-tone: var(--kit-success); }
.kit-diff-item--removed { --kit-diff-tone: var(--kit-danger); }
.kit-diff-item--changed { --kit-diff-tone: var(--kit-warning); }
.kit-diff-item--moved { --kit-diff-tone: var(--kit-info); }
.kit-diff-item p { margin: 0; }
.kit-diff-item__head { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; min-width: 0; }
.kit-diff-item__head > .kit-icon { color: var(--kit-diff-tone, var(--kit-text-muted)); }
.kit-diff-item__op { flex-shrink: 0; font-weight: 500; color: var(--kit-diff-tone, var(--kit-text)); }
.kit-diff-item__field { flex-shrink: 0; color: var(--kit-text-muted); }
.kit-diff-item__label, .kit-diff-item__change-label { min-width: 0; font-family: var(--kit-font-mono); font-feature-settings: var(--kit-font-mono-features); overflow-wrap: anywhere; }
.kit-diff-item__label { color: var(--kit-text-highlighted); }
.kit-diff-item__change-label { color: var(--kit-text-muted); }
.kit-diff-item__values { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; min-width: 0; margin-top: 4px !important; }
.kit-diff-item__values > .kit-icon, .kit-diff-item__changes .kit-icon { align-self: center; color: var(--kit-text-muted); }
.kit-diff-item__before { min-width: 0; color: var(--kit-text-muted); overflow-wrap: anywhere; }
.kit-diff-item__after { min-width: 0; color: var(--kit-text-highlighted); text-decoration: none; overflow-wrap: anywhere; }
.kit-diff-item__changes { list-style: none; margin: 4px 0 0; padding: 0 0 0 8px; border-left: 1px solid var(--kit-border); display: flex; flex-direction: column; gap: 2px; }
.kit-diff-item__changes li { position: relative; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; min-width: 0; }
.kit-diff-item__sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
