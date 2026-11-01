<script setup lang="ts">
/**
 * The Kit table: a column grid for rows of cells. `columns` is the CSS grid template every TableRow
 * below it follows (such as `2fr 1fr 80px`), so cells line up without each row repeating it. The
 * default slot holds TableRow components, and each row's cells are whatever content the product puts
 * there. Cells are arbitrary content, not table cells, so the table is exposed as a list of rows and
 * `label` names it. `plain` drops the outer border, the corners and the fill, so only the hairlines between
 * rows remain (a table inside a card or a section that already frames it).
 */
defineProps<{
  /** The CSS `grid-template-columns` of every row. Default one column. */
  columns?: string
  /** The accessible name of the table. */
  label?: string
  /** A minimum width for every row (any CSS length). A narrower container scrolls the table sideways. */
  minWidth?: string
  /** Only hairlines between rows: no outer border, corners or fill. */
  plain?: boolean
}>()
</script>

<template>
  <div
    class="kit-table"
    :class="{ 'is-plain': plain }"
    role="list"
    :aria-label="label || undefined"
    :style="{ ...(columns ? { '--kit-table-columns': columns } : {}), ...(minWidth ? { '--kit-table-min-width': minWidth } : {}) }"
  >
    <slot />
  </div>
</template>

<style>
.kit-table.is-plain { border: 0; border-radius: 0; background-color: transparent; }
.kit-table.is-plain > .kit-table-row.is-header { background-color: transparent; }
.kit-table { display: flex; flex-direction: column; min-width: 0; box-sizing: border-box; border: 1px solid var(--kit-border); border-radius: 8px; overflow-x: auto; overflow-y: hidden; background-color: var(--kit-bg-surface); }
</style>
