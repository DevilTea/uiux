<script setup lang="ts">
/**
 * One row of a Kit table. Its children are the cells, laid out on the grid the table's `columns` set.
 * `header` styles the row as the column headings; `selected` marks the current row (a primary tint
 * and a 2px bar, and `aria-current`). It is controlled and has no state. A row outside a table takes
 * one equal column per cell.
 */
defineProps<{
  header?: boolean
  selected?: boolean
}>()
</script>

<template>
  <div
    class="kit-table-row"
    :class="{ 'is-header': header, 'is-selected': selected }"
    role="listitem"
    :aria-current="selected ? 'true' : undefined"
  >
    <slot />
  </div>
</template>

<style>
.kit-table-row {
  position: relative; display: grid; grid-template-columns: var(--kit-table-columns, repeat(auto-fit, minmax(0, 1fr))); align-items: center; column-gap: 12px;
  min-width: 0; padding: 6px 12px; box-sizing: border-box; font-size: 13px; line-height: 20px; color: var(--kit-text); border-bottom: 1px solid var(--kit-border-subtle);
}
.kit-table-row:last-child { border-bottom: 0; }
.kit-table-row > * { min-width: 0; }
.kit-table-row.is-header { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--kit-text-muted); background-color: var(--kit-bg-muted); border-bottom-color: var(--kit-border); }
.kit-table-row.is-selected { background-color: var(--kit-primary-subtle); color: var(--kit-text-highlighted); }
.kit-table-row.is-selected::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background-color: var(--kit-primary); }
</style>
