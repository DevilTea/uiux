import { describe, expect, it } from 'vitest'
import { deriveWidgetTree } from '../src/preview/widget-tree'
import type { DecisionRead, ViewRead } from '../app/composables/workbench-types'
import {
	actorInitials,
	decisionChangedAt,
	decisionSourceThread,
	findIrNode,
	isAbsoluteUri,
	normalizeList,
	referenceDraftOf,
	referenceFromDraft,
	specContentOf,
	splitWidgetMentions,
	truncateMiddle,
	variantDiagnostics,
	variantOverrides,
	widgetAncestry,
	widgetLabelSource,
	withSpecSection,
} from '../app/utils/widget-inspection'

const IR = {
	id: 'root',
	type: 'RootShell',
	slots: {
		content: [{
			id: 'form',
			type: 'Stack',
			slots: {
				content: [
					{ id: 'title', type: 'Text', config: { text: 'Pay' } },
					{ id: 'checkout-submit', type: 'Button', config: { label: { $i18n: 'pay.cta' } } },
				],
			},
		}],
	},
}

function view(overrides: Partial<{ variants: ViewRead['resource']['variants']; diagnostics: ViewRead['diagnostics'] }> = {}): ViewRead {
	return {
		kind: 'view',
		key: 'v1',
		revision: 'r1',
		diagnostics: overrides.diagnostics ?? [],
		resource: {
			id: 'v1',
			name: 'Checkout',
			ir: IR,
			variants: overrides.variants ?? {},
			spec: {
				intent: 'Retry a payment.',
				entryConditions: ['Arrives after a decline.'],
				interactionRules: [],
				constraints: [],
				accessibility: [],
				references: [{ type: 'external', uri: 'https://example.com/prd', label: 'PRD' }],
				decisions: [],
			},
		},
	} as unknown as ViewRead
}

describe('Inspector derivations', () => {
	it('walks the slot path from the root to a Widget', () => {
		const tree = deriveWidgetTree(IR)
		if (tree.status !== 'valid') throw new Error('fixture IR is invalid')
		expect(widgetAncestry(tree.root, 'checkout-submit').map(node => node.id)).toEqual(['root', 'form', 'checkout-submit'])
		expect(widgetAncestry(tree.root, 'missing')).toEqual([])
		expect(findIrNode(IR, 'checkout-submit')?.type).toBe('Button')
	})

	it('reads a label as literal text or as a Locale message key', () => {
		expect(widgetLabelSource(findIrNode(IR, 'title'))).toEqual({ kind: 'text', value: 'Pay' })
		expect(widgetLabelSource(findIrNode(IR, 'checkout-submit'))).toEqual({ kind: 'message', key: 'pay.cta' })
		expect(widgetLabelSource(findIrNode(IR, 'form'))).toBeUndefined()
	})

	it('lists the Variant overrides of one Widget and the Variant faults', () => {
		const read = view({
			variants: { 'error-state': { state: { 'checkout-submit': { disabled: true, label: 'Retry' } } } },
			diagnostics: [
				{ code: 'variant.state_not_author_writable', path: '/variants/error-state/state/checkout-submit/label', message: 'x' },
				{ code: 'other', path: '/variants/error-state-2', message: 'y' },
			],
		})
		expect(variantOverrides(read, 'error-state', 'checkout-submit')).toEqual([{ property: 'disabled', value: true }, { property: 'label', value: 'Retry' }])
		expect(variantOverrides(read, undefined, 'checkout-submit')).toEqual([])
		expect(variantDiagnostics(read, 'error-state').map(item => item.code)).toEqual(['variant.state_not_author_writable'])
	})

	it('keeps both ends of long identities and derives initials', () => {
		expect(truncateMiddle('r_7ooU8uCG4aR0xv-lK8abcdef', 13)).toBe('r_7ooU…abcdef')
		expect(truncateMiddle('short')).toBe('short')
		expect(actorInitials('Mei Lin')).toBe('ML')
		expect(actorInitials('reviewer')).toBe('R')
		expect(actorInitials('')).toBe('?')
	})
})

describe('Spec derivations', () => {
	it('turns #widget mentions of known Widgets into selectable segments only', () => {
		const ids = new Set(['checkout-submit', 'a'])
		expect(splitWidgetMentions('Selecting #checkout-submit retries; #unknown and a#a stay text. #a.', ids)).toEqual([
			{ kind: 'text', text: 'Selecting ' },
			{ kind: 'widget', text: '#checkout-submit', widgetId: 'checkout-submit' },
			{ kind: 'text', text: ' retries; #unknown and a#a stay text. ' },
			{ kind: 'widget', text: '#a', widgetId: 'a' },
			{ kind: 'text', text: '.' },
		])
	})

	it('finds the Review thread a Decision came from', () => {
		const decision = { id: 'd', question: 'q', status: 'decided', history: [{ at: '2026-10-01T00:00:00Z', source: { reviewId: 'from-history' } }] } as DecisionRead
		expect(decisionSourceThread(decision)).toBe('from-history')
		expect(decisionSourceThread({ ...decision, provenance: { sourceReviewThreadId: 'from-provenance' } } as DecisionRead)).toBe('from-provenance')
		expect(decisionSourceThread({ ...decision, history: [] })).toBeUndefined()
		expect(decisionChangedAt(decision)).toBe('2026-10-01T00:00:00Z')
	})

	it('replaces one section and sends every other section exactly as read', () => {
		const content = specContentOf(view())
		const next = withSpecSection(content, 'constraints', normalizeList(['  Keep the address. ', '', ' ']))
		expect(next).toEqual({ ...content, constraints: ['Keep the address.'] })
		expect(next).not.toHaveProperty('decisions')
	})

	it('serializes reference drafts without empty optional fields', () => {
		expect(referenceFromDraft({ type: 'external', uri: ' https://example.com ', label: '', relation: ' design ' }))
			.toEqual({ type: 'external', uri: 'https://example.com', relation: 'design' })
		expect(referenceFromDraft({ type: 'view', viewId: 'v2', variantName: '', relation: '' })).toEqual({ type: 'view', viewId: 'v2' })
		expect(referenceDraftOf({ type: 'external', uri: 'https://x.test', label: 'X' })).toEqual({ type: 'external', uri: 'https://x.test', label: 'X', relation: '' })
		expect(isAbsoluteUri('https://example.com/a')).toBe(true)
		expect(isAbsoluteUri('example.com')).toBe(false)
	})
})
