<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { mapContourAffine, mapPointAffine, type AffineOuterMapping } from '../../../src/preview/outer-precision'
import type { Contour } from '../../../src/preview/protocol/schema'
import type { HoverCandidate, SelectionGeometry } from '../../composables/usePreviewSession'

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
	/** The runtime's hover candidate (Part 3): a transient, non-interactive outline beneath every other mark. */
	hover?: HoverCandidate
	hoverType?: string
	/** Inner content viewport (the logical View size), for clipping the label anchors. */
	viewport: Readonly<{ width: number; height: number }>
	/** The visible stage in overlay-layer px; chips flip or clamp to stay inside it. */
	bounds?: Readonly<{ left: number; top: number; right: number; bottom: number }>
}>()

const { t } = useI18n()

const CHIP_HEIGHT = 22
const CHIP_GAP = 4
/** Minimum distance between a chip and the stage edge. */
const CHIP_INSET = 4

// Chip widths are measured so a chip can flip or clamp inside the stage (a narrow phone stage
// would otherwise clip a label anchored near its right edge).
type ChipName = 'type' | 'size' | 'hover'
const chipWidths = reactive<Record<ChipName, number>>({ type: 0, size: 0, hover: 0 })
const typeChip = ref<HTMLElement>()
const sizeChip = ref<HTMLElement>()
const hoverChip = ref<HTMLElement>()
const chipNames = new WeakMap<Element, ChipName>()
const chipObserver = typeof ResizeObserver === 'undefined'
	? undefined
	: new ResizeObserver((entries) => {
		for (const entry of entries) {
			const name = chipNames.get(entry.target)
			if (name) chipWidths[name] = (entry.target as HTMLElement).offsetWidth
		}
	})
function observeChip(name: ChipName, element: HTMLElement | undefined, previous: HTMLElement | undefined): void {
	if (previous) chipObserver?.unobserve(previous)
	if (!element) return
	chipNames.set(element, name)
	chipWidths[name] = element.offsetWidth
	chipObserver?.observe(element)
}
watch(typeChip, (element, previous) => observeChip('type', element, previous), { flush: 'post' })
watch(sizeChip, (element, previous) => observeChip('size', element, previous), { flush: 'post' })
watch(hoverChip, (element, previous) => observeChip('hover', element, previous), { flush: 'post' })
onBeforeUnmount(() => chipObserver?.disconnect())

/** Keeps a chip of `width` starting at `left` inside the stage; with no stage, it is unchanged. */
function clampChip(left: number, width: number): number {
	const bounds = props.bounds
	if (!bounds) return left
	const min = bounds.left + CHIP_INSET
	const max = bounds.right - width - CHIP_INSET
	return max < min ? min : Math.min(Math.max(left, min), max)
}

/**
 * A start-aligned chip over a mark spanning `start`..`end`: left-aligned with the outline, flipped
 * to end-align with it when that would cross the stage's right edge, then clamped inside the stage.
 */
function placeStartChip(start: number, end: number, width: number): number {
	const bounds = props.bounds
	const aligned = start - 1
	if (!bounds || aligned + width <= bounds.right - CHIP_INSET) return clampChip(aligned, width)
	return clampChip(end + 1 - width, width)
}

/** The chip row above a mark, or just inside it when the stage top leaves no room. */
function chipTop(markTop: number): number {
	const floor = props.bounds?.top ?? 0
	return markTop - CHIP_HEIGHT - CHIP_GAP >= floor ? markTop - CHIP_HEIGHT - CHIP_GAP : markTop + CHIP_GAP
}

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

/**
 * Select tool: a 1px Iris/60 outline and a small mono type chip. Comment mode: a dashed Marker
 * outline and "Comment on {type}" (brief b §5, brief c §5). Nothing is drawn without a current
 * report of the candidate's own stream, and nothing when it has no reliably visible region.
 */
const hoverMark = computed(() => {
	const { mapping, hover } = props
	const geometry = hover?.geometry
	if (!mapping || !hover || !geometry || !geometry.regions.length) return undefined
	const left = Math.max(0, geometry.rect.x)
	const top = Math.max(0, geometry.rect.y)
	const right = Math.min(props.viewport.width, geometry.rect.x + geometry.rect.width)
	const topLeft = mapPointAffine({ x: left, y: top }, mapping)
	const topRight = mapPointAffine({ x: right, y: top }, mapping)
	const comment = hover.purpose === 'comment-range'
	const type = props.hoverType ?? ''
	return {
		comment,
		paths: geometry.regions.map(region => ({ id: region.regionId, d: pathOf(mapContourAffine(region.contour, mapping)) })),
		chip: {
			left: placeStartChip(topLeft.x, topRight.x, chipWidths.hover),
			top: chipTop(topLeft.y),
			text: comment ? t('comment.hoverChip', { type: type || `#${hover.widgetId}` }) : type || `#${hover.widgetId}`,
		},
	}
})

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
	// Both flip or clamp horizontally so neither is clipped at a stage edge.
	const typeTop = chipTop(topLeft.y)
	const sizeTop = bottomRight.y + CHIP_GAP
	const sizeWidth = chipWidths.size
	return {
		paths,
		type: { left: placeStartChip(topLeft.x, bottomRight.x, chipWidths.type), top: typeTop },
		size: { left: clampChip((topLeft.x + bottomRight.x) / 2 - sizeWidth / 2, sizeWidth), top: sizeTop },
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
    <template v-if="hoverMark">
      <svg
        class="absolute inset-0 size-full overflow-visible"
        data-overlay-hover
        :data-hover-purpose="hoverMark.comment ? 'comment-range' : 'inspection'"
      >
        <g fill="none">
          <path
            v-for="path in hoverMark.paths"
            :key="path.id"
            :d="path.d"
            :class="hoverMark.comment ? 'stroke-comment' : 'stroke-selection/60'"
            stroke-width="1"
            :stroke-dasharray="hoverMark.comment ? '4 3' : undefined"
            stroke-linejoin="round"
          />
        </g>
      </svg>
      <span
        ref="hoverChip"
        class="blueprint-chip"
        :class="hoverMark.comment ? 'text-annotation' : ''"
        data-hover-chip
        :style="{ left: `${hoverMark.chip.left}px`, top: `${hoverMark.chip.top}px` }"
      >{{ hoverMark.chip.text }}</span>
    </template>
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
        ref="typeChip"
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
        ref="sizeChip"
        class="blueprint-chip"
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
