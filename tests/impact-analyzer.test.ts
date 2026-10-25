import { describe, expect, it } from 'vitest'

import { renderInputDigest } from '../src/domain/evidence/render-input-digest'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { RENDER_INPUT_CHANGED_REASON } from '../src/domain/evidence/staleness'
import { resourceIdentityKey } from '../src/domain/history/summary'
import { analyzeImpact, bindingReferences, variantImpact, withResource, widgetIds, type ImpactWorkspace } from '../src/domain/impact'

/**
 * The standalone reference-impact analyzer (issue #132 B6, reusable by issue #75): one case per
 * category of Rules 01a11a5e-174b-7e74-b232-5ec76601fbed and 01a11a5e-17a0-7c21-9e23-dd56ef12c9a9.
 */

const VIEW = '11111111-1111-4111-8111-111111111111'
const OTHER_VIEW = '12121212-1212-4121-8121-121212121212'
const FLOW = '22222222-2222-4222-8222-222222222222'
const STEP = '66666666-6666-4666-8666-666666666666'
const ASSET = '33333333-3333-4333-8333-333333333333'
const THREAD = '44444444-4444-4444-8444-444444444444'
const OTHER_THREAD = '45454545-4545-4454-8454-454545454545'
const SUBMISSION = '77777777-7777-4777-8777-777777777777'

function view(widgets: readonly Readonly<Record<string, unknown>>[], extra: Readonly<Record<string, unknown>> = {}) {
	return { id: VIEW, name: 'Checkout', ir: { type: 'RootShell', id: 'root', slots: { content: widgets } }, variants: {}, spec: { decisions: [] }, ...extra }
}

const MANIFEST = {
	schemaVersion: 4,
	i18n: { defaultLocale: 'en-US' },
	adapters: [],
	viewports: { desktop: { dimensions: { width: 1280, height: 800 } }, mobile: { dimensions: { width: 390, height: 844 } } },
	themes: { light: {}, dark: {} },
}

function workspace(overrides: Partial<ImpactWorkspace> = {}): ImpactWorkspace {
	return {
		manifest: MANIFEST,
		views: new Map([[VIEW, view([{ type: 'Button', id: 'pay', config: { label: { $i18n: 'pay' } } }])]]),
		flows: new Map(),
		locales: new Map([['en-US', { pay: 'Pay' }]]),
		assets: new Set([ASSET]),
		reviews: [],
		revisions: new Map([[resourceIdentityKey({ kind: 'view', key: VIEW }), 'r_view_1'], [resourceIdentityKey({ kind: 'locale', key: 'en-US' }), 'r_en_1']]),
		...overrides,
	}
}

function thread(id: string, anchor: unknown, extra: Readonly<Record<string, unknown>> = {}) {
	return { id, anchor, variantNames: [], status: 'open', messages: [], history: [], submissions: [], ...extra }
}

describe('Variants and View references (issue #75)', () => {
	const withVariants = (names: readonly string[], spec: unknown = { decisions: [] }) => view([{ type: 'Button', id: 'pay' }], { variants: Object.fromEntries(names.map(name => [name, { state: {} }])), spec })
	function picture(overrides: Partial<ImpactWorkspace> = {}): ImpactWorkspace {
		return workspace({
			views: new Map<string, unknown>([[VIEW, withVariants(['dark', 'compact'])], [OTHER_VIEW, { ...withVariants([]), id: OTHER_VIEW, spec: { decisions: [], references: [{ type: 'view', viewId: VIEW, variantName: 'dark' }, { type: 'view', viewId: VIEW }, { type: 'external', uri: 'https://example.com' }] } }]]),
			flows: new Map<string, unknown>([[FLOW, { id: FLOW, steps: { [STEP]: { target: { viewId: VIEW, variantName: 'dark' } }, other: { target: { viewId: VIEW } } } }]]),
			reviews: [thread(THREAD, { viewId: VIEW, widgetId: 'pay' }, { variantNames: ['dark', 'compact'], status: 'ready-for-review' }), thread(OTHER_THREAD, { viewId: VIEW, widgetId: 'pay' }, { variantNames: ['compact'] }), thread('55555555-5555-4555-8555-555555555555', { scope: 'workspace' }, { variantNames: ['dark'] })],
			...overrides,
		})
	}

	it('lists the threads, Flow steps and View references that name a Variant that is removed', () => {
		const before = picture()
		const after = withResource(before, { kind: 'view', key: VIEW }, withVariants(['compact']), 'r_view_2')
		expect(variantImpact(before, after)).toEqual([
			{ category: 'review_variant_stale', reviewId: THREAD, reviewStatus: 'ready-for-review', viewId: VIEW, variantNames: ['dark'] },
			{ category: 'flow_step_target_missing', flowId: FLOW, stepId: STEP, viewId: VIEW, missing: 'variant', variantName: 'dark' },
			{ category: 'view_reference_dangling', viewId: OTHER_VIEW, targetViewId: VIEW, missing: 'variant', variantName: 'dark', pointer: '/spec/references/0' },
		])
		expect(analyzeImpact(before, after).filter(item => item.category === 'review_variant_stale')).toHaveLength(1)
	})

	it('lists a rename as the old name removed and says nothing about a Variant nobody names', () => {
		const before = picture()
		const renamed = withResource(before, { kind: 'view', key: VIEW }, withVariants(['night', 'compact']), 'r_view_2')
		expect(variantImpact(before, renamed).map(item => item.category)).toEqual(['review_variant_stale', 'flow_step_target_missing', 'view_reference_dangling'])
		const unnamed = picture({ reviews: [], flows: new Map(), views: new Map<string, unknown>([[VIEW, withVariants(['dark', 'spare'])]]) })
		expect(variantImpact(unnamed, withResource(unnamed, { kind: 'view', key: VIEW }, withVariants(['dark']), 'r_view_2'))).toEqual([])
	})

	it('lists what names a View that is deleted, and skips what already dangled or never resolved', () => {
		const before = picture()
		const after = withResource(before, { kind: 'view', key: VIEW }, undefined, undefined)
		const items = variantImpact(before, after)
		expect(items.filter(item => item.category === 'flow_step_target_missing')).toEqual([
			{ category: 'flow_step_target_missing', flowId: FLOW, stepId: STEP, viewId: VIEW, missing: 'view' },
			{ category: 'flow_step_target_missing', flowId: FLOW, stepId: 'other', viewId: VIEW, missing: 'view' },
		])
		expect(items.filter(item => item.category === 'view_reference_dangling')).toEqual([
			{ category: 'view_reference_dangling', viewId: OTHER_VIEW, targetViewId: VIEW, missing: 'view', pointer: '/spec/references/0' },
			{ category: 'view_reference_dangling', viewId: OTHER_VIEW, targetViewId: VIEW, missing: 'view', pointer: '/spec/references/1' },
		])
		// A thread anchored in the deleted View is reported by its anchor, not as a stale Variant.
		expect(items.some(item => item.category === 'review_variant_stale')).toBe(false)
		expect(analyzeImpact(before, after).filter(item => item.category === 'review_anchor_invalidated')).toHaveLength(2)
		// A dangling reference stays unreported: the View was already gone before.
		expect(variantImpact(after, after)).toEqual([])
	})
})

describe('helpers', () => {
	it('collects Widget ids through slots, the RootShell included', () => {
		expect([...widgetIds(view([{ type: 'Panel', id: 'a', slots: { body: [{ type: 'Text', id: 'b' }, { type: 'Panel', id: 'c', slots: { x: [{ type: 'Text', id: 'd' }] } }] } }]))].sort()).toEqual(['a', 'b', 'c', 'd', 'root'])
		expect([...widgetIds(undefined)]).toEqual([])
	})

	it('counts Widgets as the Preview widget tree does: a node without a string id and type is dropped with its subtree', () => {
		const ids = widgetIds(view([
			{ id: 'untyped', slots: { body: [{ type: 'Text', id: 'under-untyped' }] } },
			{ type: 'Text', id: '' },
			{ type: 'Panel', id: 'kept', slots: { body: [{ type: 'Text', id: 'child' }, 'not a node'] } },
		]))
		expect([...ids].sort()).toEqual(['child', 'kept', 'root'])
		expect([...widgetIds({ ir: { id: 'root', slots: { content: [{ type: 'Text', id: 'orphan' }] } } })]).toEqual([])
	})

	it('stops following nested JSON at the depth bound instead of exhausting the stack', () => {
		let deep: Record<string, unknown> = { $i18n: 'deep' }
		for (let index = 0; index < 100_000; index += 1) deep = { nested: deep }
		const value = view([{ type: 'Text', id: 'shallow', config: { label: { $i18n: 'shallow' }, deep } }])
		expect(() => bindingReferences(value)).not.toThrow()
		expect(bindingReferences(value).map(reference => reference.target)).toEqual(['shallow'])
		let tree: Record<string, unknown> = { type: 'Text', id: 'leaf' }
		for (let index = 0; index < 100_000; index += 1) tree = { type: 'Panel', id: `n${index}`, slots: { body: [tree] } }
		expect(() => widgetIds({ ir: tree })).not.toThrow()
	})

	it('finds $i18n and $asset bindings in the IR and Variants with their pointers', () => {
		const value = view([{ id: 'logo', config: { src: { $asset: ASSET }, 'a/b': { $i18n: 'alt' } } }], { variants: { dark: { state: { logo: { title: { $i18n: 'title' } } } } } })
		expect(bindingReferences(value)).toEqual([
			{ binding: '$asset', target: ASSET, pointer: '/ir/slots/content/0/config/src' },
			{ binding: '$i18n', target: 'alt', pointer: '/ir/slots/content/0/config/a~1b' },
			{ binding: '$i18n', target: 'title', pointer: '/variants/dark/state/logo/title' },
		])
	})
})

describe('analyzeImpact', () => {
	it('reports nothing for an unchanged Workspace', () => {
		const before = workspace({ reviews: [thread(THREAD, { viewId: VIEW, widgetId: 'pay' })] })
		expect(analyzeImpact(before, before)).toEqual([])
	})

	it('lists Review threads whose Widget anchor becomes invalid or valid again, never Workspace threads', () => {
		const reviews = [
			thread(THREAD, { viewId: VIEW, widgetId: 'pay' }),
			thread(OTHER_THREAD, { viewId: VIEW, widgetId: 'note' }, { status: 'resolved' }),
			thread('46464646-4646-4464-8464-464646464646', { scope: 'workspace' }),
		]
		const before = workspace({ reviews })
		const after = withResource(before, { kind: 'view', key: VIEW }, view([{ type: 'Text', id: 'note' }]), 'r_view_2')
		expect(analyzeImpact(before, after)).toEqual([
			{ category: 'review_anchor_invalidated', reviewId: THREAD, reviewStatus: 'open', anchor: { viewId: VIEW, widgetId: 'pay' } },
			{ category: 'review_anchor_revalidated', reviewId: OTHER_THREAD, reviewStatus: 'resolved', anchor: { viewId: VIEW, widgetId: 'note' } },
		])
		// Removing the View (the deletion of issue #75) invalidates every Widget anchor on it.
		expect(analyzeImpact(before, withResource(before, { kind: 'view', key: VIEW }, undefined, undefined)).map(item => item.category)).toEqual(['review_anchor_invalidated'])
	})

	it('lists $i18n references that would dangle: a new binding to a missing key, or a key the default Locale loses', () => {
		const before = workspace()
		const rebound = withResource(before, { kind: 'view', key: VIEW }, view([{ id: 'pay', config: { label: { $i18n: 'pay' }, hint: { $i18n: 'missing' } } }]), 'r_view_2')
		expect(analyzeImpact(before, rebound)).toEqual([{ category: 'i18n_reference_dangling', viewId: VIEW, i18nKey: 'missing', pointers: ['/ir/slots/content/0/config/hint'] }])
		const shrunk = withResource(before, { kind: 'locale', key: 'en-US' }, { other: 'x' }, 'r_en_2')
		expect(analyzeImpact(before, shrunk)).toEqual([{ category: 'i18n_reference_dangling', viewId: VIEW, i18nKey: 'pay', pointers: ['/ir/slots/content/0/config/label'] }])
		// Another Locale losing the key is a missing translation with a fallback, not a dangling reference.
		const withZh = workspace({ locales: new Map([['en-US', { pay: 'Pay' }], ['zh-TW', { pay: '付款' }]]) })
		expect(analyzeImpact(withZh, withResource(withZh, { kind: 'locale', key: 'zh-TW' }, {}, 'r_zh_2'))).toEqual([])
		// A reference that already dangled is not new impact.
		const alreadyDangling = workspace({ locales: new Map() })
		expect(analyzeImpact(alreadyDangling, withResource(alreadyDangling, { kind: 'view', key: VIEW }, view([{ id: 'pay', config: { label: { $i18n: 'pay' } } }], { name: 'Renamed' }), 'r_view_2'))).toEqual([])
		// A settings change of the default Locale is followed too.
		const switched = withResource(before, { kind: 'workspace', key: 'workspace' }, { ...MANIFEST, i18n: { defaultLocale: 'fr-FR' } }, 'r_ws_2')
		expect(analyzeImpact(before, switched).map(item => item.category)).toEqual(['i18n_reference_dangling'])
	})

	it('lists $asset references that would dangle', () => {
		const before = workspace({ views: new Map([[VIEW, view([{ id: 'logo', config: { src: { $asset: ASSET } } }])]]) })
		expect(analyzeImpact(before, withResource(before, { kind: 'asset', key: ASSET }, undefined, undefined))).toEqual([
			{ category: 'asset_reference_dangling', viewId: VIEW, assetId: ASSET, pointers: ['/ir/slots/content/0/config/src'] },
		])
		const missing = '34343434-3434-4343-8343-343434343434'
		const rebound = withResource(before, { kind: 'view', key: VIEW }, view([{ id: 'logo', config: { src: { $asset: missing } } }]), 'r_view_2')
		expect(analyzeImpact(before, rebound)).toEqual([{ category: 'asset_reference_dangling', viewId: VIEW, assetId: missing, pointers: ['/ir/slots/content/0/config/src'] }])
	})

	it('lists UX Flow steps whose trigger Widgets would disappear, from a View change or a Flow change', () => {
		const flow = (widgets: readonly string[], viewId = VIEW) => ({
			id: FLOW,
			name: 'Checkout flow',
			entryStepId: STEP,
			steps: { [STEP]: { target: { viewId }, transitions: widgets.map(widgetId => ({ trigger: { widgetId, event: 'click' }, targetStepId: STEP })) } },
		})
		const before = workspace({ flows: new Map([[FLOW, flow(['pay'])]]) })
		const viewChanged = withResource(before, { kind: 'view', key: VIEW }, view([{ type: 'Button', id: 'cancel' }]), 'r_view_2')
		expect(analyzeImpact(before, viewChanged)).toEqual([{ category: 'flow_step_widget_missing', flowId: FLOW, stepId: STEP, viewId: VIEW, widgetIds: ['pay'] }])
		const flowChanged = withResource(before, { kind: 'flow', key: FLOW }, flow(['pay', 'gone', 'also-gone']), 'r_flow_2')
		expect(analyzeImpact(before, flowChanged)).toEqual([{ category: 'flow_step_widget_missing', flowId: FLOW, stepId: STEP, viewId: VIEW, widgetIds: ['also-gone', 'gone'] }])
		const retargeted = withResource(before, { kind: 'flow', key: FLOW }, flow(['pay'], OTHER_VIEW), 'r_flow_2')
		expect(analyzeImpact(before, retargeted)).toEqual([{ category: 'flow_step_widget_missing', flowId: FLOW, stepId: STEP, viewId: OTHER_VIEW, widgetIds: ['pay'] }])
	})

	it('lists ready-for-review submissions whose named revision stops or starts being current', () => {
		const submitted = (revision: string) => thread(THREAD, { viewId: VIEW, widgetId: 'pay' }, {
			status: 'ready-for-review',
			submissions: [{ id: SUBMISSION, resources: [{ identity: { type: 'view', id: VIEW }, revision }, { identity: { kind: 'locale', key: 'en-US' }, revision: 'r_en_1' }] }],
			history: [{ id: '88888888-8888-4888-8888-888888888888', kind: 'lifecycle', from: 'open', to: 'ready-for-review', submissionId: SUBMISSION }],
		})
		const current = workspace({ reviews: [submitted('r_view_1')] })
		const changed = withResource(current, { kind: 'view', key: VIEW }, view([{ type: 'Button', id: 'pay' }]), 'r_view_2')
		expect(analyzeImpact(current, changed)).toEqual([{ category: 'submission_revision_not_current', reviewId: THREAD, submissionId: SUBMISSION, resource: { kind: 'view', key: VIEW }, revision: 'r_view_1' }])
		const old = workspace({ reviews: [submitted('r_view_0')] })
		const back = withResource(old, { kind: 'view', key: VIEW }, view([{ type: 'Button', id: 'pay' }]), 'r_view_0')
		expect(analyzeImpact(old, back)).toEqual([{ category: 'submission_revision_current', reviewId: THREAD, submissionId: SUBMISSION, resource: { kind: 'view', key: VIEW }, revision: 'r_view_0' }])
		// Open and resolved threads are not ready for review: their submissions are history.
		const open = workspace({ reviews: [{ ...submitted('r_view_1'), status: 'open' }] })
		expect(analyzeImpact(open, withResource(open, { kind: 'view', key: VIEW }, view([{ type: 'Button', id: 'pay' }]), 'r_view_2'))).toEqual([])
	})

	it('lists removed viewport and theme keys with the threads whose render context names them', () => {
		const reviews = [
			thread(THREAD, { viewId: VIEW, widgetId: 'pay' }, { renderContext: { viewportId: 'mobile', themeId: 'dark' } }),
			thread(OTHER_THREAD, { viewId: VIEW, widgetId: 'pay' }, { renderContext: { viewportId: 'desktop' } }),
		]
		const before = workspace({ reviews })
		// A rename: `mobile` becomes `phone`, `dark` is removed.
		const after = withResource(before, { kind: 'workspace', key: 'workspace' }, { ...MANIFEST, viewports: { desktop: MANIFEST.viewports.desktop, phone: MANIFEST.viewports.mobile }, themes: { light: {} } }, 'r_ws_2')
		expect(analyzeImpact(before, after)).toEqual([
			{ category: 'render_key_removed', dimension: 'viewport', key: 'mobile', reviewIds: [THREAD] },
			{ category: 'render_key_removed', dimension: 'theme', key: 'dark', reviewIds: [THREAD] },
		])
	})

	it('lists formal Evidence that would become stale, not Evidence already stale, and not Adapter changes yet', () => {
		const current = renderInputDigest(workspace().views.get(VIEW))
		const record = (viewport: Readonly<{ width: number; height: number }>, digest = current): FormalEvidenceRecord => ({
			schemaVersion: 1,
			kind: 'formal_capture',
			executionContext: { viewId: VIEW, locale: 'en-US', viewportId: 'desktop', viewport, themeId: 'light' },
			coverage: { complete: true },
			provenance: { workspaceSchemaVersion: 4, resources: [{ identity: { type: 'view', id: VIEW }, revision: 'r_view_1' }, { identity: { type: 'locale', id: 'en-US' }, revision: 'r_en_1' }], versions: {}, renderInputDigest: digest },
			artifactRefs: [],
		})
		const fresh = `sha256:${'a'.repeat(64)}`
		const alreadyStale = `sha256:${'b'.repeat(64)}`
		const before = workspace({ evidence: [{ digest: fresh, record: record({ width: 1280, height: 800 }) }, { digest: alreadyStale, record: record({ width: 1280, height: 800 }, `sha256:${'0'.repeat(64)}`) }] })
		const resized = withResource(before, { kind: 'workspace', key: 'workspace' }, { ...MANIFEST, viewports: { ...MANIFEST.viewports, desktop: { dimensions: { width: 1440, height: 900 } } } }, 'r_ws_2')
		expect(analyzeImpact(before, resized)).toEqual([{ category: 'evidence_stale', evidence: fresh, viewId: VIEW, reason: 'Viewport preset \'desktop\' dimensions changed since capture' }])
		// Owner ruling 5 (https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18825439): no Adapter provenance yet.
		const adapters = withResource(before, { kind: 'workspace', key: 'workspace' }, { ...MANIFEST, adapters: [{ moduleSpecifier: './adapters/new.mjs' }] }, 'r_ws_2')
		expect(analyzeImpact(before, adapters)).toEqual([])
		// Rules 01a115cd-c5a5-… and 01a115cd-c749-…: a View restore that changes only its Spec or name
		// leaves its Evidence fresh; one that changes its IR makes it stale.
		const specOnly = withResource(before, { kind: 'view', key: VIEW }, { ...before.views.get(VIEW) as object, name: 'Renamed', spec: { intent: 'Other', decisions: [] } }, 'r_view_2')
		expect(analyzeImpact(before, specOnly)).toEqual([])
		const irChanged = withResource(before, { kind: 'view', key: VIEW }, view([{ type: 'Button', id: 'pay', config: { label: { $i18n: 'pay' } } }, { type: 'Text', id: 'note' }]), 'r_view_2')
		expect(analyzeImpact(before, irChanged)).toContainEqual({ category: 'evidence_stale', evidence: fresh, viewId: VIEW, reason: RENDER_INPUT_CHANGED_REASON })
		// Without Evidence in the picture nothing about Evidence is reported.
		const { evidence: _evidence, ...withoutEvidence } = before
		void _evidence
		expect(analyzeImpact(withoutEvidence, withResource(withoutEvidence, { kind: 'workspace', key: 'workspace' }, resized.manifest, 'r_ws_2'))).toEqual([])
	})

	it('tolerates malformed resources without throwing', () => {
		const before = workspace({
			manifest: 'not an object',
			views: new Map<string, unknown>([[VIEW, null], [OTHER_VIEW, { ir: { slots: { content: 'nope' } } }]]),
			flows: new Map<string, unknown>([[FLOW, { steps: { [STEP]: { target: 5, transitions: 'x' } } }]]),
			reviews: [null, 5, { id: THREAD, anchor: null }, { id: OTHER_THREAD, status: 'ready-for-review', submissions: 'x', history: [null] }],
		})
		const after = withResource(before, { kind: 'view', key: VIEW }, { ir: [] }, 'r')
		expect(() => analyzeImpact(before, after)).not.toThrow()
	})
})
