import { describe, expect, it } from 'vitest'
import { deriveViewFlowUsage, type FlowUsageSource } from '../app/utils/view-flow-usage'

const VIEW = '00000000-0000-4000-8000-0000000000a1'
const OTHER = '00000000-0000-4000-8000-0000000000b1'
const S1 = '00000000-0000-4000-8000-000000000011'
const S2 = '00000000-0000-4000-8000-000000000012'
const S3 = '00000000-0000-4000-8000-000000000013'

function flow(key: string, name: string, steps: Record<string, { viewId: string; variantName?: string; to?: string[] }>, entry: string, diagnostics: FlowUsageSource['diagnostics'] = []): FlowUsageSource {
	return {
		key,
		name,
		diagnostics,
		resource: {
			id: key,
			name,
			entryStepId: entry,
			steps: Object.fromEntries(Object.entries(steps).map(([id, step]) => [id, {
				target: { viewId: step.viewId, ...(step.variantName === undefined ? {} : { variantName: step.variantName }) },
				transitions: (step.to ?? []).map(targetStepId => ({ trigger: { widgetId: 'w', event: 'click' }, targetStepId })),
			}])),
		},
	}
}

describe('deriveViewFlowUsage (issue #115)', () => {
	it('lists the Flows whose steps target the View, with reading-order numbers and Variant names', () => {
		const usage = deriveViewFlowUsage(VIEW, [
			flow('f1', 'Checkout', { [S1]: { viewId: OTHER, to: [S2] }, [S2]: { viewId: VIEW, variantName: 'error', to: [S3] }, [S3]: { viewId: VIEW } }, S1),
			flow('f2', 'Elsewhere', { [S1]: { viewId: OTHER } }, S1),
		])
		expect(usage.unreadable).toEqual([])
		expect(usage.flows).toEqual([{
			flowKey: 'f1',
			name: 'Checkout',
			diagnostics: [],
			steps: [{ stepId: S2, ordinal: 2, variantName: 'error' }, { stepId: S3, ordinal: 3 }],
		}])
	})

	it('lists a Flow once however many of its steps use the View, and counts each step once', () => {
		const usage = deriveViewFlowUsage(VIEW, [
			flow('f1', 'Loop', { [S1]: { viewId: VIEW, to: [S1, S2] }, [S2]: { viewId: VIEW, variantName: 'error' } }, S1),
		])
		expect(usage.flows).toHaveLength(1)
		expect(usage.flows[0]!.steps.map(step => step.stepId)).toEqual([S1, S2])
	})

	it('reports an empty usage for a View no Flow steps through', () => {
		expect(deriveViewFlowUsage(VIEW, [])).toEqual({ flows: [], unreadable: [] })
		expect(deriveViewFlowUsage(VIEW, [flow('f1', 'Other', { [S1]: { viewId: OTHER } }, S1)]).flows).toEqual([])
	})

	it('keeps an invalid Flow with its diagnostics and names a Flow that cannot be read', () => {
		const diagnostic = { code: 'flow.dangling_entry_step', path: '/entryStepId', message: 'entryStepId must identify a step in this Flow.' }
		const usage = deriveViewFlowUsage(VIEW, [
			flow('bad', 'Bad entry', { [S1]: { viewId: VIEW } }, S2, [diagnostic]),
			{ key: 'gone', name: 'Unreadable', diagnostics: [diagnostic], resource: undefined },
		])
		expect(usage.flows).toEqual([{ flowKey: 'bad', name: 'Bad entry', diagnostics: [diagnostic], steps: [{ stepId: S1, ordinal: 1 }] }])
		expect(usage.unreadable).toEqual([{ flowKey: 'gone', name: 'Unreadable', diagnostics: [diagnostic] }])
	})
})
