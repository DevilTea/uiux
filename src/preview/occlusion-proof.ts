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
		classification: 'unsupported'
		reason:
			| 'blend-mode'
			| 'filter'
			| 'backdrop-filter'
			| 'complex-mask'
			| 'unreliable-visible-shape'
			| 'unknown-compositing'
	}>

export type OcclusionPlan<Shape> =
	| Readonly<{
		status: 'precise'
		subtract: readonly ReliableShape<Shape>[]
		translucentObstruction: boolean
	}>
	| Readonly<{
		status: 'structural-only'
		reason: 'opaque-shape-unavailable' | 'unsupported-compositing'
	}>

/**
 * Converts runtime rendering evidence into the only occlusion operations that are allowed to
 * affect precise Widget contours. No visual-opacity threshold, bbox approximation, or guessed
 * compositing classification is accepted here.
 */
export function planOcclusion<Shape>(evidence: readonly OcclusionEvidence<Shape>[]): OcclusionPlan<Shape> {
	const subtract: ReliableShape<Shape>[] = []
	let translucentObstruction = false

	for (const item of evidence) {
		if (item.classification === 'unsupported')
			return { status: 'structural-only', reason: 'unsupported-compositing' }

		if (item.classification === 'translucent') {
			translucentObstruction = true
			continue
		}

		if (item.shape === undefined)
			return { status: 'structural-only', reason: 'opaque-shape-unavailable' }
		subtract.push(cloneReliableShape(item.shape))
	}

	return Object.freeze({
		status: 'precise' as const,
		subtract: Object.freeze(subtract),
		translucentObstruction,
	})
}

function cloneReliableShape<Shape>(shape: ReliableShape<Shape>): ReliableShape<Shape> {
	return Object.freeze({ kind: shape.kind, shape: cloneUnknown(shape.shape) })
}

function cloneUnknown<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value
	if (Array.isArray(value)) return value.map(item => cloneUnknown(item)) as T
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneUnknown(item)])) as T
}
