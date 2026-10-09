import { describe, expect, it } from 'vitest'

import {
	diffAsset,
	diffFlow,
	diffJson,
	diffLocale,
	diffResource,
	diffView,
	diffWorkspaceSettings,
	type AssetFile,
	type AssetFiles,
	type ResourceFiles,
} from '../src/domain/history/diff'
import type { JsonValue } from '../src/domain/validation'

/**
 * Semantic diff per resource kind (Feature 01a11a5d-fd13-7f52-918c-af3a73e5bb6e): one fixture table
 * per kind, each row a before/after pair and the part of the diff it must produce.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const STEP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STEP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STEP_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`

type Json = Record<string, JsonValue>

function widget(id: string, type: string, config: Json = {}, slots?: Record<string, Json[]>): Json {
	return { id, type, config, ...(slots ? { slots } : {}) }
}

function view(overrides: Json = {}, content: Json[] = [widget('title', 'Text', { text: 'Hi' }), widget('cta', 'Button', { label: 'Go' })]): Json {
	return {
		id: VIEW_ID,
		name: 'Checkout',
		feature: 'billing',
		ir: { type: 'RootShell', id: 'root', slots: { content } },
		variants: { empty: { state: { title: { text: 'Nothing yet' } } } },
		spec: { intent: 'Pay', entryConditions: ['Signed in'], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
		...overrides,
	}
}

describe('JSON-pointer structural diff (Rule 01a11a5e-1134-755c-a740-a619a7943fe0)', () => {
	it.each([
		['a replaced leaf', { a: 1 }, { a: 2 }, [{ op: 'replace', path: '/a', before: 1, after: 2 }]],
		['an added member', {}, { b: true }, [{ op: 'add', path: '/b', after: true }]],
		['a removed member', { c: 'x' }, {}, [{ op: 'remove', path: '/c', before: 'x' }]],
		['escaped pointer segments', { 'a/b': { '~': 1 } }, { 'a/b': { '~': 2 } }, [{ op: 'replace', path: '/a~1b/~0', before: 1, after: 2 }]],
		['array items by index', { list: [1, 2] }, { list: [1, 3, 4] }, [{ op: 'replace', path: '/list/1', before: 2, after: 3 }, { op: 'add', path: '/list/2', after: 4 }]],
		['a binding as one reference', { label: { $i18n: 'a' } }, { label: { $i18n: 'b' } }, [{ op: 'replace', path: '/label', before: { $i18n: 'a' }, after: { $i18n: 'b' } }]],
		['no change whatever the member order', { a: 1, b: 2 }, { b: 2, a: 1 }, []],
	] as const)('reports %s', (_name, before, after, expected) => {
		expect(diffJson(before as JsonValue, after as JsonValue)).toEqual(expected)
	})
})

describe('View semantic diff', () => {
	it.each<[string, Json, Json, (diff: ReturnType<typeof diffView>) => void]>([
		['a Widget added and one removed (Rule 01a11a5e-0e37-754b-bea2-a15716749c0c)', view(), view({}, [widget('title', 'Text', { text: 'Hi' }), widget('help', 'Link')]), (diff) => {
			expect(diff.widgets!.added).toEqual([{ id: 'help', type: 'Link', position: { parent: 'root', slot: 'content', index: 1 } }])
			expect(diff.widgets!.removed).toEqual([{ id: 'cta', type: 'Button', position: { parent: 'root', slot: 'content', index: 1 } }])
			expect(diff.widgets!.moved).toEqual([])
		}],
		['a Widget moved to another parent and Slot', view({}, [widget('title', 'Text'), widget('row', 'Stack', {}, { content: [widget('cta', 'Button')] })]), view({}, [widget('title', 'Text'), widget('row', 'Stack', {}, { footer: [widget('cta', 'Button')] })]), (diff) => {
			expect(diff.widgets!.moved).toEqual([{ id: 'cta', type: 'Button', before: { parent: 'row', slot: 'content', index: 0 }, after: { parent: 'row', slot: 'footer', index: 0 } }])
		}],
		['a Widget moved to another index among the siblings it kept', view({}, [widget('a', 'Text'), widget('b', 'Text'), widget('c', 'Text')]), view({}, [widget('c', 'Text'), widget('a', 'Text'), widget('b', 'Text')]), (diff) => {
			expect(diff.widgets!.moved.map(item => [item.id, item.before?.index, item.after?.index])).toEqual([['c', 2, 0]])
		}],
		['siblings that only shifted beside an insertion are not moved', view({}, [widget('a', 'Text'), widget('b', 'Text')]), view({}, [widget('new', 'Text'), widget('a', 'Text'), widget('b', 'Text')]), (diff) => {
			expect(diff.widgets!.added.map(item => item.id)).toEqual(['new'])
			expect(diff.widgets!.moved).toEqual([])
		}],
		['a type change and config changes as JSON pointers', view(), view({}, [widget('title', 'Heading', { text: 'Hi', level: 2 }), widget('cta', 'Button', { label: 'Pay now' })]), (diff) => {
			expect(diff.widgets!.typeChanged).toEqual([{ id: 'title', before: 'Text', after: 'Heading' }])
			expect(diff.widgets!.configChanged).toEqual([
				{ id: 'title', type: 'Heading', changes: [{ op: 'add', path: '/config/level', after: 2 }] },
				{ id: 'cta', type: 'Button', changes: [{ op: 'replace', path: '/config/label', before: 'Go', after: 'Pay now' }] },
			])
		}],
		['bindings as references, not resolved values (Rule 01a11a5e-0e8d-7d8a-84f1-3195ac7719e7)', view({}, [widget('logo', 'Image', { src: { $asset: 'old' }, alt: { $i18n: 'logo.alt' } })]), view({}, [widget('logo', 'Image', { src: { $asset: 'new' }, alt: 'Logo' })]), (diff) => {
			expect(diff.widgets!.configChanged[0]!.changes).toEqual([
				{ op: 'replace', path: '/config/alt', before: { $i18n: 'logo.alt' }, after: 'Logo' },
				{ op: 'replace', path: '/config/src', before: { $asset: 'old' }, after: { $asset: 'new' } },
			])
		}],
		['Variants, State overrides, name and feature (Rule 01a11a5e-0edf-7ea0-8d15-cc2a028d2a14)', view(), view({
			name: 'Pay',
			variants: { empty: { state: { title: { text: 'Still nothing' }, cta: { disabled: true } } }, error: { state: {} } },
		}), (diff) => {
			expect(diff.name).toEqual({ before: 'Checkout', after: 'Pay' })
			expect(diff.feature).toBeUndefined()
			expect(diff.variants.added).toEqual(['error'])
			expect(diff.variants.removed).toEqual([])
			expect(diff.variants.stateChanged).toEqual([
				{ variant: 'empty', widgetId: 'cta', changes: [{ op: 'add', path: '', after: { disabled: true } }] },
				{ variant: 'empty', widgetId: 'title', changes: [{ op: 'replace', path: '/text', before: 'Nothing yet', after: 'Still nothing' }] },
			])
		}],
		['a removed Variant and a removed feature tag', view(), view({ variants: {}, feature: undefined as unknown as JsonValue }), (diff) => {
			expect(diff.variants.removed).toEqual(['empty'])
			expect(diff.feature).toEqual({ before: 'billing' })
		}],
		['Spec items per section (Rule 01a11a5e-0f31-7635-aeb2-16a1e9673b20)', view(), view({
			spec: { intent: 'Pay fast', entryConditions: ['Has a cart'], interactionRules: ['Enter submits'], constraints: [], accessibility: [], references: [{ type: 'external', uri: 'https://example.com' }], decisions: [] },
		}), (diff) => {
			expect(diff.spec.intent).toEqual({ before: 'Pay', after: 'Pay fast' })
			expect(diff.spec.sections).toEqual([
				{ section: 'entryConditions', added: ['Has a cart'], removed: ['Signed in'] },
				{ section: 'interactionRules', added: ['Enter submits'], removed: [] },
				{ section: 'references', added: [{ type: 'external', uri: 'https://example.com' }], removed: [] },
			])
		}],
		['a reordered Spec section', view({ spec: { intent: '', entryConditions: ['a', 'b'], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] } }), view({ spec: { intent: '', entryConditions: ['b', 'a'], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] } }), (diff) => {
			expect(diff.spec.sections).toEqual([{ section: 'entryConditions', added: [], removed: [], reordered: true }])
		}],
		['Decisions by id with status and outcome changes', view({ spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [
			{ id: 'd1', question: 'Card or wallet?', status: 'pending', history: [] },
			{ id: 'd2', question: 'Remove?', status: 'pending', history: [] },
		] } }), view({ spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [
			{ id: 'd3', question: 'New?', status: 'pending', history: [] },
			{ id: 'd1', question: 'Card or wallet?', status: 'decided', outcome: { summary: 'Both', rationale: 'Reach' }, history: [{ at: '2026-10-09T00:00:00.000Z', before: { status: 'pending' }, after: { status: 'decided' } }] },
		] } }), (diff) => {
			expect(diff.spec.decisions.added).toEqual([{ id: 'd3', question: 'New?', status: 'pending' }])
			expect(diff.spec.decisions.removed).toEqual([{ id: 'd2', question: 'Remove?', status: 'pending' }])
			expect(diff.spec.decisions.changed).toEqual([{
				id: 'd1',
				status: { before: 'pending', after: 'decided' },
				outcome: { after: { summary: 'Both', rationale: 'Reach' } },
				otherChanges: [{ op: 'add', path: '/history/0', after: { at: '2026-10-09T00:00:00.000Z', before: { status: 'pending' }, after: { status: 'decided' } } }],
			}])
			// A reordered Decision list is not a Decision change.
			expect(diff.spec.sections).toEqual([])
		}],
		['an IR that cannot be matched by id falls back to JSON pointers', view(), view({}, [widget('title', 'Text'), widget('title', 'Text')]), (diff) => {
			expect(diff.widgets).toBeUndefined()
			expect(diff.irChanges!.length).toBeGreaterThan(0)
			expect(diff.irChanges!.every(change => change.path.startsWith('/slots/content/'))).toBe(true)
		}],
	])('reports %s', (_name, before, after, check) => {
		check(diffView(before, after))
	})

	it('reports nothing for two equal Views', () => {
		expect(diffView(view(), view())).toEqual({
			type: 'view',
			widgets: { added: [], removed: [], moved: [], typeChanged: [], configChanged: [] },
			variants: { added: [], removed: [], stateChanged: [], otherChanged: [] },
			spec: { sections: [], decisions: { added: [], removed: [], changed: [] } },
		})
	})

	it('lists every Widget of a View that did not exist before as added', () => {
		expect(diffView(undefined, view()).widgets!.added.map(item => item.id)).toEqual(['root', 'title', 'cta'])
	})
})

describe('Flow semantic diff (Rule 01a11a5e-0f87-7bc0-b557-4f0b0b4886a3)', () => {
	const toB = { trigger: { widgetId: 'cta', event: 'click' }, targetStepId: STEP_B }
	const toC = { trigger: { widgetId: 'cta', event: 'click' }, targetStepId: STEP_C }
	const flow = (overrides: Json = {}): Json => ({
		id: VIEW_ID,
		name: 'Pay',
		entryStepId: STEP_A,
		steps: {
			[STEP_A]: { target: { viewId: VIEW_ID }, transitions: [toB] },
			[STEP_B]: { target: { viewId: VIEW_ID, variantName: 'empty' }, transitions: [] },
		},
		...overrides,
	})

	it.each<[string, Json, (diff: ReturnType<typeof diffFlow>) => void]>([
		['the entry step change', flow({ entryStepId: STEP_B }), (diff) => {
			expect(diff.entryStepId).toEqual({ before: STEP_A, after: STEP_B })
		}],
		['steps added and removed by key', flow({ steps: { [STEP_A]: { target: { viewId: VIEW_ID }, transitions: [toB] }, [STEP_C]: { target: { viewId: VIEW_ID }, transitions: [] } } }), (diff) => {
			expect(diff.steps!.added).toEqual([{ stepId: STEP_C, step: { target: { viewId: VIEW_ID }, transitions: [] } }])
			expect(diff.steps!.removed.map(item => item.stepId)).toEqual([STEP_B])
		}],
		['transition and target changes per step', flow({ steps: {
			[STEP_A]: { target: { viewId: VIEW_ID }, transitions: [toC] },
			[STEP_B]: { target: { viewId: VIEW_ID }, transitions: [] },
		} }), (diff) => {
			expect(diff.steps!.changed).toEqual([
				{ stepId: STEP_A, transitions: { added: [toC], removed: [toB] } },
				{ stepId: STEP_B, target: { before: { viewId: VIEW_ID, variantName: 'empty' }, after: { viewId: VIEW_ID } } },
			])
		}],
		['other Flow members structurally', flow({ name: 'Pay v2', scenarioRef: { source: 'spec' } }), (diff) => {
			expect(diff.name).toEqual({ before: 'Pay', after: 'Pay v2' })
			expect(diff.otherChanges).toEqual([{ op: 'add', path: '/scenarioRef', after: { source: 'spec' } }])
		}],
	])('reports %s', (_name, after, check) => {
		check(diffFlow(flow(), after))
	})
})

describe('Locale semantic diff (Rule 01a11a5e-0fd9-7b50-a7c1-41a3091d9e0d)', () => {
	it.each<[string, JsonValue | undefined, JsonValue | undefined, ReturnType<typeof diffLocale>]>([
		['keys added, removed and changed', { a: 'A', b: 'B' }, { b: 'Bee', c: 'C' }, { type: 'locale', messages: { added: [{ key: 'c', value: 'C' }], removed: [{ key: 'a', value: 'A' }], changed: [{ key: 'b', before: 'B', after: 'Bee' }] } }],
		['a Locale file added', undefined, { a: 'A' }, { type: 'locale', messages: { added: [{ key: 'a', value: 'A' }], removed: [], changed: [] } }],
		['a Locale that is not a flat object, structurally', ['x'], { a: 'A' }, { type: 'locale', changes: [{ op: 'replace', path: '', before: ['x'], after: { a: 'A' } }] }],
	])('reports %s', (_name, before, after, expected) => {
		expect(diffLocale(before, after)).toEqual(expected)
	})
})

describe('Workspace settings diff (Rules 01a11a5e-102f-7caa-b63f-d7c6fb5189c0 and 01a11a5e-1085-71ec-ac82-d60263ae8173)', () => {
	const manifest = (overrides: Json = {}): Json => ({
		schemaVersion: 4,
		i18n: { defaultLocale: 'en-US' },
		adapters: [{ moduleSpecifier: './adapters/a.ts' }, { moduleSpecifier: '@x/b', config: { dense: false } }],
		viewports: { desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } } },
		themes: { light: { label: 'Light' }, dark: { label: 'Dark' } },
		...overrides,
	})

	it.each<[string, Json, ReturnType<typeof diffWorkspaceSettings>]>([
		['only a schemaVersion change: nothing', manifest({ schemaVersion: 3 }), { type: 'workspace' }],
		['the default Locale', manifest({ schemaVersion: 3, i18n: { defaultLocale: 'zh-TW' } }), { type: 'workspace', defaultLocale: { before: 'en-US', after: 'zh-TW' } }],
		['viewports and themes by key', manifest({
			viewports: { desktop: { label: 'Desktop', dimensions: { width: 1440, height: 900 } }, mobile: { label: 'Mobile', dimensions: { width: 390, height: 844 } } },
			themes: { light: { label: 'Light' } },
		}), {
			type: 'workspace',
			viewports: {
				added: [{ key: 'mobile', value: { label: 'Mobile', dimensions: { width: 390, height: 844 } } }],
				removed: [],
				changed: [{ key: 'desktop', changes: [{ op: 'replace', path: '/dimensions/height', before: 800, after: 900 }, { op: 'replace', path: '/dimensions/width', before: 1280, after: 1440 }] }],
			},
			themes: { added: [], removed: [{ key: 'dark', value: { label: 'Dark' } }], changed: [] },
		}],
		['Adapters by member', manifest({ adapters: [{ moduleSpecifier: '@x/b', config: { dense: true } }, { moduleSpecifier: './adapters/a.ts' }, { moduleSpecifier: '@y/c' }] }), {
			type: 'workspace',
			adapters: {
				added: [{ moduleSpecifier: '@y/c', adapter: { moduleSpecifier: '@y/c' } }],
				removed: [],
				changed: [{ moduleSpecifier: '@x/b', changes: [{ op: 'replace', path: '/config/dense', before: false, after: true }] }],
				reordered: true,
			},
		}],
		['other members structurally, never schemaVersion', manifest({ schemaVersion: 5, extra: 1 }), { type: 'workspace', otherChanges: [{ op: 'add', path: '/extra', after: 1 }] }],
		['a member of another shape structurally, never schemaVersion', manifest({ schemaVersion: 2, themes: ['dark'] }), {
			type: 'workspace',
			otherChanges: [{ op: 'replace', path: '/themes', before: { dark: { label: 'Dark' }, light: { label: 'Light' } }, after: ['dark'] }],
		}],
	])('reports %s', (_name, after, expected) => {
		expect(diffWorkspaceSettings(manifest(), after)).toEqual(expected)
	})

	it('never names schemaVersion, even in the structural fallback of a manifest that is not an object', () => {
		const diff = diffWorkspaceSettings(manifest(), ['not', 'a', 'manifest'])
		expect(JSON.stringify(diff)).not.toContain('schemaVersion')
	})
})

describe('Asset semantic diff (Rule 01a11a5e-10df-795e-8fbc-a99de09694a5)', () => {
	const files = (metadata: Json, content: Record<string, string>): AssetFiles => new Map<string, AssetFile>([
		['asset.json', { digest: `sha256:${'0'.repeat(64)}`, bytes: new TextEncoder().encode(JSON.stringify(metadata)) }],
		...Object.entries(content).map(([name, digest]) => [name, { digest }] as const),
	])
	const meta = (overrides: Json = {}): Json => ({ id: VIEW_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png', ...overrides })

	it.each<[string, AssetFiles | undefined, AssetFiles | undefined, ReturnType<typeof diffAsset>]>([
		['a replaced image: content digest and before/after images', files(meta(), { 'logo.png': DIGEST_A }), files(meta(), { 'logo.png': DIGEST_B }), {
			type: 'asset',
			content: { before: DIGEST_A, after: DIGEST_B },
			image: { before: { digest: DIGEST_A, mediaType: 'image/png' }, after: { digest: DIGEST_B, mediaType: 'image/png' } },
		}],
		['metadata changes as JSON pointers', files(meta(), { 'logo.png': DIGEST_A }), files(meta({ name: 'Brand logo' }), { 'logo.png': DIGEST_A }), {
			type: 'asset',
			metadata: [{ op: 'replace', path: '/name', before: 'Logo', after: 'Brand logo' }],
			image: { before: { digest: DIGEST_A, mediaType: 'image/png' }, after: { digest: DIGEST_A, mediaType: 'image/png' } },
		}],
		['no image for a media type that is not an image', files(meta({ contentFilename: 'a.bin', mediaType: 'application/octet-stream' }), { 'a.bin': DIGEST_A }), files(meta({ contentFilename: 'a.bin', mediaType: 'application/octet-stream' }), { 'a.bin': DIGEST_B }), {
			type: 'asset',
			content: { before: DIGEST_A, after: DIGEST_B },
		}],
		['an added Asset', undefined, files(meta(), { 'logo.png': DIGEST_B }), {
			type: 'asset',
			metadata: [{ op: 'add', path: '', after: meta() }],
			content: { after: DIGEST_B },
			image: { after: { digest: DIGEST_B, mediaType: 'image/png' } },
		}],
	])('reports %s', (_name, before, after, expected) => {
		expect(diffAsset(before, after)).toEqual(expected)
	})
})

describe('diffResource dispatch', () => {
	const json = (path: string, value: unknown): ResourceFiles => new Map([[path, { digest: DIGEST_A, bytes: new TextEncoder().encode(JSON.stringify(value)) }]])

	it('lists an unknown resource kind without a diff (open kind set)', () => {
		expect(diffResource('mystery', json('mystery/x.json', { a: 1 }), json('mystery/x.json', { a: 2 }))).toEqual({ type: 'unsupported_kind' })
	})

	it('falls back to JSON pointers for a known kind without a semantic diff', () => {
		expect(diffResource('product-kit', json('.uiux/product-kit.json', { a: 1 }), json('.uiux/product-kit.json', { a: 2 })))
			.toEqual({ type: 'structural', changes: [{ op: 'replace', path: '/a', before: 1, after: 2 }] })
	})

	it('falls back to JSON pointers for a View that is not an object, and to digests for a file that is not JSON', () => {
		expect(diffResource('view', json(`views/${VIEW_ID}.view.json`, [1]), json(`views/${VIEW_ID}.view.json`, [2])))
			.toEqual({ type: 'structural', changes: [{ op: 'replace', path: '/0', before: 1, after: 2 }] })
		const broken: ResourceFiles = new Map([[`views/${VIEW_ID}.view.json`, { digest: DIGEST_B, bytes: new TextEncoder().encode('{') }]])
		expect(diffResource('view', json(`views/${VIEW_ID}.view.json`, {}), broken))
			.toEqual({ type: 'opaque', files: [{ path: `views/${VIEW_ID}.view.json`, before: DIGEST_A, after: DIGEST_B }] })
	})

	it('dispatches each known kind to its semantic diff', () => {
		expect(diffResource('view', json('v', view()), json('v', view({ name: 'X' }))).type).toBe('view')
		expect(diffResource('flow', json('f', {}), json('f', { name: 'X' })).type).toBe('flow')
		expect(diffResource('locale', json('l', {}), json('l', { a: 'b' })).type).toBe('locale')
		expect(diffResource('workspace', json('w', { schemaVersion: 3 }), json('w', { schemaVersion: 4 }))).toEqual({ type: 'workspace' })
	})
})
