import { describe, expect, it } from 'vitest'
import { createWidgetPlugin } from '@deviltea/widget-core'
import { defineComponent, h } from 'vue'

import { resolveWorkspaceAdapterSet } from '../src/adapters'
import type { AdapterManifest, AdapterWidgetCatalogEntry } from '../src/domain/adapters/schema'
import { validateFormalEvidenceRecord, validateTranslationMissingOccurrence } from '../src/domain/evidence/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import type { TranslationResult } from '../src/domain/i18n/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { createTranslationRuntime, UIUX_STRING_VALUE_CONTRACT, UIUX_TRANSLATION_RESULT_VALUE_CONTRACT } from '../src/i18n'
import { evaluateTranslationProperties } from '../src/preview/translation-evaluation'
import {
	createRootShellPlugin, createRootShellRenderer, LiveViewRuntimeController, materializeRuntimeAdapterBundle,
} from '../src/runtime'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'

interface LabelInterfaces {
	config: {
		raw: { readonly title?: string; readonly titleKey?: string }
		resolved: { readonly titleKey: string | null }
	}
	properties: { titleResult: TranslationResult; label: string }
}

/** `boom` makes the result Property throw and `shape` makes it return something that is not a TranslationResult. */
const labelPlugin = createWidgetPlugin('Label')
	.description('Translation evaluation fixture')
	.interfaces<LabelInterfaces>()
	.config({
		description: 'Label config',
		schema: {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			properties: { title: { type: 'string' }, titleKey: { type: 'string' } },
			additionalProperties: false,
		},
		validate: (input): input is LabelInterfaces['config']['raw'] => input === undefined || input === null || (typeof input === 'object' && !Array.isArray(input)),
		resolve: raw => ({ titleKey: raw?.titleKey ?? null }),
	})
	.properties(properties => properties
		.titleResult({
			valueContract: UIUX_TRANSLATION_RESULT_VALUE_CONTRACT,
			registerDeps: ({ dep }) => ({
				t: dep.root.methods.invoke('t').validate((value): value is TranslationResult => typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string'),
			}),
			compute: ({ config, deps }) => {
				if (config.titleKey === null) return { text: '', warnings: [] }
				if (config.titleKey === 'boom') throw new Error('the Adapter t exploded')
				if (config.titleKey === 'shape') return { text: 5, warnings: [] } as unknown as TranslationResult
				const translated = deps.t(config.titleKey, {})
				return translated.ok && translated.value ? translated.value : { text: '', warnings: [] }
			},
		})
		.label({
			valueContract: UIUX_STRING_VALUE_CONTRACT,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('titleResult') }),
			compute: ({ deps }) => {
				const result = deps.result()
				return result.ok ? result.value?.text ?? '' : ''
			},
		}))
	.done()

const labelCatalog: AdapterWidgetCatalogEntry = {
	i18n: { fields: { title: { configField: 'titleKey', resultProperty: 'titleResult', textProperty: 'label' } } },
}

const RESOURCES = new Map<string, Readonly<Record<string, string>>>([
	['en-US', { greeting: 'Hello', farewell: 'Goodbye', onlyEnglish: 'Only in English' }],
	['zh-TW', { greeting: '哈囉', farewell: '再見' }],
])

async function bundle() {
	const state = createTranslationRuntime('en-US', RESOURCES)
	if (state.state !== 'ready') throw new Error('translation runtime is blocked')
	const rootShell = createRootShellPlugin(state.runtime)
	const manifest: AdapterManifest = {
		id: 'fixture', apiVersion: 'test', widgetPlugins: ['Label'],
		catalog: { widgets: { Label: labelCatalog } }, renderers: ['Label'], providers: [],
	}
	const resolved = await resolveWorkspaceAdapterSet({
		workspaceRoot: '/fixture',
		adapters: [{ moduleSpecifier: '@fixture/adapter' }],
		resolver: { async resolve(_root, moduleSpecifier) { return { moduleSpecifier, resolvedPath: '/fixture/adapter.mjs', moduleIdentity: 'file:///fixture/adapter.mjs' } } },
		loader: { async loadManifest() { return manifest } },
		apiCompatibility: { isCompatible() { return true } },
		registryInspector: { async inspect() { return { widgetTypes: ['Label'], rendererKeys: ['Label'] } } },
	})
	if (resolved.state !== 'valid') throw new Error(JSON.stringify(resolved.diagnostics))
	const materialized = await materializeRuntimeAdapterBundle({
		set: resolved.set, rootShellPlugin: rootShell, rootShellRenderer: createRootShellRenderer(rootShell),
		decoder: {
			async decodePlugin() { return labelPlugin },
			async decodeRenderer() { return { type: 'Label', component: defineComponent({ name: 'LabelRenderer', setup: () => () => h('span') }) } },
		},
	})
	if (materialized.state !== 'ready') throw new Error(JSON.stringify(materialized.diagnostics))
	return materialized.bundle
}

function label(id: string, key: string): Record<string, unknown> {
	return { id, type: 'Label', config: { title: { $i18n: key } } }
}

function view(children: readonly Record<string, unknown>[], variants: ViewResource['variants'] = {}): ViewResource {
	return {
		id: VIEW_ID, name: 'Evaluation fixture',
		ir: { type: 'RootShell', id: 'root', slots: { content: children } } as never,
		variants,
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

function context(overrides: Partial<ResolvedRenderContext> = {}): ResolvedRenderContext {
	return { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light', ...overrides }
}

async function evaluate(resource: ViewResource, renderContext: ResolvedRenderContext, runtimeView: ViewResource = resource, catalog?: ReadonlyMap<string, AdapterWidgetCatalogEntry>) {
	const adapters = await bundle()
	const controller = LiveViewRuntimeController.create({ view: runtimeView, adapters, context: renderContext })
	if (!(controller instanceof LiveViewRuntimeController)) throw new Error(JSON.stringify(controller))
	try {
		return evaluateTranslationProperties({
			view: resource,
			runtime: controller.runtime,
			catalogByType: catalog ?? adapters.catalogByType,
			...(renderContext.variantName === undefined ? {} : { variantName: renderContext.variantName }),
		})
	}
	finally {
		controller.dispose()
	}
}

const locator = (widgetId: string, extra: Record<string, unknown> = {}) => ({ viewId: VIEW_ID, widgetId, resultProperty: 'titleResult', catalogField: 'title', ...extra })

describe('evaluating the declared translation Properties (#96)', () => {
	it('records one entry per Property in Widget order, including one with no warnings, in en-US', async () => {
		const result = await evaluate(view([label('a', 'greeting'), label('b', 'onlyEnglish'), label('c', 'nowhere')]), context())
		expect(result.missing).toEqual([])
		expect(result.entries).toEqual([
			{ occurrence: locator('a'), evaluatedText: 'Hello', warnings: [] },
			{ occurrence: locator('b'), evaluatedText: 'Only in English', warnings: [] },
			{ occurrence: locator('c'), evaluatedText: '⟦missing:nowhere⟧', warnings: [{ code: 'unresolved-key', key: 'nowhere', requestedLocale: 'en-US' }] },
		])
	})

	it('records the fallback warning for a key a Locale lacks, in zh-TW, and carries the Variant name', async () => {
		const resource = view([label('a', 'greeting'), label('b', 'onlyEnglish')], { Quiet: { state: {} } })
		const result = await evaluate(resource, context({ locale: 'zh-TW', variantName: 'Quiet' }))
		expect(result.missing).toEqual([])
		expect(result.entries).toEqual([
			{ occurrence: locator('a', { variantName: 'Quiet' }), evaluatedText: '哈囉', warnings: [] },
			{
				occurrence: locator('b', { variantName: 'Quiet' }),
				evaluatedText: 'Only in English',
				warnings: [{ code: 'missing-translation', key: 'onlyEnglish', requestedLocale: 'zh-TW', fallbackLocale: 'en-US' }],
			},
		])
	})

	it('lists a Property whose evaluation throws or returns another shape as missing, and keeps the others', async () => {
		const result = await evaluate(view([label('a', 'greeting'), label('b', 'boom'), label('c', 'shape'), label('d', 'farewell')]), context())
		expect(result.entries.map(entry => [entry.occurrence.widgetId, entry.evaluatedText])).toEqual([['a', 'Hello'], ['d', 'Goodbye']])
		expect(result.missing).toEqual([
			{ ...locator('b'), reason: expect.stringContaining('the Adapter t exploded') },
			{ ...locator('c'), reason: expect.stringContaining('not a { text, warnings }') },
		])
		for (const item of result.missing) expect(validateTranslationMissingOccurrence(item).ok).toBe(true)
	})

	it('lists a Widget or a result Property absent at runtime as missing', async () => {
		const declared = view([label('a', 'greeting'), label('ghost', 'greeting')])
		const absentWidget = await evaluate(declared, context(), view([label('a', 'greeting')]))
		expect(absentWidget.entries.map(entry => entry.occurrence.widgetId)).toEqual(['a'])
		expect(absentWidget.missing).toEqual([{ ...locator('ghost'), reason: 'The Widget is absent at runtime.' }])

		const catalog = new Map([['Label', { i18n: { fields: { title: { configField: 'titleKey', resultProperty: 'noSuchResult' } } } } as AdapterWidgetCatalogEntry]])
		const absentProperty = await evaluate(view([label('a', 'greeting')]), context(), undefined, catalog)
		expect(absentProperty.entries).toEqual([])
		expect(absentProperty.missing).toEqual([{ ...locator('a', { resultProperty: 'noSuchResult' }), reason: 'The result Property is absent at runtime.' }])
	})

	it('treats a translation warning as data: a record full of warnings is valid and complete', () => {
		const warning = { code: 'unresolved-key', key: 'nowhere', requestedLocale: 'en-US' }
		const record = {
			schemaVersion: 1,
			kind: 'formal_capture',
			executionContext: { viewId: VIEW_ID },
			coverage: { complete: true, translations: { complete: true, evaluated: 1 } },
			provenance: { workspaceSchemaVersion: 6, resources: [], versions: { uiux: '0.0.0' } },
			artifactRefs: [],
			data: { translations: [{ occurrence: locator('c'), evaluatedText: '⟦missing:nowhere⟧', warnings: [warning] }] },
		}
		expect(validateFormalEvidenceRecord(record).ok).toBe(true)
	})
})

describe('validating formal translation Evidence (#96)', () => {
	const base = {
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: { viewId: VIEW_ID },
		provenance: { workspaceSchemaVersion: 6, resources: [], versions: { uiux: '0.0.0' } },
		artifactRefs: [],
	}
	const entry = { occurrence: locator('a'), evaluatedText: 'Hello', warnings: [] }
	const missing = { ...locator('b'), reason: 'The Widget is absent at runtime.' }
	const codes = (record: unknown) => {
		const validation = validateFormalEvidenceRecord(record)
		return validation.ok ? [] : validation.diagnostics.map(diagnostic => diagnostic.code)
	}

	it('accepts a record without translation members, a complete one and an incomplete one', () => {
		expect(codes({ ...base, coverage: { complete: true }, data: { format: 'png' } })).toEqual([])
		expect(codes({ ...base, coverage: { complete: true, translations: { complete: true, evaluated: 1 } }, data: { translations: [entry] } })).toEqual([])
		expect(codes({ ...base, coverage: { complete: true, translations: { complete: true, evaluated: 0 } }, data: { translations: [] } })).toEqual([])
		expect(codes({
			...base,
			coverage: { complete: false, translations: { complete: false, missing: [missing] } },
			data: { translations: [entry] },
		})).toEqual([])
	})

	it('refuses a complete count that differs from the entries, and a gap under complete coverage', () => {
		expect(codes({ ...base, coverage: { complete: true, translations: { complete: true, evaluated: 2 } }, data: { translations: [entry] } }))
			.toContain('evidence.translation_coverage_mismatch')
		expect(codes({ ...base, coverage: { complete: true, translations: { complete: false, missing: [missing] } } }))
			.toContain('evidence.translation_coverage_mismatch')
	})

	it('refuses a malformed entry, a malformed gap, an empty gap list and a warning member on the occurrence', () => {
		expect(codes({ ...base, coverage: { complete: true }, data: { translations: [{ ...entry, occurrence: { ...locator('a'), warning: { code: 'unresolved-key', key: 'k', requestedLocale: 'en-US' } } }] } }).length).toBeGreaterThan(0)
		expect(codes({ ...base, coverage: { complete: false, translations: { complete: false, missing: [{ ...locator('b') }] } } }).length).toBeGreaterThan(0)
		expect(codes({ ...base, coverage: { complete: false, translations: { complete: false, missing: [] } } })).toContain('evidence.invalid_translation_coverage')
	})
})
