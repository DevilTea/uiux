import { describe, expect, it } from 'vitest'
import {
	draftToCanonical,
	edgeKey,
	incomingTransitions,
	neighbourStep,
	orderSteps,
	parseEdgeKey,
	projectFlowGraph,
	routeEdge,
	toFlowDraft,
	validateFlowDraft,
	type FlowDraft,
	type FlowViewFacts,
	type FlowViewIndex,
} from '../app/utils/flow-graph'
import {
	availableTransitions,
	currentVisit,
	followTrigger,
	resolveTransition,
	restartPlayback,
	startPlayback,
} from '../app/utils/prototype-player'

const FLOW = '00000000-0000-4000-8000-000000000001'
const VIEW_A = '00000000-0000-4000-8000-0000000000a1'
const VIEW_B = '00000000-0000-4000-8000-0000000000b1'
const CART = '00000000-0000-4000-8000-000000000011'
const PAY = '00000000-0000-4000-8000-000000000012'
const DONE = '00000000-0000-4000-8000-000000000013'
const ORPHAN = '00000000-0000-4000-8000-000000000014'

function checkout(): FlowDraft {
	return {
		id: FLOW,
		name: 'Checkout recovery',
		entryStepId: CART,
		steps: {
			[CART]: { target: { viewId: VIEW_A }, transitions: [{ trigger: { widgetId: 'submit', event: 'click' }, targetStepId: PAY }] },
			[PAY]: {
				target: { viewId: VIEW_B, variantName: 'error' },
				transitions: [
					{ trigger: { widgetId: 'retry', event: 'click' }, targetStepId: PAY },
					{ trigger: { widgetId: 'done', event: 'click' }, targetStepId: DONE },
					{ trigger: { widgetId: 'back', event: 'click' }, targetStepId: CART },
				],
			},
			[DONE]: { target: { viewId: VIEW_A, variantName: 'success' }, transitions: [] },
		},
	}
}

function facts(name: string, variants: string[], widgets: string[]): FlowViewFacts {
	return { name, variants, widgets: new Map(widgets.map(id => [id, 'Button'])) }
}

const VIEWS: FlowViewIndex = new Map([
	[VIEW_A, facts('Cart', ['success'], ['root', 'submit'])],
	[VIEW_B, facts('Payment', ['error'], ['root', 'retry', 'done', 'back'])],
])

describe('UX Flow graph projection (Discussion #6, item 12)', () => {
	it('round-trips the canonical keyed-steps model without inventing fields', () => {
		const canonical = { id: FLOW, ...draftToCanonical(checkout()) }
		const { draft, lossless } = toFlowDraft(canonical)
		expect(lossless).toBe(true)
		const body = draftToCanonical(draft)
		expect(body).toEqual(draftToCanonical(checkout()))
		expect(Object.keys(body).sort()).toEqual(['entryStepId', 'name', 'steps'])
		for (const step of Object.values(body.steps)) {
			expect(Object.keys(step).sort()).toEqual(['target', 'transitions'])
			for (const transition of step.transitions) expect(Object.keys(transition).sort()).toEqual(['targetStepId', 'trigger'])
		}
	})

	it('reports a file it cannot represent as lossy instead of rewriting it', () => {
		const { lossless } = toFlowDraft({ ...checkout(), transitions: [] })
		expect(lossless).toBe(false)
		expect(toFlowDraft({ ...checkout(), scenarioRef: { system: 'jira', id: 'X-1' } }).lossless).toBe(true)
	})

	it('lays steps out by breadth-first distance from the entry step, unreachable steps last', () => {
		const flow = checkout()
		flow.steps[ORPHAN] = { target: { viewId: VIEW_A }, transitions: [] }
		const graph = projectFlowGraph(flow)
		const column = Object.fromEntries(graph.nodes.map(node => [node.stepId, node.column]))
		expect(column).toEqual({ [CART]: 0, [PAY]: 1, [DONE]: 2, [ORPHAN]: 3 })
		expect(graph.nodes.find(node => node.stepId === ORPHAN)?.reachable).toBe(false)
		expect(graph.nodes.find(node => node.stepId === CART)?.isEntry).toBe(true)
		expect(graph.nodes.find(node => node.stepId === DONE)?.isTerminal).toBe(true)
		expect(orderSteps(flow).order).toEqual([CART, PAY, DONE, ORPHAN])
	})

	it('projects one edge per nested transition with an ephemeral key, never a persisted id', () => {
		const graph = projectFlowGraph(checkout())
		expect(graph.edges.map(edge => edge.key)).toEqual([edgeKey(CART, 0), edgeKey(PAY, 0), edgeKey(PAY, 1), edgeKey(PAY, 2)])
		expect(parseEdgeKey(edgeKey(PAY, 2))).toEqual({ stepId: PAY, index: 2 })
	})

	it('routes forward, self-loop and back edges differently', () => {
		const graph = projectFlowGraph(checkout())
		const node = (id: string) => graph.nodes.find(item => item.stepId === id)!
		expect(routeEdge(node(CART), node(PAY), 0).kind).toBe('forward')
		expect(routeEdge(node(PAY), node(PAY), 0).kind).toBe('self')
		expect(routeEdge(node(PAY), node(CART), 0).kind).toBe('back')
		expect(routeEdge(node(PAY), undefined, 0).kind).toBe('dangling')
	})

	it('moves keyboard focus along transitions', () => {
		const graph = projectFlowGraph(checkout())
		expect(neighbourStep(graph, CART, 'next')).toBe(PAY)
		expect(neighbourStep(graph, PAY, 'next')).toBe(DONE) // the self-loop is skipped
		expect(neighbourStep(graph, DONE, 'previous')).toBe(PAY)
		expect(neighbourStep(graph, CART, 'previous')).toBe(PAY)
	})

	it('lists the transitions a step removal would take with it', () => {
		expect(incomingTransitions(checkout(), PAY)).toEqual([{ stepId: CART, index: 0 }])
		expect(incomingTransitions(checkout(), CART)).toEqual([{ stepId: PAY, index: 2 }])
	})
})

describe('UX Flow validation (Discussion #6, items 2, 5, 7 and 8)', () => {
	it('finds nothing in a valid Flow', () => {
		expect(validateFlowDraft(checkout(), VIEWS)).toEqual([])
	})

	it('reports unreachable, ambiguous and missing-target problems as save-blocking', () => {
		const flow = checkout()
		flow.steps[ORPHAN] = { target: { viewId: VIEW_A }, transitions: [] }
		flow.steps[PAY]!.transitions.push({ trigger: { widgetId: 'retry', event: 'click' }, targetStepId: DONE })
		flow.steps[CART]!.transitions.push({ trigger: { widgetId: 'submit', event: 'hover' }, targetStepId: '00000000-0000-4000-8000-0000000000ff' })
		const problems = validateFlowDraft(flow, VIEWS)
		const kinds = problems.map(problem => [problem.kind, problem.stepId, problem.edgeKey])
		expect(kinds).toContainEqual(['unreachable', ORPHAN, undefined])
		expect(kinds).toContainEqual(['ambiguous', PAY, edgeKey(PAY, 3)])
		expect(kinds).toContainEqual(['missingTargetStep', CART, edgeKey(CART, 1)])
		expect(problems.every(problem => problem.blocksSave)).toBe(true)
	})

	it('reports missing View, Variant and Widget references without rebinding them', () => {
		const flow = checkout()
		flow.steps[DONE]!.target = { viewId: VIEW_A, variantName: 'gone' }
		flow.steps[CART]!.transitions[0]!.trigger.widgetId = 'renamed-submit'
		const missingView = '00000000-0000-4000-8000-0000000000c1'
		flow.steps[ORPHAN] = { target: { viewId: missingView }, transitions: [] }
		flow.steps[DONE]!.transitions.push({ trigger: { widgetId: 'root', event: 'tap' }, targetStepId: ORPHAN })
		const views = new Map(VIEWS)
		views.set(missingView, 'missing')
		const problems = validateFlowDraft(flow, views)
		expect(problems.map(problem => problem.kind).sort()).toEqual(['missingVariant', 'missingView', 'missingWidget'])
		expect(problems.every(problem => !problem.blocksSave)).toBe(true)
		expect(flow.steps[CART]!.transitions[0]!.trigger.widgetId).toBe('renamed-submit')
	})

	it('concludes nothing about a View that is still loading', () => {
		const flow = checkout()
		flow.steps[DONE]!.target = { viewId: VIEW_A, variantName: 'gone' }
		expect(validateFlowDraft(flow, new Map([[VIEW_A, 'pending'], [VIEW_B, 'pending']]))).toEqual([])
	})
})

describe('Prototype player (Discussion #6, items 5, 6 and 10c)', () => {
	it('starts at the entry step', () => {
		const state = startPlayback(checkout())
		expect(currentVisit(state).stepId).toBe(CART)
		expect(availableTransitions(checkout(), state).map(item => item.trigger.widgetId)).toEqual(['submit'])
	})

	it('matches only the exact Widget Event identity from the current step', () => {
		const flow = checkout()
		expect(resolveTransition(flow, CART, { widgetId: 'submit', event: 'click' })).toBe(PAY)
		expect(resolveTransition(flow, CART, { widgetId: 'submit', event: 'hover' })).toBeUndefined()
		expect(resolveTransition(flow, CART, { widgetId: 'retry', event: 'click' })).toBeUndefined()
		const state = startPlayback(flow)
		expect(followTrigger(flow, state, { widgetId: 'nope', event: 'click' })).toBe(state)
	})

	it('never resolves an ambiguous trigger by order', () => {
		const flow = checkout()
		flow.steps[PAY]!.transitions.push({ trigger: { widgetId: 'retry', event: 'click' }, targetStepId: DONE })
		expect(resolveTransition(flow, PAY, { widgetId: 'retry', event: 'click' })).toBeUndefined()
	})

	it('gives every step entry a new entry, including returns and restarts, so no prior state is restored', () => {
		const flow = checkout()
		let state = startPlayback(flow)
		state = followTrigger(flow, state, { widgetId: 'submit', event: 'click' })
		state = followTrigger(flow, state, { widgetId: 'retry', event: 'click' })
		state = followTrigger(flow, state, { widgetId: 'back', event: 'click' })
		expect(state.history.map(visit => visit.stepId)).toEqual([CART, PAY, PAY, CART])
		const entries = state.history.map(visit => visit.entry)
		expect(new Set(entries).size).toBe(entries.length)
		expect(state.history[2]!.via).toEqual({ widgetId: 'retry', event: 'click' })
		const restarted = restartPlayback(flow, state)
		expect(restarted.history).toHaveLength(1)
		expect(currentVisit(restarted).stepId).toBe(CART)
		expect(entries).not.toContain(currentVisit(restarted).entry)
	})
})
