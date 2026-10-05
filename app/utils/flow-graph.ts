import { validateFlowResource } from '../../src/domain/flows/schema'

/**
 * UX Flow graph projection (Discussion #6, items 5, 7, 8, 10c and 12).
 *
 * The canonical Flow is `{ id, name, scenarioRef?, entryStepId, steps }` with steps keyed by their
 * immutable UUID and transitions nested in their source step. Everything in this module is a
 * temporary Workbench projection of that one model: node and edge arrays, layout positions and
 * edge keys are never persisted and are not identities outside this editor.
 */

export type FlowTransitionDraft = {
	trigger: { widgetId: string; event: string }
	targetStepId: string
}

export type FlowStepDraft = {
	target: { viewId: string; variantName?: string }
	transitions: FlowTransitionDraft[]
}

export type FlowDraft = {
	id: string
	name: string
	scenarioRef?: Record<string, unknown>
	entryStepId: string
	steps: Record<string, FlowStepDraft>
}

/** What the editor knows about one target View. `widgets` is undefined when the View IR can't be read. */
export type FlowViewFacts = Readonly<{
	name: string
	variants: readonly string[]
	widgets?: ReadonlyMap<string, string>
}>

/** `missing`: not in this Workspace. `pending`: still loading, so nothing is concluded yet. */
export type FlowViewIndex = ReadonlyMap<string, FlowViewFacts | 'missing' | 'pending'>

export type FlowProblemKind =
	| 'unreachable'
	| 'ambiguous'
	| 'missingTargetStep'
	| 'missingEntry'
	| 'incomplete'
	| 'structure'
	| 'missingView'
	| 'missingVariant'
	| 'missingWidget'

export type FlowProblem = Readonly<{
	kind: FlowProblemKind
	/** The canonical diagnostic code, or a Workbench reference-check code. */
	code: string
	path: string
	stepId?: string
	edgeKey?: string
	/** Canonical message, kept for Details; the Workbench renders its own localized text. */
	message?: string
	params: Readonly<Record<string, string>>
	/** Structural problems are rejected by `update_flow`, so they also block Save. */
	blocksSave: boolean
}>

/** What the editor has selected: a step (by its canonical key) or a transition (by its ephemeral edge key). */
export type FlowSelection =
	| Readonly<{ kind: 'step'; stepId: string }>
	| Readonly<{ kind: 'edge'; key: string }>

/** Ephemeral edge key: source step plus the transition's current array position. Not canonical identity. */
export function edgeKey(stepId: string, index: number): string {
	return `${stepId}:${index}`
}

export function parseEdgeKey(key: string): { stepId: string; index: number } | undefined {
	const at = key.lastIndexOf(':')
	if (at <= 0) return undefined
	const index = Number(key.slice(at + 1))
	return Number.isInteger(index) && index >= 0 ? { stepId: key.slice(0, at), index } : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : ''
}

/** Key-order-independent JSON, so a lossless round trip can be checked. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
	if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
	return JSON.stringify(value) ?? 'null'
}

/**
 * Copies a Flow read into an editable draft. The read may come from an out-of-band edited file, so
 * nothing is assumed about its shape. `lossless` is false when the draft cannot represent the file
 * exactly; the editor then stays read-only instead of silently rewriting what it does not understand.
 */
export function toFlowDraft(resource: unknown): { draft: FlowDraft; lossless: boolean } {
	const source = isRecord(resource) ? resource : {}
	const steps: Record<string, FlowStepDraft> = {}
	if (isRecord(source.steps)) {
		for (const [stepId, rawStep] of Object.entries(source.steps)) {
			const step = isRecord(rawStep) ? rawStep : {}
			const target = isRecord(step.target) ? step.target : {}
			const transitions = Array.isArray(step.transitions) ? step.transitions : []
			steps[stepId] = {
				target: {
					viewId: text(target.viewId),
					...(typeof target.variantName === 'string' ? { variantName: target.variantName } : {}),
				},
				transitions: transitions.map((rawTransition) => {
					const transition = isRecord(rawTransition) ? rawTransition : {}
					const trigger = isRecord(transition.trigger) ? transition.trigger : {}
					return {
						trigger: { widgetId: text(trigger.widgetId), event: text(trigger.event) },
						targetStepId: text(transition.targetStepId),
					}
				}),
			}
		}
	}
	const draft: FlowDraft = {
		id: text(source.id),
		name: text(source.name),
		...(isRecord(source.scenarioRef) ? { scenarioRef: source.scenarioRef } : {}),
		entryStepId: text(source.entryStepId),
		steps,
	}
	return { draft, lossless: stableJson(draft) === stableJson(source) }
}

/** The `update_flow` body fields for a draft. `scenarioRef` is carried through verbatim. */
export function draftToCanonical(draft: FlowDraft) {
	const steps: Record<string, FlowStepDraft> = {}
	for (const [stepId, step] of Object.entries(draft.steps)) {
		steps[stepId] = {
			target: {
				viewId: step.target.viewId,
				...(step.target.variantName !== undefined ? { variantName: step.target.variantName } : {}),
			},
			transitions: step.transitions.map(transition => ({
				trigger: { widgetId: transition.trigger.widgetId, event: transition.trigger.event },
				targetStepId: transition.targetStepId,
			})),
		}
	}
	return {
		name: draft.name,
		...(draft.scenarioRef ? { scenarioRef: draft.scenarioRef } : {}),
		entryStepId: draft.entryStepId,
		steps,
	}
}

export function cloneDraft(draft: FlowDraft): FlowDraft {
	return { id: draft.id, ...draftToCanonical(draft) }
}

export function sameDraft(a: FlowDraft | undefined, b: FlowDraft | undefined): boolean {
	return stableJson(a) === stableJson(b)
}

// -------------------------------------------------------------------------------------------------
// Validation (structural, from the canonical validator, plus Workbench reference checks)
// -------------------------------------------------------------------------------------------------

const STRUCTURAL_KINDS: Readonly<Record<string, FlowProblemKind>> = {
	'flow.unreachable_step': 'unreachable',
	'flow.ambiguous_trigger': 'ambiguous',
	'flow.dangling_target_step': 'missingTargetStep',
	'flow.dangling_entry_step': 'missingEntry',
	'schema.empty_string': 'incomplete',
	'schema.expected_string': 'incomplete',
}

function locate(path: string): { stepId?: string; transitionIndex?: number; field?: string } {
	const match = /^\/steps\/([^/]+)(?:\/transitions\/(\d+)(?:\/(.+))?|\/(.+))?$/.exec(path)
	if (!match) return {}
	const stepId = match[1]!.replaceAll('~1', '/').replaceAll('~0', '~')
	if (match[2] !== undefined) return { stepId, transitionIndex: Number(match[2]), ...(match[3] ? { field: match[3] } : {}) }
	return { stepId, ...(match[4] ? { field: match[4] } : {}) }
}

/** Formats a trigger the way edges are labelled: `widgetId.event`. */
export function triggerLabel(trigger: Readonly<{ widgetId: string; event: string }>): string {
	return `${trigger.widgetId || '?'}.${trigger.event || '?'}`
}

/**
 * Every problem of a draft, in a stable order. Structural problems come from the same validator the
 * authoring service runs. Reference problems (missing View, Variant or Widget) follow Part 6 #7:
 * the authored reference is kept verbatim and reported, never rebound. Event names are not checked:
 * the Workbench has no Catalog of declared Widget Events.
 */
export function validateFlowDraft(draft: FlowDraft, views: FlowViewIndex): FlowProblem[] {
	const problems: FlowProblem[] = []
	const validation = validateFlowResource({ id: draft.id, ...draftToCanonical(draft) })
	for (const diagnostic of validation.diagnostics) {
		const where = locate(diagnostic.path)
		const kind = STRUCTURAL_KINDS[diagnostic.code] ?? 'structure'
		const step = where.stepId ? draft.steps[where.stepId] : undefined
		const transition = step && where.transitionIndex !== undefined ? step.transitions[where.transitionIndex] : undefined
		problems.push(Object.freeze({
			kind,
			code: diagnostic.code,
			path: diagnostic.path,
			...(where.stepId ? { stepId: where.stepId } : {}),
			...(where.stepId && where.transitionIndex !== undefined ? { edgeKey: edgeKey(where.stepId, where.transitionIndex) } : {}),
			message: diagnostic.message,
			params: Object.freeze({
				...(transition ? { trigger: triggerLabel(transition.trigger) } : {}),
				...(where.field ? { field: where.field.split('/').pop()! } : {}),
			}),
			blocksSave: true,
		}))
	}

	for (const [stepId, step] of Object.entries(draft.steps)) {
		const viewId = step.target.viewId
		const facts = views.get(viewId)
		if (viewId && facts === 'missing') {
			problems.push(Object.freeze({
				kind: 'missingView', code: 'reference.missing_view', path: `/steps/${stepId}/target/viewId`, stepId,
				params: Object.freeze({ viewId }), blocksSave: false,
			}))
			continue
		}
		if (!facts || facts === 'pending' || facts === 'missing') continue
		const variant = step.target.variantName
		if (variant !== undefined && variant !== '' && !facts.variants.includes(variant)) {
			problems.push(Object.freeze({
				kind: 'missingVariant', code: 'reference.missing_variant', path: `/steps/${stepId}/target/variantName`, stepId,
				params: Object.freeze({ variant, view: facts.name }), blocksSave: false,
			}))
		}
		if (!facts.widgets) continue
		step.transitions.forEach((transition, index) => {
			const widgetId = transition.trigger.widgetId
			if (!widgetId || facts.widgets!.has(widgetId)) return
			problems.push(Object.freeze({
				kind: 'missingWidget', code: 'reference.missing_widget', path: `/steps/${stepId}/transitions/${index}/trigger/widgetId`,
				stepId, edgeKey: edgeKey(stepId, index),
				params: Object.freeze({ widgetId, view: facts.name }), blocksSave: false,
			}))
		})
	}
	return problems
}

/** True while referenced Views are still loading: reference problems are not known yet. */
export function referencesPending(draft: FlowDraft, views: FlowViewIndex): boolean {
	return Object.values(draft.steps).some(step => !!step.target.viewId && (!views.has(step.target.viewId) || views.get(step.target.viewId) === 'pending'))
}

// -------------------------------------------------------------------------------------------------
// Graph projection and layout
// -------------------------------------------------------------------------------------------------

export const NODE_WIDTH = 216
export const NODE_HEIGHT = 76
const COLUMN_GAP = 192
const ROW_GAP = 48
const PADDING = 48
/** Room above the first row for self-loops and their labels. */
const PADDING_TOP = 88

export type FlowNode = Readonly<{
	stepId: string
	viewId: string
	variantName?: string
	isEntry: boolean
	isTerminal: boolean
	reachable: boolean
	/** Breadth-first order from the entry step; unreachable steps follow in canonical key order. */
	order: number
	column: number
	row: number
	x: number
	y: number
}>

export type FlowEdge = Readonly<{
	key: string
	sourceStepId: string
	targetStepId: string
	index: number
	trigger: Readonly<{ widgetId: string; event: string }>
	/** False when `targetStepId` names no step in this Flow; the edge then has no drawn target. */
	resolved: boolean
}>

export type FlowGraph = Readonly<{
	nodes: readonly FlowNode[]
	edges: readonly FlowEdge[]
	width: number
	height: number
}>

/** Steps in reading order: breadth-first from the entry, then every unreachable step in key order. */
export function orderSteps(draft: FlowDraft): { order: string[]; depth: Map<string, number>; reachable: Set<string> } {
	const depth = new Map<string, number>()
	const order: string[] = []
	const entry = draft.entryStepId
	if (draft.steps[entry]) {
		depth.set(entry, 0)
		const queue = [entry]
		while (queue.length) {
			const current = queue.shift()!
			order.push(current)
			for (const transition of draft.steps[current]?.transitions ?? []) {
				const target = transition.targetStepId
				if (!draft.steps[target] || depth.has(target)) continue
				depth.set(target, depth.get(current)! + 1)
				queue.push(target)
			}
		}
	}
	const reachable = new Set(order)
	for (const stepId of Object.keys(draft.steps)) if (!reachable.has(stepId)) order.push(stepId)
	return { order, depth, reachable }
}

/**
 * Layered layout: a column per breadth-first distance from the entry step, rows in discovery order,
 * columns centred against the tallest one. Unreachable steps take one trailing column so they stay
 * visible for repair. Positions are recomputed from the canonical model and never persisted.
 */
export function projectFlowGraph(draft: FlowDraft): FlowGraph {
	const { order, depth, reachable } = orderSteps(draft)
	const maxDepth = Math.max(-1, ...depth.values())
	const columns = new Map<number, string[]>()
	for (const stepId of order) {
		const column = reachable.has(stepId) ? depth.get(stepId)! : maxDepth + 1
		if (!columns.has(column)) columns.set(column, [])
		columns.get(column)!.push(stepId)
	}
	const tallest = Math.max(1, ...[...columns.values()].map(list => list.length))
	const columnCount = Math.max(1, columns.size ? Math.max(...columns.keys()) + 1 : 1)
	const nodes: FlowNode[] = []
	for (const [column, stepIds] of columns) {
		const offset = ((tallest - stepIds.length) * (NODE_HEIGHT + ROW_GAP)) / 2
		stepIds.forEach((stepId, row) => {
			const step = draft.steps[stepId]!
			nodes.push(Object.freeze({
				stepId,
				viewId: step.target.viewId,
				...(step.target.variantName !== undefined ? { variantName: step.target.variantName } : {}),
				isEntry: stepId === draft.entryStepId,
				isTerminal: step.transitions.length === 0,
				reachable: reachable.has(stepId),
				order: order.indexOf(stepId),
				column,
				row,
				x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
				y: PADDING_TOP + offset + row * (NODE_HEIGHT + ROW_GAP),
			}))
		})
	}
	nodes.sort((a, b) => a.order - b.order)
	const edges: FlowEdge[] = []
	for (const stepId of order) {
		draft.steps[stepId]!.transitions.forEach((transition, index) => {
			edges.push(Object.freeze({
				key: edgeKey(stepId, index),
				sourceStepId: stepId,
				targetStepId: transition.targetStepId,
				index,
				trigger: Object.freeze({ ...transition.trigger }),
				resolved: !!draft.steps[transition.targetStepId],
			}))
		})
	}
	return Object.freeze({
		nodes: Object.freeze(nodes),
		edges: Object.freeze(edges),
		width: PADDING * 2 + columnCount * NODE_WIDTH + (columnCount - 1) * COLUMN_GAP,
		// Room below the lowest row for routed back edges and their labels.
		height: PADDING_TOP + PADDING + tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP + 56,
	})
}

export type GraphPoint = Readonly<{ x: number; y: number }>
export type EdgeRoute = Readonly<{ path: string; label: GraphPoint; kind: 'forward' | 'back' | 'self' | 'dangling' }>

/**
 * SVG route for one edge. Forward edges leave the source's right side and enter the target's left
 * side; edges to the same or an earlier column arc below both nodes; a self-loop arcs above its node.
 * `lane` spreads parallel edges between the same pair of steps.
 */
export function routeEdge(source: FlowNode, target: FlowNode | undefined, lane: number): EdgeRoute {
	const spread = lane * 22
	if (!target) {
		const start = { x: source.x + NODE_WIDTH, y: source.y + NODE_HEIGHT / 2 + spread }
		const end = { x: start.x + 72, y: start.y }
		return { path: `M ${start.x} ${start.y} L ${end.x} ${end.y}`, label: { x: start.x + 36, y: start.y - 14 }, kind: 'dangling' }
	}
	if (source.stepId === target.stepId) {
		const left = source.x + NODE_WIDTH * 0.62 - spread
		const right = source.x + NODE_WIDTH * 0.86
		const top = source.y
		const lift = 44 + spread
		return {
			path: `M ${left} ${top} C ${left} ${top - lift}, ${right} ${top - lift}, ${right} ${top}`,
			label: { x: (left + right) / 2, y: top - lift * 0.75 - 10 },
			kind: 'self',
		}
	}
	if (target.column > source.column) {
		const start = { x: source.x + NODE_WIDTH, y: source.y + NODE_HEIGHT / 2 }
		const end = { x: target.x, y: target.y + NODE_HEIGHT / 2 }
		const bend = Math.max(48, (end.x - start.x) / 2)
		const c1 = { x: start.x + bend, y: start.y + spread }
		const c2 = { x: end.x - bend, y: end.y + spread }
		return {
			path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
			label: cubicMidpoint(start, c1, c2, end),
			kind: 'forward',
		}
	}
	const start = { x: source.x + NODE_WIDTH / 2 - 16, y: source.y + NODE_HEIGHT }
	const end = { x: target.x + NODE_WIDTH / 2 + 16, y: target.y + NODE_HEIGHT }
	const drop = 52 + spread + Math.abs(source.row - target.row) * 8
	const bottom = Math.max(start.y, end.y) + drop
	const c1 = { x: start.x, y: bottom }
	const c2 = { x: end.x, y: bottom }
	return {
		path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
		label: cubicMidpoint(start, c1, c2, end),
		kind: 'back',
	}
}

function cubicMidpoint(p0: GraphPoint, p1: GraphPoint, p2: GraphPoint, p3: GraphPoint): GraphPoint {
	return { x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8 }
}

/** The connected step for keyboard travel along edges (brief g, section 8). */
export function neighbourStep(graph: FlowGraph, stepId: string, direction: 'next' | 'previous' | 'up' | 'down'): string | undefined {
	const node = graph.nodes.find(item => item.stepId === stepId)
	if (!node) return undefined
	if (direction === 'next')
		return graph.edges.find(edge => edge.sourceStepId === stepId && edge.resolved && edge.targetStepId !== stepId)?.targetStepId
	if (direction === 'previous')
		return graph.edges.find(edge => edge.targetStepId === stepId && edge.sourceStepId !== stepId)?.sourceStepId
	const column = graph.nodes.filter(item => item.column === node.column).sort((a, b) => a.row - b.row)
	const index = column.findIndex(item => item.stepId === stepId)
	return column[index + (direction === 'down' ? 1 : -1)]?.stepId
}

/** Steps whose outgoing transitions would be orphaned or which point at a step, for removal impact. */
export function incomingTransitions(draft: FlowDraft, stepId: string): Array<{ stepId: string; index: number }> {
	const result: Array<{ stepId: string; index: number }> = []
	for (const [sourceId, step] of Object.entries(draft.steps)) {
		if (sourceId === stepId) continue
		step.transitions.forEach((transition, index) => {
			if (transition.targetStepId === stepId) result.push({ stepId: sourceId, index })
		})
	}
	return result
}
