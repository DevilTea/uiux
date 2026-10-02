import type { Contour, ContourCommand, Point, VisibleRegion } from './protocol/schema'

export const DEFAULT_FINAL_CONTOUR_TOLERANCE_CSS_PX = 0.5

/** CSS 2D matrix convention: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type AffineOuterMapping = Readonly<{
	kind: 'affine'
	a: number
	b: number
	c: number
	d: number
	e: number
	f: number
}>

/**
 * A non-affine mapping is precision-eligible only when another Workbench proof supplies
 * a conservative whole-contour amplification upper bound. No new iframe wire data is implied.
 */
export type NonAffineOuterMapping = Readonly<{
	kind: 'non-affine'
	amplificationUpperBound?: number
}>

export type OuterErrorMapping = AffineOuterMapping | NonAffineOuterMapping

export type PrecisionEvaluation =
	| Readonly<{ status: 'eligible'; finalMaxError: number }>
	| Readonly<{ status: 'refinement-required'; finalMaxError: number; targetInnerMaxError: number }>
	| Readonly<{ status: 'precision-unavailable'; reason: 'invalid-mapping' | 'unproven-non-affine' }>

export type SnapshotPrecisionEvaluation =
	| Readonly<{ status: 'empty' }>
	| Readonly<{ status: 'eligible'; maxFinalError: number }>
	| Readonly<{ status: 'refinement-required'; maxFinalError: number; targetInnerMaxError: number; regionIds: readonly string[] }>
	| Readonly<{ status: 'precision-unavailable'; reason: 'invalid-mapping' | 'unproven-non-affine' }>

export type MappedVisibleRegion = Readonly<{
	regionId: string
	contour: Contour
	innerMaxError: number
	finalMaxErrorUpperBound: number
}>

export function affineAmplificationUpperBound(mapping: AffineOuterMapping): number | undefined {
	if (![mapping.a, mapping.b, mapping.c, mapping.d, mapping.e, mapping.f].every(Number.isFinite)) return undefined
	const scale = Math.max(Math.abs(mapping.a), Math.abs(mapping.b), Math.abs(mapping.c), Math.abs(mapping.d))
	if (scale === 0) return 0

	// Scale first so the exact 2x2 spectral-norm identity does not overflow or underflow
	// merely because finite matrix entries are very large or small.
	const a = mapping.a / scale
	const b = mapping.b / scale
	const c = mapping.c / scale
	const d = mapping.d / scale
	const first = Math.hypot(a + d, b - c)
	const second = Math.hypot(a - d, b + c)
	const normalizedUpper = inflateUp((first + second) / 2)
	const raw = scale * normalizedUpper
	if (!Number.isFinite(raw)) return undefined
	return inflateUp(raw)
}

export function evaluateRegionPrecision(
	innerMaxError: number,
	mapping: OuterErrorMapping,
	finalTolerance = DEFAULT_FINAL_CONTOUR_TOLERANCE_CSS_PX,
): PrecisionEvaluation {
	if (!Number.isFinite(innerMaxError) || innerMaxError < 0
		|| !Number.isFinite(finalTolerance) || finalTolerance <= 0
		|| finalTolerance > DEFAULT_FINAL_CONTOUR_TOLERANCE_CSS_PX)
		return { status: 'precision-unavailable', reason: 'invalid-mapping' }
	const amplification = resolveAmplification(mapping)
	if (amplification.status === 'unavailable') return amplification.result
	const finalMaxError = conservativeProduct(amplification.value, innerMaxError)
	if (finalMaxError <= finalTolerance) return { status: 'eligible', finalMaxError }
	if (amplification.value === 0) return { status: 'eligible', finalMaxError: 0 }
	const rawTarget = finalTolerance / amplification.value
	const targetInnerMaxError = nextDown(rawTarget)
	if (!(targetInnerMaxError > 0) || !Number.isFinite(targetInnerMaxError))
		return { status: 'precision-unavailable', reason: 'invalid-mapping' }
	return { status: 'refinement-required', finalMaxError, targetInnerMaxError }
}

export function evaluateSnapshotPrecision(
	regions: readonly VisibleRegion[],
	mapping: OuterErrorMapping,
	finalTolerance = DEFAULT_FINAL_CONTOUR_TOLERANCE_CSS_PX,
): SnapshotPrecisionEvaluation {
	if (regions.length === 0) return { status: 'empty' }
	let maxFinalError = 0
	let targetInnerMaxError = Number.POSITIVE_INFINITY
	const regionIds: string[] = []
	for (const region of regions) {
		const result = evaluateRegionPrecision(region.maxError, mapping, finalTolerance)
		if (result.status === 'precision-unavailable') return result
		maxFinalError = Math.max(maxFinalError, result.finalMaxError)
		if (result.status === 'refinement-required') {
			regionIds.push(region.regionId)
			targetInnerMaxError = Math.min(targetInnerMaxError, result.targetInnerMaxError)
		}
	}
	if (regionIds.length === 0) return { status: 'eligible', maxFinalError }
	return Object.freeze({
		status: 'refinement-required' as const,
		maxFinalError,
		targetInnerMaxError,
		regionIds: Object.freeze(regionIds),
	})
}

export function mapPointAffine(point: Point, mapping: AffineOuterMapping): Point {
	return {
		x: mapping.a * point.x + mapping.c * point.y + mapping.e,
		y: mapping.b * point.x + mapping.d * point.y + mapping.f,
	}
}

export function mapContourAffine(contour: Contour, mapping: AffineOuterMapping): Contour {
	return Object.freeze({ commands: Object.freeze(contour.commands.map(command => mapCommand(command, mapping))) })
}

export function mapVisibleRegionAffine(region: VisibleRegion, mapping: AffineOuterMapping): MappedVisibleRegion | undefined {
	if (!Number.isFinite(region.maxError) || region.maxError < 0) return undefined
	const amplification = affineAmplificationUpperBound(mapping)
	if (amplification === undefined) return undefined
	const contour = mapContourAffine(region.contour, mapping)
	if (!contourCoordinatesAreFinite(contour)) return undefined
	return Object.freeze({
		regionId: region.regionId,
		contour,
		innerMaxError: region.maxError,
		finalMaxErrorUpperBound: conservativeProduct(amplification, region.maxError),
	})
}

function contourCoordinatesAreFinite(contour: Contour): boolean {
	return contour.commands.every(command => {
		if (command.op === 'close') return true
		if (command.op === 'cubicBezierTo')
			return [command.c1x, command.c1y, command.c2x, command.c2y, command.x, command.y].every(Number.isFinite)
		return Number.isFinite(command.x) && Number.isFinite(command.y)
	})
}

function resolveAmplification(mapping: OuterErrorMapping):
	| Readonly<{ status: 'available'; value: number }>
	| Readonly<{ status: 'unavailable'; result: Extract<PrecisionEvaluation, { status: 'precision-unavailable' }> }> {
	if (mapping.kind === 'affine') {
		const amplification = affineAmplificationUpperBound(mapping)
		return amplification === undefined
			? { status: 'unavailable', result: { status: 'precision-unavailable', reason: 'invalid-mapping' } }
			: { status: 'available', value: amplification }
	}
	if (mapping.amplificationUpperBound === undefined)
		return { status: 'unavailable', result: { status: 'precision-unavailable', reason: 'unproven-non-affine' } }
	if (!Number.isFinite(mapping.amplificationUpperBound) || mapping.amplificationUpperBound < 0)
		return { status: 'unavailable', result: { status: 'precision-unavailable', reason: 'invalid-mapping' } }
	return { status: 'available', value: inflateUp(mapping.amplificationUpperBound) }
}

function mapCommand(command: ContourCommand, mapping: AffineOuterMapping): ContourCommand {
	if (command.op === 'close') return Object.freeze({ op: 'close' })
	if (command.op === 'cubicBezierTo') {
		const c1 = mapPointAffine({ x: command.c1x, y: command.c1y }, mapping)
		const c2 = mapPointAffine({ x: command.c2x, y: command.c2y }, mapping)
		const end = mapPointAffine({ x: command.x, y: command.y }, mapping)
		return Object.freeze({ op: 'cubicBezierTo', c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y, x: end.x, y: end.y })
	}
	const point = mapPointAffine({ x: command.x, y: command.y }, mapping)
	return Object.freeze({ op: command.op, x: point.x, y: point.y })
}

function conservativeProduct(left: number, right: number): number {
	if (left === 0 || right === 0) return 0
	const product = left * right
	if (!Number.isFinite(product)) return Number.POSITIVE_INFINITY
	return inflateUp(product)
}

/** Small outward inflation protects against round-to-nearest in the closed-form 2x2 norm calculation. */
function inflateUp(value: number): number {
	if (!(value >= 0) || !Number.isFinite(value)) return value
	let result = value
	for (let index = 0; index < 16; index++) result = nextUp(result)
	return result
}

function nextUp(value: number): number {
	if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) return value
	if (value === 0) return Number.MIN_VALUE
	const buffer = new ArrayBuffer(8)
	const view = new DataView(buffer)
	view.setFloat64(0, value, false)
	let bits = view.getBigUint64(0, false)
	bits = value > 0 ? bits + 1n : bits - 1n
	view.setBigUint64(0, bits, false)
	return view.getFloat64(0, false)
}

function nextDown(value: number): number {
	if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return value
	if (value === 0) return -Number.MIN_VALUE
	const buffer = new ArrayBuffer(8)
	const view = new DataView(buffer)
	view.setFloat64(0, value, false)
	let bits = view.getBigUint64(0, false)
	bits = value > 0 ? bits - 1n : bits + 1n
	view.setBigUint64(0, bits, false)
	return view.getFloat64(0, false)
}
