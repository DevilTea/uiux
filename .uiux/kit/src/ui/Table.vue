<script setup lang="ts">
/**
 * The Kit table: a column grid for rows of cells. `columns` is the CSS grid template every TableRow
 * below it follows (such as `2fr 1fr 80px`), so cells line up without each row repeating it. The
 * default slot holds TableRow components, and each row's cells are whatever content the product puts
 * there. Cells are arbitrary content, not table cells, so the table is exposed as a list of rows and
 * `label` names it.
 */
defineProps<{
  /** The CSS `grid-template-columns` of every row. Default one column. */
  columns?: string
  /** The accessible name of the table. */
  label?: string
}>()
</script>

<template>
  <div
    class="kit-table"
    role="list"
    :aria-label="label || undefined"
    :style="columns ? { '--kit-table-columns': columns } : undefined"
  >
    <slot />
  </div>
</template>

<style>
.kit-table { display: flex; flex-direction: column; min-width: 0; box-sizing: border-box; border: 1px solid var(--kit-border); border-radius: 8px; overflow: hidden; background-color: var(--kit-bg-surface); }
</style>
