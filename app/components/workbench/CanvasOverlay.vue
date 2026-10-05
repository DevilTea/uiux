<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { mapContourAffine, mapPointAffine, type AffineOuterMapping } from '../../../src/preview/outer-precision'
import type { Contour } from '../../../src/preview/protocol/schema'
import type { SelectionGeometry } from '../../composables/usePreviewSession'

/**
 * The Workbench overlay above the preview iframe (brief b, DESIGN.md "Blueprint selection label").
 *
 * It only draws: the layer is `pointer-events: none` throughout, so every pointer event over the
 * frame still reaches the iframe, which owns hit-testing (Discussions #1–#3). Marks come from
 * runtime-reported geometry mapped through the measured outer mapping; with no mapping or no
 * current report nothing is drawn.
 */
const props = defineProps<{
	mapping?: AffineOuterMapping
	geometry?: SelectionGeometry
	widgetType?: string
	/** Inner content viewport (the logical View size), for clipping the label anchors. */
	viewport: Readonly<{ width: number; height: number }>
}>()

const { t } = useI18n()

const CHIP_HEIGHT = 22
const CHIP_GAP = 4

function pathOf(contour: Contour): string {
	return contour.commands.map((command) => {
		switch (command.op) {
			case 'moveTo': return `M${command.x} ${command.y}`
			case 'lineTo': return `L${command.x} ${command.y}`
			case 'cubicBezierTo': return `C${command.c1x} ${command.c1y} ${command.c2x} ${command.c2y} ${command.x} ${command.y}`
			default: return 'Z'
		}
	}).join('')
}

const selection = computed(() => {
	const { mapping, geometry } = props
	// The RootShell is the frame itself; its edge already marks it.
	if (!mapping || !geometry || geometry.widgetId === 'root') return undefined
	const paths = geometry.regions.map(region => ({ id: region.regionId, d: pathOf(mapContourAffine(region.contour, mapping)) }))
	// Label anchors use the part of the Widget rectangle inside the content viewport.
	const left = Math.max(0, geometry.rect.x)
	const top = Math.max(0, geometry.rect.y)
	const right = Math.min(props.viewport.width, geometry.rect.x + geometry.rect.width)
	const bottom = Math.min(props.viewport.height, geometry.rect.y + geometry.rect.height)
	const topLeft = mapPointAffine({ x: left, y: top }, mapping)
	const bottomRight = mapPointAffine({ x: right, y: bottom }, mapping)
	// The type chip sits above the outline (over the gutter if need be), or just inside it at the
	// very top of the stage. The dimension chip sits below; the stage always keeps room under the frame.
	const typeTop = topLeft.y - CHIP_HEIGHT - CHIP_GAP >= 0 ? topLeft.y - CHIP_HEIGHT - CHIP_GAP : topLeft.y + CHIP_GAP
	const sizeTop = bottomRight.y + CHIP_GAP
	return {
		paths,
		type: { left: topLeft.x - 1, top: typeTop },
		size: { left: (topLeft.x + bottomRight.x) / 2, top: sizeTop },
		dimensions: t('canvas.dimensions', { width: Math.round(geometry.rect.width), height: Math.round(geometry.rect.height) }),
	}
})
</script>

<template>
  <div
    class="pointer-events-none absolute inset-0"
    data-canvas-overlay
    aria-hidden="true"
  >
    <template v-if="selection">
      <svg
        class="absolute inset-0 size-full overflow-visible"
        data-overlay-selection
      >
        <g fill="none">
          <path
            v-for="path in selection.paths"
            :key="`halo-${path.id}`"
            :d="path.d"
            class="stroke-(--ui-bg)"
            stroke-width="3.5"
            stroke-linejoin="round"
          />
          <path
            v-for="path in selection.paths"
            :key="path.id"
            :d="path.d"
            class="stroke-selection"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
        </g>
      </svg>
      <span
        class="blueprint-chip"
        data-blueprint="type"
        :style="{ left: `${selection.type.left}px`, top: `${selection.type.top}px` }"
      >
        <span
          v-if="widgetType"
          class="text-muted"
        >{{ widgetType }} · </span>#{{ geometry!.widgetId }}
      </span>
      <span
        class="blueprint-chip -translate-x-1/2"
        data-blueprint="size"
        :style="{ left: `${selection.size.left}px`, top: `${selection.size.top}px` }"
      >{{ selection.dimensions }}</span>
    </template>
  </div>
</template>

<style scoped>
/* DESIGN.md "Blueprint Label Rule": 12px mono identity and measurement chips on the panel color. */
.blueprint-chip {
  position: absolute;
  white-space: nowrap;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-bg);
  color: var(--ui-text);
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1rem;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "zero" 1;
}
</style>
