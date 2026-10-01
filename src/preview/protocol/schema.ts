import {
	jsonPointer,
	validateUuid,
	Validator,
	type JsonObject,
	type ValidationResult,
} from '../../domain/validation'

export type ProtocolFailureCategory = 'transport' | 'protocol' | 'runtime' | 'capability'
export type ProtocolContext = Readonly<{
	previewSessionId: string
	runtimeGenerationId: string
	viewId: string
	variantId?: string
	runtimeContextVersion?: number
	navigationRequestId?: string
	widgetId: string
	geometryRevision?: number
	[key: string]: unknown
}>
type GeometryRevisionContext = ProtocolContext & Readonly<{ geometryRevision: number }>
type GeometryAcquireContext = Omit<ProtocolContext, 'geometryRevision'> & Readonly<{ geometryRevision?: never }>
export type ProtocolEnvelope<
	Payload extends JsonObject = JsonObject,
	Context extends ProtocolContext = ProtocolContext,
> = Readonly<{
	type: string
	context: Context
	payload: Payload
}>

export type Point = Readonly<{ x: number; y: number }>
export type ContourCommand =
	| Readonly<{ op: 'moveTo'; x: number; y: number }>
	| Readonly<{ op: 'lineTo'; x: number; y: number }>
	| Readonly<{ op: 'cubicBezierTo'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }>
	| Readonly<{ op: 'close' }>
export type Contour = Readonly<{ commands: readonly ContourCommand[] }>
export type VisibleRegion = Readonly<{ regionId: string; contour: Contour; maxError: number }>
type PathSegment =
	| Readonly<{ kind: 'line'; from: Point; to: Point }>
	| Readonly<{ kind: 'cubic'; from: Point; c1: Point; c2: Point; to: Point }>

export type GeometryAcquireRequest = ProtocolEnvelope<Record<string, never>, GeometryAcquireContext> & Readonly<{ type: 'geometry.acquire.request' }>
export type GeometryAcquireResponse = ProtocolEnvelope<{ regions: readonly VisibleRegion[] }, GeometryRevisionContext> & Readonly<{ type: 'geometry.acquire.response' }>
export type FullContourRequest = ProtocolEnvelope<{ sequence: number; targetMaxError: number }, GeometryRevisionContext> & Readonly<{ type: 'contour.full.request' }>
export type FullContourResponse = ProtocolEnvelope<{ sequence: number; regions: readonly VisibleRegion[] }, GeometryRevisionContext> & Readonly<{ type: 'contour.full.response' }>
export type PartialContourRequest = ProtocolEnvelope<{ sequence: number; baseSnapshotVersion: number; regionIds: readonly string[]; targetMaxError: number }, GeometryRevisionContext> & Readonly<{ type: 'contour.partial.request' }>
export type PartialContourResponse = ProtocolEnvelope<{ sequence: number; baseSnapshotVersion: number; regions: readonly VisibleRegion[] }, GeometryRevisionContext> & Readonly<{ type: 'contour.partial.response' }>
export type ContourCancel = ProtocolEnvelope<{ sequence: number }, GeometryRevisionContext> & Readonly<{ type: 'contour.cancel' }>
export type GeometryMessage = GeometryAcquireRequest | GeometryAcquireResponse | FullContourRequest | FullContourResponse | PartialContourRequest | PartialContourResponse | ContourCancel

export type FailureReasonCode = string
export type PreviewFailureDiagnostic = Readonly<{
	category: ProtocolFailureCategory
	reason: FailureReasonCode
	detail?: string
	correlation?: Readonly<Record<string, string | number>>
}>

const KNOWN_CONTEXT_KEYS = new Set([
	'previewSessionId', 'runtimeGenerationId', 'viewId', 'variantId',
	'runtimeContextVersion', 'navigationRequestId', 'widgetId', 'geometryRevision',
])
const REQUIRED_BASE_CONTEXT = ['previewSessionId', 'runtimeGenerationId', 'viewId', 'widgetId'] as const
const PAYLOAD_ONLY_IDENTITIES = new Set(['sequence', 'baseSnapshotVersion', 'snapshotVersion', 'regionId', 'regionIds', 'regions'])
const FAILURE_CATEGORIES = new Set<ProtocolFailureCategory>(['transport', 'protocol', 'runtime', 'capability'])
const INITIAL_REASON_CODES = new Set([
	'transport.channel_unavailable',
	'runtime.unavailable',
	'protocol.invalid_message',
	'protocol.invalid_state',
	'protocol.identity_reuse',
	'protocol.capability_conflict',
	'capability.unsupported_protocol_version',
	'capability.missing_required_feature',
])

export function validateGeometryMessage(input: unknown): ValidationResult<GeometryMessage> {
	const v = new Validator()
	const envelope = v.object(input, '')
	if (!envelope) return v.finish<GeometryMessage>(input)
	const type = v.string(envelope.type, '/type', true)
	validateGeometryContext(envelope.context, '/context', v, type === 'geometry.acquire.request' ? 'forbidden' : 'required')
	const payload = v.object(envelope.payload, '/payload')
	if (!payload || !type) return v.finish<GeometryMessage>(input)

	switch (type) {
		case 'geometry.acquire.request':
			break
		case 'geometry.acquire.response':
			forbidRuntimeSnapshotVersion(payload, '/payload', v)
			validateRegions(payload.regions, '/payload/regions', v, true)
			break
		case 'contour.full.request':
			validateSequence(payload.sequence, '/payload/sequence', v)
			validateTargetError(payload.targetMaxError, '/payload/targetMaxError', v)
			break
		case 'contour.full.response':
			validateSequence(payload.sequence, '/payload/sequence', v)
			forbidRuntimeSnapshotVersion(payload, '/payload', v)
			validateRegions(payload.regions, '/payload/regions', v, true)
			break
		case 'contour.partial.request':
			validateSequence(payload.sequence, '/payload/sequence', v)
			validateSequence(payload.baseSnapshotVersion, '/payload/baseSnapshotVersion', v)
			validateRegionIds(payload.regionIds, '/payload/regionIds', v, true)
			validateTargetError(payload.targetMaxError, '/payload/targetMaxError', v)
			break
		case 'contour.partial.response':
			validateSequence(payload.sequence, '/payload/sequence', v)
			validateSequence(payload.baseSnapshotVersion, '/payload/baseSnapshotVersion', v)
			validateRegions(payload.regions, '/payload/regions', v, false)
			forbidRuntimeSnapshotVersion(payload, '/payload', v)
			break
		case 'contour.cancel':
			validateSequence(payload.sequence, '/payload/sequence', v)
			break
		default:
			v.issue('protocol.unknown_message_type', '/type', 'This decoder accepts only fully specified geometry and contour message types.')
	}
	return v.finish<GeometryMessage>(input)
}

function validateGeometryContext(
	input: unknown,
	path: string,
	v: Validator,
	geometryRevision: 'required' | 'forbidden',
): void {
	const context = v.object(input, path)
	if (!context) return
	for (const key of REQUIRED_BASE_CONTEXT) {
		if (!Object.hasOwn(context, key))
			v.issue('protocol.missing_context_identity', `${path}/${key}`, `Geometry messages require context.${key}.`)
	}
	if (geometryRevision === 'required' && !Object.hasOwn(context, 'geometryRevision'))
		v.issue('protocol.missing_context_identity', `${path}/geometryRevision`,
			'This geometry/contour message requires context.geometryRevision.')
	if (geometryRevision === 'forbidden' && Object.hasOwn(context, 'geometryRevision'))
		v.issue('protocol.inapplicable_geometry_revision', `${path}/geometryRevision`,
			'Geometry acquisition requests ask for the current baseline and do not predeclare geometryRevision.')
	for (const key of ['previewSessionId', 'runtimeGenerationId', 'viewId', 'variantId', 'navigationRequestId', 'widgetId'] as const) {
		if (Object.hasOwn(context, key)) v.string(context[key], `${path}/${key}`, true)
	}
	if (Object.hasOwn(context, 'viewId')) validateUuid(context.viewId, `${path}/viewId`, v, 'View identity')
	for (const key of ['runtimeContextVersion', 'geometryRevision'] as const) {
		if (Object.hasOwn(context, key)) validateSequence(context[key], `${path}/${key}`, v)
	}
	// Future correlation identities are additive; null is never an absent-value encoding.
	for (const [key, value] of Object.entries(context)) {
		if (PAYLOAD_ONLY_IDENTITIES.has(key))
			v.issue('protocol.identity_in_wrong_envelope', `${path}/${key}`, `${key} belongs in a message payload or is Workbench-local, not in shared context.`)
		if (!KNOWN_CONTEXT_KEYS.has(key) && value === null)
			v.issue('protocol.null_optional_field', `${path}/${key}`, 'Optional protocol fields are omitted instead of encoded as null.')
	}
}

function validateRegions(value: unknown, path: string, v: Validator, requireUniqueIds: boolean): void {
	const regions = v.array(value, path)
	if (!regions) return
	const ids = new Set<string>()
	regions.forEach((regionValue, index) => {
		const regionPath = jsonPointer(path, index)
		const region = v.object(regionValue, regionPath)
		if (!region) return
		const id = v.string(region.regionId, `${regionPath}/regionId`, true)
		if (id !== undefined && ids.has(id))
			v.issue('protocol.duplicate_region_id', `${regionPath}/regionId`, 'A complete region set contains each regionId at most once.')
		if (id !== undefined) ids.add(id)
		const maxError = v.finiteNumber(region.maxError, `${regionPath}/maxError`)
		if (maxError !== undefined && maxError < 0)
			v.issue('protocol.invalid_max_error', `${regionPath}/maxError`, 'maxError must be greater than or equal to zero.')
		validateContour(region.contour, `${regionPath}/contour`, v)
	})
	void requireUniqueIds // Both complete and partial arrays reject duplicate IDs.
}

function validateContour(input: unknown, path: string, v: Validator): void {
	const contour = v.object(input, path)
	if (!contour) return
	const commands = v.array(contour.commands, `${path}/commands`)
	if (!commands) return
	if (commands.length < 3) {
		v.issue('protocol.invalid_contour_commands', `${path}/commands`, 'Contour requires a moveTo, at least one segment, and a final close.')
		return
	}
	let start: Point | undefined
	let current: Point | undefined
	let closeCount = 0
	const segments: PathSegment[] = []
	commands.forEach((commandValue, index) => {
		const commandPath = jsonPointer(`${path}/commands`, index)
		const command = v.object(commandValue, commandPath)
		if (!command) return
		if (index === 0 && command.op !== 'moveTo')
			v.issue('protocol.contour_must_start_move_to', `${commandPath}/op`, 'A contour begins with exactly one moveTo.')
		if (command.op === 'moveTo') {
			if (index !== 0) v.issue('protocol.contour_subpath_forbidden', `${commandPath}/op`, 'A contour cannot contain another moveTo or subpath.')
			const point = readPoint(command, commandPath, v)
			if (point) { start = point; current = point }
		}
		else if (command.op === 'lineTo') {
			const point = readPoint(command, commandPath, v)
			if (point && current) {
				if (point.x === current.x && point.y === current.y)
					v.issue('protocol.zero_length_line', commandPath, 'lineTo cannot have zero length.')
				segments.push({ kind: 'line', from: current, to: point })
				current = point
			}
		}
		else if (command.op === 'cubicBezierTo') {
			const c1 = readPoint(command, commandPath, v, 'c1')
			const c2 = readPoint(command, commandPath, v, 'c2')
			const end = readPoint(command, commandPath, v)
			if (current && c1 && c2 && end) {
				if (samePoint(current, c1) && samePoint(current, c2) && samePoint(current, end))
					v.issue('protocol.degenerate_cubic', commandPath, 'A cubic Bezier whose start, controls, and end all coincide is degenerate.')
				const segment = { kind: 'cubic' as const, from: current, c1, c2, to: end }
				segments.push(segment)
				current = end
			}
		}
		else if (command.op === 'close') {
			closeCount++
			if (index !== commands.length - 1)
				v.issue('protocol.close_must_be_final', `${commandPath}/op`, 'close is the unique final contour command.')
			if (Object.hasOwn(command, 'x') || Object.hasOwn(command, 'y'))
				v.issue('protocol.close_has_no_coordinates', commandPath, 'close implicitly connects the current point to the starting point.')
			if (start && current)
				segments.push({ kind: 'line', from: current, to: start })
		}
		else {
			v.issue('protocol.unknown_contour_command', `${commandPath}/op`, 'Contour command op must be moveTo, lineTo, cubicBezierTo, or close.')
		}
	})
	if (commands[commands.length - 1] && isRecord(commands[commands.length - 1]) && (commands[commands.length - 1] as Record<string, unknown>).op !== 'close')
		v.issue('protocol.missing_final_close', `${path}/commands`, 'Contour must end with close.')
	if (closeCount !== 1)
		v.issue('protocol.invalid_close_count', `${path}/commands`, 'Contour contains exactly one close command.')
	if (!commands.slice(1, -1).some(command => isRecord(command) && (command.op === 'lineTo' || command.op === 'cubicBezierTo')))
		v.issue('protocol.missing_contour_segment', `${path}/commands`, 'Contour requires at least one lineTo or cubicBezierTo before close.')
	if (start && current) {
		if (segments.length > 0 && signedAreaIsZero(segments))
			v.issue('protocol.zero_area_contour', path, 'Contour must enclose non-zero area.')
		if (hasPathSelfIntersection(segments))
			v.issue('protocol.self_intersecting_contour', path, 'Contour must be a simple, non-self-intersecting outer boundary.')
	}
}

function readPoint(value: Record<string, unknown>, path: string, v: Validator, prefix = ''): Point | undefined {
	const xKey = prefix ? `${prefix}x` : 'x'
	const yKey = prefix ? `${prefix}y` : 'y'
	const x = v.finiteNumber(value[xKey], `${path}/${xKey}`)
	const y = v.finiteNumber(value[yKey], `${path}/${yKey}`)
	return x === undefined || y === undefined ? undefined : { x, y }
}

function validateSequence(value: unknown, path: string, v: Validator): void {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		v.issue('protocol.invalid_sequence', path, 'Protocol sequence and revision values are non-negative JSON safe integers.')
}

function validateTargetError(value: unknown, path: string, v: Validator): void {
	const number = v.finiteNumber(value, path)
	if (number !== undefined && number <= 0)
		v.issue('protocol.invalid_target_error', path, 'targetMaxError must be greater than zero.')
}

function validateRegionIds(value: unknown, path: string, v: Validator, nonEmpty: boolean): void {
	const ids = v.array(value, path)
	if (!ids) return
	if (nonEmpty && ids.length === 0) v.issue('protocol.empty_region_ids', path, 'Partial contour requests target at least one regionId.')
	const seen = new Set<string>()
	ids.forEach((id, index) => {
		const parsed = v.string(id, jsonPointer(path, index), true)
		if (parsed !== undefined && seen.has(parsed))
			v.issue('protocol.duplicate_region_id', jsonPointer(path, index), 'regionIds is an exact set and contains no duplicate identity.')
		if (parsed !== undefined) seen.add(parsed)
	})
}

function forbidRuntimeSnapshotVersion(payload: Record<string, unknown>, path: string, v: Validator): void {
	if (Object.hasOwn(payload, 'snapshotVersion'))
		v.issue('protocol.runtime_snapshot_version_forbidden', `${path}/snapshotVersion`, 'Workbench assigns snapshotVersion only after an atomic successful commit.')
	if (Object.hasOwn(payload, 'geometryRevision'))
		v.issue('protocol.duplicate_geometry_revision', `${path}/geometryRevision`, 'geometryRevision is correlated through context and is not duplicated in payload.')
}

export function validatePartialResponseAgainstRequest(
	request: PartialContourRequest,
	response: PartialContourResponse,
): ValidationResult<PartialContourResponse> {
	const v = new Validator()
	if (!sameApplicableContext(request.context, response.context))
		v.issue('protocol.partial_context_mismatch', '/context', 'Partial response must correlate to its exact request context.')
	if (request.payload.sequence !== response.payload.sequence)
		v.issue('protocol.partial_sequence_mismatch', '/payload/sequence', 'Partial response echoes the request sequence.')
	if (request.payload.baseSnapshotVersion !== response.payload.baseSnapshotVersion)
		v.issue('protocol.partial_base_mismatch', '/payload/baseSnapshotVersion', 'Partial response echoes the exact base snapshot version.')
	const expected = new Set(request.payload.regionIds)
	const actual = response.payload.regions.map(region => region.regionId)
	if (actual.length !== expected.size || actual.some(id => !expected.has(id)) || new Set(actual).size !== actual.length)
		v.issue('protocol.partial_region_set_mismatch', '/payload/regions', 'Partial response must return each requested regionId exactly once and no other region.')
	return v.finish<PartialContourResponse>(response)
}

export function responseMeetsRequestedPrecision(regions: readonly VisibleRegion[], targetMaxError: number): boolean {
	return regions.every(region => region.maxError <= targetMaxError)
}

export function validatePreviewFailureDiagnostic(input: unknown, path = ''): ValidationResult<PreviewFailureDiagnostic> {
	const v = new Validator()
	const diagnostic = v.object(input, path)
	if (!diagnostic) return v.finish<PreviewFailureDiagnostic>(input)
	if (typeof diagnostic.category !== 'string' || !FAILURE_CATEGORIES.has(diagnostic.category as ProtocolFailureCategory))
		v.issue('protocol.invalid_failure_category', `${path}/category`, 'Failure category must be transport, protocol, runtime, or capability.')
	const category = diagnostic.category as string
	const reason = v.string(diagnostic.reason, `${path}/reason`, true)
	if (reason && !reason.startsWith(`${category}.`))
		v.issue('protocol.failure_reason_category_mismatch', `${path}/reason`, 'Failure reason prefix must match its category.')
	if (reason && !INITIAL_REASON_CODES.has(reason) && !/^(transport|protocol|runtime|capability)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/u.test(reason))
		v.issue('protocol.invalid_failure_reason', `${path}/reason`, 'Failure reason must be a stable category-prefixed identifier.')
	if (Object.hasOwn(diagnostic, 'detail')) {
		const detail = v.string(diagnostic.detail, `${path}/detail`)
		if (detail !== undefined && (detail.length > 500 || containsProtocolControl(detail)))
			v.issue('protocol.unsafe_failure_detail', `${path}/detail`, 'Failure detail must be bounded and display-safe.')
	}
	if (Object.hasOwn(diagnostic, 'correlation')) {
		const correlation = v.object(diagnostic.correlation, `${path}/correlation`)
		if (correlation) {
			if (Object.hasOwn(correlation, 'traceId')) v.issue('protocol.diagnostic_identity_forbidden', `${path}/correlation/traceId`, 'Diagnostics reuse established protocol identities; they add no trace ID.')
			for (const [key, value] of Object.entries(correlation)) {
				if (!KNOWN_CONTEXT_KEYS.has(key) && !['sequence', 'baseSnapshotVersion'].includes(key))
					v.issue('protocol.unknown_correlation_identity', jsonPointer(`${path}/correlation`, key), 'Failure correlation uses existing protocol identities only.')
				if (value === null) v.issue('protocol.null_optional_field', jsonPointer(`${path}/correlation`, key), 'Optional identities are omitted instead of encoded as null.')
				else if (key === 'viewId') validateUuid(value, jsonPointer(`${path}/correlation`, key), v, 'View identity')
				else if (typeof value === 'string') v.string(value, jsonPointer(`${path}/correlation`, key), true)
				else validateSequence(value, jsonPointer(`${path}/correlation`, key), v)
			}
		}
	}
	return v.finish<PreviewFailureDiagnostic>(input)
}

function containsProtocolControl(value: string): boolean {
	return [...value].some(character => {
		const code = character.charCodeAt(0)
		return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
	})
}

function sameApplicableContext(left: ProtocolContext, right: ProtocolContext): boolean {
	for (const key of ['previewSessionId', 'runtimeGenerationId', 'viewId', 'variantId', 'runtimeContextVersion', 'navigationRequestId', 'widgetId', 'geometryRevision'] as const) {
		if (left[key] !== right[key]) return false
	}
	return true
}

const MAX_INTERSECTION_DEPTH = 24
const MAX_INTERSECTION_VISITS = 100_000

type Bounds = Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>
type IntersectionBudget = { remaining: number }

function hasPathSelfIntersection(segments: readonly PathSegment[]): boolean {
	if (segments.some(segment => segment.kind === 'cubic' && cubicSelfIntersects(segment))) return true
	const count = segments.length
	for (let leftIndex = 0; leftIndex < count; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < count; rightIndex++) {
			const left = segments[leftIndex]!
			const right = segments[rightIndex]!
			const sharedEndpoints = adjacentSharedEndpoints(leftIndex, rightIndex, segments)
			const budget: IntersectionBudget = { remaining: MAX_INTERSECTION_VISITS }
			if (pathSegmentsIntersect(left, right, sharedEndpoints, budget)) return true
		}
	}
	return false
}

function adjacentSharedEndpoints(
	leftIndex: number,
	rightIndex: number,
	segments: readonly PathSegment[],
): readonly Point[] {
	const left = segments[leftIndex]!
	const right = segments[rightIndex]!
	const shared: Point[] = []
	if (rightIndex === leftIndex + 1 && samePoint(left.to, right.from)) shared.push(left.to)
	if (leftIndex === 0 && rightIndex === segments.length - 1 && samePoint(left.from, right.to)
		&& !shared.some(point => samePoint(point, left.from)))
		shared.push(left.from)
	return shared
}

function pathSegmentsIntersect(
	left: PathSegment,
	right: PathSegment,
	sharedEndpoints: readonly Point[],
	budget: IntersectionBudget,
): boolean {
	if (left.kind === 'line' && right.kind === 'line')
		return lineSegmentsIntersectBeyondSharedEndpoints(left.from, left.to, right.from, right.to, sharedEndpoints)
	if (left.kind === 'line')
		return lineCubicIntersects(left, right, sharedEndpoints, 0, budget)
	if (right.kind === 'line')
		return lineCubicIntersects(right, left, sharedEndpoints, 0, budget)
	return cubicPairIntersects(left, right, sharedEndpoints, 0, budget)
}

function lineCubicIntersects(
	line: Extract<PathSegment, { kind: 'line' }>,
	cubic: Extract<PathSegment, { kind: 'cubic' }>,
	sharedEndpoints: readonly Point[],
	depth: number,
	budget: IntersectionBudget,
): boolean {
	if (--budget.remaining < 0) return true
	if (!boundsOverlap(lineBounds(line.from, line.to), cubicBounds(cubic))) return false
	if (depth >= MAX_INTERSECTION_DEPTH) {
		if (lineSegmentsIntersectBeyondSharedEndpoints(
			line.from,
			line.to,
			cubic.from,
			cubic.to,
			sharedEndpoints,
		)) return true
		return !hasCommonSharedEndpoint([line.from, line.to], [cubic.from, cubic.to], sharedEndpoints)
	}
	const [first, second] = splitCubic(cubic)
	return lineCubicIntersects(line, first, sharedEndpoints, depth + 1, budget)
		|| lineCubicIntersects(line, second, sharedEndpoints, depth + 1, budget)
}

function cubicPairIntersects(
	left: Extract<PathSegment, { kind: 'cubic' }>,
	right: Extract<PathSegment, { kind: 'cubic' }>,
	sharedEndpoints: readonly Point[],
	depth: number,
	budget: IntersectionBudget,
): boolean {
	if (--budget.remaining < 0) return true
	const leftBounds = cubicBounds(left)
	const rightBounds = cubicBounds(right)
	if (!boundsOverlap(leftBounds, rightBounds)) return false
	if (depth >= MAX_INTERSECTION_DEPTH) {
		if (lineSegmentsIntersectBeyondSharedEndpoints(
			left.from,
			left.to,
			right.from,
			right.to,
			sharedEndpoints,
		)) return true
		return !hasCommonSharedEndpoint([left.from, left.to], [right.from, right.to], sharedEndpoints)
	}

	if (boundsSpan(leftBounds) >= boundsSpan(rightBounds)) {
		const [first, second] = splitCubic(left)
		return cubicPairIntersects(first, right, sharedEndpoints, depth + 1, budget)
			|| cubicPairIntersects(second, right, sharedEndpoints, depth + 1, budget)
	}

	const [first, second] = splitCubic(right)
	return cubicPairIntersects(left, first, sharedEndpoints, depth + 1, budget)
		|| cubicPairIntersects(left, second, sharedEndpoints, depth + 1, budget)
}

function lineSegmentsIntersectBeyondSharedEndpoints(
	a: Point,
	b: Point,
	c: Point,
	d: Point,
	sharedEndpoints: readonly Point[],
): boolean {
	if (!segmentsIntersect(a, b, c, d)) return false
	if (sharedEndpoints.length === 0) return true

	const collinear = orientation(a, b, c) === 0 && orientation(a, b, d) === 0
	if (collinear) {
		const nonSharedEndpoints = [a, b, c, d].filter(point =>
			!sharedEndpoints.some(shared => samePoint(point, shared)))
		return nonSharedEndpoints.some(point =>
			(onSegment(a, b, point) && !samePoint(point, a) && !samePoint(point, b))
			|| (onSegment(c, d, point) && !samePoint(point, c) && !samePoint(point, d)))
			|| segmentsSharePositiveLength(a, b, c, d, sharedEndpoints)
	}

	const proper = orientation(a, b, c) * orientation(a, b, d) < 0
		&& orientation(c, d, a) * orientation(c, d, b) < 0
	if (proper) return true

	for (const point of [a, b]) {
		if (onSegment(c, d, point) && !sharedEndpoints.some(shared => samePoint(point, shared))) return true
	}
	for (const point of [c, d]) {
		if (onSegment(a, b, point) && !sharedEndpoints.some(shared => samePoint(point, shared))) return true
	}
	return false
}

function segmentsSharePositiveLength(
	a: Point,
	b: Point,
	c: Point,
	d: Point,
	sharedEndpoints: readonly Point[],
): boolean {
	const axis: 'x' | 'y' = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'x' : 'y'
	const leftMin = Math.min(a[axis], b[axis])
	const leftMax = Math.max(a[axis], b[axis])
	const rightMin = Math.min(c[axis], d[axis])
	const rightMax = Math.max(c[axis], d[axis])
	const overlapMin = Math.max(leftMin, rightMin)
	const overlapMax = Math.min(leftMax, rightMax)
	if (overlapMax > overlapMin) return true
	if (overlapMax < overlapMin) return false
	const touchingCoordinate = overlapMin
	return !sharedEndpoints.some(point => point[axis] === touchingCoordinate
		&& onSegment(a, b, point) && onSegment(c, d, point))
}

function hasCommonSharedEndpoint(
	leftEndpoints: readonly Point[],
	rightEndpoints: readonly Point[],
	sharedEndpoints: readonly Point[],
): boolean {
	return sharedEndpoints.some(shared =>
		leftEndpoints.some(point => samePoint(point, shared))
		&& rightEndpoints.some(point => samePoint(point, shared)))
}

function lineBounds(from: Point, to: Point): Bounds {
	return {
		minX: Math.min(from.x, to.x),
		minY: Math.min(from.y, to.y),
		maxX: Math.max(from.x, to.x),
		maxY: Math.max(from.y, to.y),
	}
}

function cubicBounds(cubic: Extract<PathSegment, { kind: 'cubic' }>): Bounds {
	return {
		minX: Math.min(cubic.from.x, cubic.c1.x, cubic.c2.x, cubic.to.x),
		minY: Math.min(cubic.from.y, cubic.c1.y, cubic.c2.y, cubic.to.y),
		maxX: Math.max(cubic.from.x, cubic.c1.x, cubic.c2.x, cubic.to.x),
		maxY: Math.max(cubic.from.y, cubic.c1.y, cubic.c2.y, cubic.to.y),
	}
}

function boundsOverlap(left: Bounds, right: Bounds): boolean {
	return left.maxX >= right.minX && right.maxX >= left.minX
		&& left.maxY >= right.minY && right.maxY >= left.minY
}

function boundsSpan(bounds: Bounds): number {
	return Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
}

function splitCubic(
	cubic: Extract<PathSegment, { kind: 'cubic' }>,
): readonly [
	Extract<PathSegment, { kind: 'cubic' }>,
	Extract<PathSegment, { kind: 'cubic' }>,
] {
	const p01 = midpoint(cubic.from, cubic.c1)
	const p12 = midpoint(cubic.c1, cubic.c2)
	const p23 = midpoint(cubic.c2, cubic.to)
	const p012 = midpoint(p01, p12)
	const p123 = midpoint(p12, p23)
	const middle = midpoint(p012, p123)
	return [
		{ kind: 'cubic', from: cubic.from, c1: p01, c2: p012, to: middle },
		{ kind: 'cubic', from: middle, c1: p123, c2: p23, to: cubic.to },
	]
}

function midpoint(left: Point, right: Point): Point {
	return {
		x: left.x / 2 + right.x / 2,
		y: left.y / 2 + right.y / 2,
	}
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const o1 = orientation(a, b, c)
	const o2 = orientation(a, b, d)
	const o3 = orientation(c, d, a)
	const o4 = orientation(c, d, b)
	if (o1 === 0 && onSegment(a, b, c)) return true
	if (o2 === 0 && onSegment(a, b, d)) return true
	if (o3 === 0 && onSegment(c, d, a)) return true
	if (o4 === 0 && onSegment(c, d, b)) return true
	return o1 * o2 < 0 && o3 * o4 < 0
}

function orientation(a: Point, b: Point, c: Point): number {
	const determinant = subtract(
		multiply(subtract(exactNumber(b.x), exactNumber(a.x)), subtract(exactNumber(c.y), exactNumber(a.y))),
		multiply(subtract(exactNumber(b.y), exactNumber(a.y)), subtract(exactNumber(c.x), exactNumber(a.x))),
	)
	return determinant.n < 0n ? -1 : determinant.n > 0n ? 1 : 0
}

function onSegment(a: Point, b: Point, p: Point): boolean {
	return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
		&& p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
}

function signedAreaIsZero(segments: readonly PathSegment[]): boolean {
	let area = rational(0n, 1n)
	for (const segment of segments) {
		if (segment.kind === 'line') {
			area = add(area, subtract(multiply(exactNumber(segment.from.x), exactNumber(segment.to.y)), multiply(exactNumber(segment.to.x), exactNumber(segment.from.y))))
			continue
		}
		const x = cubicPowerCoefficients(segment.from.x, segment.c1.x, segment.c2.x, segment.to.x)
		const y = cubicPowerCoefficients(segment.from.y, segment.c1.y, segment.c2.y, segment.to.y)
		for (let i = 0; i <= 3; i++) {
			for (let j = 1; j <= 3; j++) {
				const dxTerm = multiply(x[i]!, multiplyInteger(y[j]!, BigInt(j)))
				const dyTerm = multiply(y[i]!, multiplyInteger(x[j]!, BigInt(j)))
				area = add(area, divideInteger(subtract(dxTerm, dyTerm), BigInt(i + j)))
			}
		}
	}
	return area.n === 0n
}

function cubicPowerCoefficients(p0: number, p1: number, p2: number, p3: number): Rational[] {
	const a = exactNumber(p0)
	const b = exactNumber(p1)
	const c = exactNumber(p2)
	const d = exactNumber(p3)
	return [
		a,
		multiplyInteger(subtract(b, a), 3n),
		multiplyInteger(add(subtract(c, multiplyInteger(b, 2n)), a), 3n),
		add(subtract(add(d, multiplyInteger(b, 3n)), multiplyInteger(c, 3n)), multiplyInteger(a, -1n)),
	]
}

function cubicSelfIntersects(segment: Extract<PathSegment, { kind: 'cubic' }>): boolean {
	const scale = Math.max(
		Math.abs(segment.from.x), Math.abs(segment.from.y), Math.abs(segment.c1.x), Math.abs(segment.c1.y),
		Math.abs(segment.c2.x), Math.abs(segment.c2.y), Math.abs(segment.to.x), Math.abs(segment.to.y),
	)
	if (scale === 0 || !Number.isFinite(scale)) return false
	const p0 = { x: segment.from.x / scale, y: segment.from.y / scale }
	const p1 = { x: segment.c1.x / scale, y: segment.c1.y / scale }
	const p2 = { x: segment.c2.x / scale, y: segment.c2.y / scale }
	const p3 = { x: segment.to.x / scale, y: segment.to.y / scale }
	const ax = -p0.x + 3 * p1.x - 3 * p2.x + p3.x
	const ay = -p0.y + 3 * p1.y - 3 * p2.y + p3.y
	const bx = 3 * p0.x - 6 * p1.x + 3 * p2.x
	const by = 3 * p0.y - 6 * p1.y + 3 * p2.y
	const cx = -3 * p0.x + 3 * p1.x
	const cy = -3 * p0.y + 3 * p1.y
	const determinant = ax * by - ay * bx
	if (determinant === 0) return false
	const q = (bx * cy - cx * by) / determinant
	const sum = (cx * ay - ax * cy) / determinant
	const product = sum * sum - q
	const discriminant = sum * sum - 4 * product
	if (!(discriminant > 0)) return false
	const root = Math.sqrt(discriminant)
	const first = (sum - root) / 2
	const second = (sum + root) / 2
	if (!(first >= 0 && first <= 1 && second >= 0 && second <= 1)) return false
	return !(first === 0 && second === 1 && samePoint(segment.from, segment.to))
}

function samePoint(a: Point, b: Point): boolean {
	return a.x === b.x && a.y === b.y
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Exact rational predicates over the IEEE-754 values received on the wire. */
type Rational = Readonly<{ n: bigint; d: bigint }>

function exactNumber(value: number): Rational {
	if (value === 0) return rational(0n, 1n)
	const buffer = new ArrayBuffer(8)
	const view = new DataView(buffer)
	view.setFloat64(0, value, false)
	const bits = view.getBigUint64(0, false)
	const negative = (bits >> 63n) === 1n
	const exponentBits = Number((bits >> 52n) & 0x7ffn)
	const fractionBits = bits & ((1n << 52n) - 1n)
	const significand = exponentBits === 0 ? fractionBits : (1n << 52n) + fractionBits
	const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52
	let numerator = negative ? -significand : significand
	let denominator = 1n
	if (exponent >= 0) numerator <<= BigInt(exponent)
	else denominator <<= BigInt(-exponent)
	return rational(numerator, denominator)
}

function rational(numerator: bigint, denominator: bigint): Rational {
	if (denominator === 0n) throw new RangeError('Invalid rational denominator')
	const sign = denominator < 0n ? -1n : 1n
	const divisor = gcd(numerator, denominator)
	return { n: (numerator / divisor) * sign, d: (denominator / divisor) * sign }
}

function add(left: Rational, right: Rational): Rational {
	return rational(left.n * right.d + right.n * left.d, left.d * right.d)
}

function subtract(left: Rational, right: Rational): Rational {
	return rational(left.n * right.d - right.n * left.d, left.d * right.d)
}

function multiply(left: Rational, right: Rational): Rational {
	return rational(left.n * right.n, left.d * right.d)
}

function multiplyInteger(value: Rational, factor: bigint): Rational {
	return rational(value.n * factor, value.d)
}

function divideInteger(value: Rational, divisor: bigint): Rational {
	return rational(value.n, value.d * divisor)
}

function gcd(a: bigint, b: bigint): bigint {
	a = a < 0n ? -a : a
	b = b < 0n ? -b : b
	while (b !== 0n) [a, b] = [b, a % b]
	return a || 1n
}
