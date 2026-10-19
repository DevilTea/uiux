export type ProvenOccluderShapeKind =
	| 'rectangle'
	| 'rounded-box'
	| 'clip-inset'
	| 'clip-circle'
	| 'clip-ellipse'
	| 'clip-polygon'
	| 'svg-clip-path'

export type ReliableShape<Shape> = Readonly<{
	kind: ProvenOccluderShapeKind
	shape: Shape
}>

/**
 * A finite over-approximation of everything an occluder can paint, used when its exact covering
 * shape is unproven (Discussion #241 R6). Cutting it removes at least the occluder's coverage, so
 * whatever survives is still proven visible.
 */
export type PaintBound<Shape> = Readonly<{
	kind: 'paint-bound'
	shape: Shape
}>

/** One area a precise plan removes from the Widget's visible region. */
export type OcclusionCut<Shape> = ReliableShape<Shape> | PaintBound<Shape>

export type OcclusionEvidence<Shape> =
	| Readonly<{
		classification: 'opaque'
		targetContribution: 'proven-zero'
		shape: ReliableShape<Shape>
	}>
	| Readonly<{
		classification: 'opaque'
		targetContribution: 'proven-zero'
		shape: undefined
	}>
	| Readonly<{
		classification: 'translucent'
		targetContribution: 'proven-nonzero'
	}>
	| Readonly<{
		/** The exact covering shape or paint order is unproven, but the paint has a finite bound. */
		classification: 'bounded'
		targetContribution: 'unproven'
		bound: PaintBound<Shape>
	}>
	| Readonly<{
		classification: 'unsupported'
		reason:
			| 'blend-mode'
			| 'filter'
			| 'backdrop-filter'
			| 'complex-mask'
			| 'unreliable-visible-shape'
			| 'unknown-compositing'
			| 'unbounded-paint'
	}>

export type OcclusionPlan<Shape> =
	| Readonly<{
		status: 'precise'
		subtract: readonly OcclusionCut<Shape>[]
		translucentObstruction: boolean
	}>
	| Readonly<{
		status: 'structural-only'
		reason: 'opaque-shape-unavailable' | 'unsupported-compositing'
	}>

/**
 * Converts runtime rendering evidence into the only occlusion operations that are allowed to
 * affect precise Widget contours. No visual-opacity threshold or guessed compositing
 * classification is accepted here. A bounding box is accepted only as a `bounded` occluder's
 * finite paint bound, an over-approximation that cuts at least what the occluder covers
 * (Discussion #241 R6); evidence without a finite bound stays `unsupported` and fails the plan.
 */
export function planOcclusion<Shape>(evidence: readonly OcclusionEvidence<Shape>[]): OcclusionPlan<Shape> {
	const subtract: OcclusionCut<Shape>[] = []
	let translucentObstruction = false

	for (const item of evidence) {
		if (item.classification === 'unsupported')
			return { status: 'structural-only', reason: 'unsupported-compositing' }

		if (item.classification === 'translucent') {
			translucentObstruction = true
			continue
		}

		if (item.classification === 'bounded') {
			subtract.push(cloneCut(item.bound))
			continue
		}

		if (item.shape === undefined)
			return { status: 'structural-only', reason: 'opaque-shape-unavailable' }
		subtract.push(cloneCut(item.shape))
	}

	return Object.freeze({
		status: 'precise' as const,
		subtract: Object.freeze(subtract),
		translucentObstruction,
	})
}

function cloneCut<Shape>(cut: OcclusionCut<Shape>): OcclusionCut<Shape> {
	return Object.freeze({ kind: cut.kind, shape: cloneUnknown(cut.shape) }) as OcclusionCut<Shape>
}

function cloneUnknown<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value
	if (Array.isArray(value)) return value.map(item => cloneUnknown(item)) as T
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneUnknown(item)])) as T
}
