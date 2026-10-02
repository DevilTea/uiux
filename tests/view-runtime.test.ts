import { describe, expect, it } from 'vitest'
import { createWidgetPlugin, type RuntimeState, type RuntimeMethod } from '@deviltea/widget-core'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

import { resolveWorkspaceAdapterSet } from '../src/adapters'
import type { AdapterManifest, AdapterWidgetCatalogEntry } from '../src/domain/adapters/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import type { ViewResource } from '../src/domain/views/schema'
import type { TranslationResult } from '../src/domain/i18n/schema'
import {
	createTranslationRuntime,
	UIUX_STRING_VALUE_CONTRACT,
	UIUX_TRANSLATION_RESULT_VALUE_CONTRACT,
} from '../src/i18n'
import {
	createRootShellPlugin, createRootShellRenderer, LiveViewRuntimeController,
	materializeRuntimeAdapterBundle,
} from '../src/runtime'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'

interface CounterInterfaces {
	state: { count: number; internal: number }
}

const counterPlugin = createWidgetPlugin('Counter')
	.description('Counter fixture')
	.interfaces<CounterInterfaces>()
	.state(state => state
		.count({ authorWritable: true, validate: (input): input is number => typeof input === 'number', default: () => 0 })
		.internal({ validate: (input): input is number => typeof input === 'number', default: () => 10 }))
	.done()

interface RootWriterInterfaces {
	methods: { writeRoot: () => null }
}

let localizedLabelComputes = 0

interface LocalizedLabelInterfaces {
	config: {
		raw: { readonly title?: string; readonly titleKey?: string }
		resolved: { readonly title: string; readonly titleKey: string | null }
	}
	state: { count: number }
	properties: { formattedCount: string; titleResult: TranslationResult; label: string }
}

const localizedLabelPlugin = createWidgetPlugin('LocalizedLabel')
	.description('Locale dependency fixture')
	.interfaces<LocalizedLabelInterfaces>()
	.config({
		description: 'Localized label config',
		schema: {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			properties: { title: { type: 'string' }, titleKey: { type: 'string' } },
			additionalProperties: false,
		},
		validate: (input): input is LocalizedLabelInterfaces['config']['raw'] => isOptionalStringConfig(input, ['title', 'titleKey']),
		resolve: raw => ({ title: raw?.title ?? '', titleKey: raw?.titleKey ?? null }),
	})
	.state(state => state.count({ validate: (input): input is number => typeof input === 'number', default: () => 1 }))
	.properties(properties => properties
		.formattedCount({
			valueContract: UIUX_STRING_VALUE_CONTRACT,
			registerDeps: ({ dep }) => ({ count: dep.self.state.get('count') }),
			compute: ({ deps }) => {
				const count = deps.count()
				return count.ok ? String(count.value) : ''
			},
		})
		.titleResult({
			valueContract: UIUX_TRANSLATION_RESULT_VALUE_CONTRACT,
			registerDeps: ({ dep }) => ({
				t: dep.root.methods.invoke('t').validate((value): value is TranslationResult => isTranslationResultLike(value)),
				formattedCount: dep.self.properties.get('formattedCount'),
			}),
			compute: ({ config, deps }) => {
				localizedLabelComputes++
				if (config.titleKey === null) return { text: config.title, warnings: [] }
				const formattedCount = deps.formattedCount()
				if (!formattedCount.ok || formattedCount.value === null) return { text: '', warnings: [] }
				const translated = deps.t(config.titleKey, { count: formattedCount.value })
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

const localizedLabelCatalog: AdapterWidgetCatalogEntry = {
	i18n: {
		fields: {
			title: {
				configField: 'titleKey',
				resultProperty: 'titleResult',
				textProperty: 'label',
				params: { count: 'formattedCount' },
			},
		},
	},
}

const unprovableLocalizedLabelPlugin = createWidgetPlugin('UnprovableLocalizedLabel')
	.description('Schema proof fixture')
	.interfaces<LocalizedLabelInterfaces>()
	.config({
		description: 'Config whose string field requires $ref resolution',
		schema: {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			$defs: { key: { type: 'string' } },
			properties: { title: { type: 'string' }, titleKey: { $ref: '#/$defs/key' } },
		},
		validate: (input): input is LocalizedLabelInterfaces['config']['raw'] => isOptionalStringConfig(input, ['title', 'titleKey']),
		resolve: raw => ({ title: raw?.title ?? '', titleKey: raw?.titleKey ?? null }),
	})
	.state(state => state.count({ validate: (input): input is number => typeof input === 'number', default: () => 1 }))
	.properties(properties => properties
		.formattedCount({ valueContract: UIUX_STRING_VALUE_CONTRACT, compute: () => '1' })
		.titleResult({ valueContract: UIUX_TRANSLATION_RESULT_VALUE_CONTRACT, compute: () => ({ text: '', warnings: [] }) })
		.label({ valueContract: UIUX_STRING_VALUE_CONTRACT, compute: () => '' }))
	.done()

const rootWriterPlugin = createWidgetPlugin('RootWriter')
	.description('Invalid integration fixture')
	.interfaces<RootWriterInterfaces>()
	.methods(methods => methods.writeRoot({
		registerDeps: ({ dep }) => ({ write: dep.root.state.set('locale') }),
		validateArgs: (args): args is [] => args.length === 0,
		execute: ({ deps }) => { deps.write('hijack'); return null },
	}))
	.done()

const FixtureRenderer = defineComponent({ name: 'WidgetFixtureRenderer', setup: () => () => h('div') })

describe('View / RootShell / Variant runtime assembly', () => {
	it('keeps the accepted UIUX i18n Property value-contract identities stable', () => {
		expect(UIUX_TRANSLATION_RESULT_VALUE_CONTRACT.id).toBe('deviltea.uiux/translation-result@1')
		expect(UIUX_STRING_VALUE_CONTRACT.id).toBe('deviltea.uiux/string@1')
	})

	it('builds a base Runtime with exactly one persisted RootShell and a working locale-dependent t method', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const controller = createController(bundle, viewFixture(), context())
		expect(controller).toBeInstanceOf(LiveViewRuntimeController)
		if (!(controller instanceof LiveViewRuntimeController)) return

		const root = controller.runtime.getWidget('root') as unknown as {
			methods: { t: RuntimeMethod<(key: string, params?: Readonly<Record<string, string>>) => { text: string; warnings: readonly unknown[] }> }
		}
		expect(root.methods.t('title')).toMatchObject({ ok: true, value: { text: 'Title', warnings: [] } })
		expect(controller.runtime.blueprint.root.id).toBe('root')
		expect(controller.runtime.blueprint.root.type).toBe('RootShell')
		controller.dispose()
	})

	it('mounts the assembled Vue renderer against the exact Runtime/System pair', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const controller = createController(bundle, viewFixture(), context())
		expect(controller).toBeInstanceOf(LiveViewRuntimeController)
		if (!(controller instanceof LiveViewRuntimeController)) return
		const app = createSSRApp({ render: () => h(bundle.renderer, { runtime: controller.runtime }) })
		await expect(renderToString(app)).resolves.toContain('<div')
		controller.dispose()
	})

	it('keeps the current Runtime untouched when an invalid Variant contains both valid and invalid overrides', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const view = viewFixture({ Broken: { state: { counter: { count: 2, unknown: 3 } } } })
		const controller = createController(bundle, view, context())
		expect(controller).toBeInstanceOf(LiveViewRuntimeController)
		if (!(controller instanceof LiveViewRuntimeController)) return
		const before = controller.runtime
		counterState(before).set(9)

		const switched = controller.switchVariant('Broken')
		expect(switched.state).toBe('invalid')
		expect(switched.state === 'invalid' && switched.diagnostics.some(item => item.code === 'widget.unknown-state-override-member')).toBe(true)
		expect(controller.runtime).toBe(before)
		expect(before.isDisposed).toBe(false)
		expect(counterState(controller.runtime).get()).toBe(9)
		controller.dispose()
	})

	it('switches valid Variants by replacing the entire Runtime and disposing the old instance', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const view = viewFixture({ Empty: { state: {} } })
		const controller = createController(bundle, view, context())
		expect(controller).toBeInstanceOf(LiveViewRuntimeController)
		if (!(controller instanceof LiveViewRuntimeController)) return
		const before = controller.runtime
		counterState(before).set(9)

		const switched = controller.switchVariant('Empty')
		expect(switched.state).toBe('ready')
		expect(controller.runtime).not.toBe(before)
		expect(before.isDisposed).toBe(true)
		expect(counterState(controller.runtime).get()).toBe(0)
		expect(controller.context.variantName).toBe('Empty')
		controller.dispose()
	})

	it('updates live locale/viewport/theme on the same Runtime without losing unrelated interaction State', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const controller = createController(bundle, viewFixture(), context())
		expect(controller).toBeInstanceOf(LiveViewRuntimeController)
		if (!(controller instanceof LiveViewRuntimeController)) return
		const runtime = controller.runtime
		counterState(runtime).set(7)

		expect(controller.updateLocale('zh-TW')).toEqual([])
		expect(controller.updateViewport('mobile', { width: 390, height: 844 })).toEqual([])
		expect(controller.updateTheme('dark')).toEqual([])
		expect(controller.runtime).toBe(runtime)
		expect(counterState(runtime).get()).toBe(7)
		expect(controller.context).toMatchObject({ locale: 'zh-TW', viewportId: 'mobile', viewport: { width: 390, height: 844 }, themeId: 'dark' })
		const rootState = runtime.getWidget('root') as unknown as { state: {
			locale: RuntimeState<string>
			viewport: RuntimeState<{ id: string; width: number; height: number }>
			themeId: RuntimeState<string>
			variantName: RuntimeState<string | null>
		} }
		expect(rootState.state.locale.get()).toBe('zh-TW')
		expect(rootState.state.viewport.get()).toEqual({ id: 'mobile', width: 390, height: 844 })
		expect(rootState.state.themeId.get()).toBe('dark')
		expect(rootState.state.variantName.get()).toBeNull()

		const root = runtime.getWidget('root') as unknown as { methods: { t: RuntimeMethod<(key: string) => { text: string; warnings: readonly unknown[] }> } }
		expect(root.methods.t('title')).toMatchObject({ ok: true, value: { text: '標題', warnings: [] } })
		controller.dispose()
	})

	it('lowers a Catalog-declared $i18n authoring binding to the plugin key Config and refreshes translated Properties without replacing the Runtime', async () => {
		const bundle = await runtimeBundle(localizedLabelPlugin, FixtureRenderer, localizedLabelCatalog)
		const authored = { id: 'label', type: 'LocalizedLabel', config: { title: { $i18n: 'countTitle' } } } as const
		const controller = createController(bundle, viewFixture({}, authored), context())
		expect(controller).toBeInstanceOf(LiveViewRuntimeController)
		if (!(controller instanceof LiveViewRuntimeController)) return
		const runtime = controller.runtime
		const label = runtime.getWidget('label') as unknown as {
			state: { count: RuntimeState<number> }
			properties: { label: { get(): { ok: boolean; value?: string | null } } }
		}
		const beforeComputes = localizedLabelComputes
		expect(label.properties.label.get()).toMatchObject({ ok: true, value: 'Count 1' })
		expect(localizedLabelComputes).toBe(beforeComputes + 1)
		expect(authored.config.title).toEqual({ $i18n: 'countTitle' })

		expect(label.state.count.set(2)).toMatchObject({ ok: true })
		expect(controller.runtime).toBe(runtime)
		expect(label.properties.label.get()).toMatchObject({ ok: true, value: 'Count 2' })
		expect(localizedLabelComputes).toBe(beforeComputes + 2)

		expect(controller.updateLocale('zh-TW')).toEqual([])
		expect(controller.runtime).toBe(runtime)
		expect(label.properties.label.get()).toMatchObject({ ok: true, value: '計數 2' })
		expect(localizedLabelComputes).toBe(beforeComputes + 3)
		controller.dispose()
	})

	it('keeps an ordinary literal authoring string literal instead of interpreting it as an i18n key', async () => {
		const bundle = await runtimeBundle(localizedLabelPlugin, FixtureRenderer, localizedLabelCatalog)
		const controller = createController(bundle, viewFixture({}, {
			id: 'label', type: 'LocalizedLabel', config: { title: 'Literal title' },
		}), context())
		expect(controller).toBeInstanceOf(LiveViewRuntimeController)
		if (!(controller instanceof LiveViewRuntimeController)) return
		const label = controller.runtime.getWidget('label') as unknown as { properties: { label: { get(): { ok: boolean; value?: string | null } } } }
		expect(label.properties.label.get()).toMatchObject({ ok: true, value: 'Literal title' })
		controller.dispose()
	})

	it('rejects a malformed structured $i18n binding before Widget Core compilation', async () => {
		const bundle = await runtimeBundle(localizedLabelPlugin, FixtureRenderer, localizedLabelCatalog)
		const result = createController(bundle, viewFixture({}, {
			id: 'label', type: 'LocalizedLabel', config: { title: { $i18n: 42 } },
		}), context())
		expect(result).not.toBeInstanceOf(LiveViewRuntimeController)
		if (result instanceof LiveViewRuntimeController) return
		expect(result.diagnostics.some(item => item.path.endsWith('/config/title/$i18n'))).toBe(true)
		expect(result.diagnostics.every(item => !item.code.startsWith('widget.'))).toBe(true)
	})

	it('rejects structured $i18n on a Widget Config field that the per-Widget Catalog did not declare eligible', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const result = createController(bundle, viewFixture({}, {
			id: 'counter', type: 'Counter', config: { title: { $i18n: 'title' } },
		}), context())
		expect(result).not.toBeInstanceOf(LiveViewRuntimeController)
		if (result instanceof LiveViewRuntimeController) return
		expect(result.diagnostics.some(item => item.code === 'i18n.field_not_eligible')).toBe(true)
	})

	it('rejects invalid live context candidates before mutating RootShell State', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const controller = createController(bundle, viewFixture(), context())
		expect(controller).toBeInstanceOf(LiveViewRuntimeController)
		if (!(controller instanceof LiveViewRuntimeController)) return
		const runtime = controller.runtime

		expect(controller.updateLocale('EN-us').some(item => item.code === 'render_context.invalid_locale')).toBe(true)
		expect(controller.context.locale).toBe('en-US')
		expect(controller.runtime).toBe(runtime)
		controller.dispose()
	})

	it('applies Variant State only when the Plugin declaration explicitly marks the member author-writable', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const result = createController(bundle, viewFixture({ Filled: { state: { counter: { count: 2 } } } }), context({ variantName: 'Filled' }))
		expect(result).toBeInstanceOf(LiveViewRuntimeController)
		if (!(result instanceof LiveViewRuntimeController)) return
		expect(counterState(result.runtime).get()).toBe(2)
		result.dispose()
	})

	it('rejects a known non-author-writable State member before replacing the active Runtime', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const view = viewFixture({ Broken: { state: { counter: { count: 2, internal: 3 } } } })
		const controller = createController(bundle, view, context())
		expect(controller).toBeInstanceOf(LiveViewRuntimeController)
		if (!(controller instanceof LiveViewRuntimeController)) return
		const before = controller.runtime
		counterState(before).set(9)

		const switched = controller.switchVariant('Broken')
		expect(switched.state).toBe('invalid')
		expect(switched.state === 'invalid' && switched.diagnostics.some(item => item.code === 'variant.state_not_author_writable')).toBe(true)
		expect(controller.runtime).toBe(before)
		expect(before.isDisposed).toBe(false)
		expect(counterState(controller.runtime).get()).toBe(9)
		controller.dispose()
	})

	it('never permits a Variant to author system-managed RootShell presentation State', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const result = createController(bundle, viewFixture({ Broken: { state: { root: { locale: 'zh-TW' } } } }), context({ variantName: 'Broken' }))
		expect(result).not.toBeInstanceOf(LiveViewRuntimeController)
		if (result instanceof LiveViewRuntimeController) return
		expect(result.diagnostics.some(item => item.code === 'variant.root_shell_state_managed')).toBe(true)
	})

	it('rejects descendant plugin dependencies that can write UIUX-managed RootShell State', async () => {
		const bundle = await runtimeBundle(rootWriterPlugin, FixtureRenderer)
		const result = createController(bundle, viewFixture({}, { id: 'writer', type: 'RootWriter' }), context())
		expect(result).not.toBeInstanceOf(LiveViewRuntimeController)
		if (result instanceof LiveViewRuntimeController) return
		expect(result.diagnostics.some(item => item.code === 'runtime.root_context_write_forbidden')).toBe(true)
	})

	it('validates Catalog metadata against the decoded Plugin universe even when Catalog and Plugin are owned by different Adapter entries', async () => {
		const pluginManifest: AdapterManifest = {
			id: 'plugin-provider', apiVersion: 'test', widgetPlugins: ['LocalizedLabel'], catalog: { widgets: {} },
			renderers: ['LocalizedLabel'], providers: [], styles: [], tokens: [],
		}
		const catalogManifest: AdapterManifest = {
			id: 'catalog-provider', apiVersion: 'test', widgetPlugins: [], catalog: { widgets: { LocalizedLabel: localizedLabelCatalog } },
			renderers: [], providers: [], styles: [], tokens: [],
		}
		const resolved = await resolveWorkspaceAdapterSet({
			workspaceRoot: '/fixture',
			adapters: [{ moduleSpecifier: '@fixture/plugin' }, { moduleSpecifier: '@fixture/catalog' }],
			resolver: { async resolve(_root, moduleSpecifier) { return { moduleSpecifier, resolvedPath: `/fixture/${moduleSpecifier.endsWith('plugin') ? 'plugin' : 'catalog'}.mjs`, moduleIdentity: `file:///fixture/${moduleSpecifier.endsWith('plugin') ? 'plugin' : 'catalog'}.mjs` } } },
			loader: { async loadManifest(resolvedModule) { return resolvedModule.moduleSpecifier.endsWith('plugin') ? pluginManifest : catalogManifest } },
			apiCompatibility: { isCompatible() { return true } },
			registryInspector: {
				async inspect(manifest) {
					return manifest.id === 'plugin-provider'
						? { widgetTypes: ['LocalizedLabel'], rendererKeys: ['LocalizedLabel'] }
						: { widgetTypes: [], rendererKeys: [] }
				},
			},
		})
		expect(resolved.state).toBe('valid')
		if (resolved.state !== 'valid') return
		const translation = translationRuntime()
		const rootShell = createRootShellPlugin(translation)
		const materialized = await materializeRuntimeAdapterBundle({
			set: resolved.set, rootShellPlugin: rootShell, rootShellRenderer: createRootShellRenderer(rootShell),
			decoder: {
				async decodePlugin(member) { if (member !== 'LocalizedLabel') throw new Error('unexpected plugin'); return localizedLabelPlugin },
				async decodeRenderer(member) { if (member !== 'LocalizedLabel') throw new Error('unexpected renderer'); return { type: 'LocalizedLabel', component: FixtureRenderer } },
			},
		})
		expect(materialized.state).toBe('ready')
		if (materialized.state !== 'ready') return
		expect(materialized.bundle.catalogByType.get('LocalizedLabel')).toBe(localizedLabelCatalog)
	})

	it('rejects an i18n Catalog mapping whose Property contract or Config schema cannot be proven from the decoded Plugin', async () => {
		const translation = translationRuntime()
		const rootShell = createRootShellPlugin(translation)
		const set = await validatedSet('LocalizedLabel', {
			i18n: { fields: { title: { configField: 'missingKey', resultProperty: 'label', textProperty: 'titleResult', params: { count: 'missingParam' } } } },
		})
		const result = await materializeRuntimeAdapterBundle({
			set, rootShellPlugin: rootShell, rootShellRenderer: createRootShellRenderer(rootShell),
			decoder: {
				async decodePlugin() { return localizedLabelPlugin },
				async decodeRenderer() { return { type: 'LocalizedLabel', component: FixtureRenderer } },
			},
		})
		expect(result.state).toBe('invalid')
		if (result.state !== 'invalid') return
		expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
			'adapter.i18n_config_field_not_proven_string',
			'adapter.i18n_result_property_contract_mismatch',
			'adapter.i18n_text_property_contract_mismatch',
			'adapter.i18n_parameter_property_missing',
		]))
	})

	it('fails closed when a Config field is string only through $ref rather than a direct local schema proof', async () => {
		const translation = translationRuntime()
		const rootShell = createRootShellPlugin(translation)
		const set = await validatedSet('UnprovableLocalizedLabel', localizedLabelCatalog)
		const result = await materializeRuntimeAdapterBundle({
			set, rootShellPlugin: rootShell, rootShellRenderer: createRootShellRenderer(rootShell),
			decoder: {
				async decodePlugin() { return unprovableLocalizedLabelPlugin },
				async decodeRenderer() { return { type: 'UnprovableLocalizedLabel', component: FixtureRenderer } },
			},
		})
		expect(result.state).toBe('invalid')
		expect(result.state === 'invalid' && result.diagnostics.some(item => item.code === 'adapter.i18n_config_field_not_proven_string')).toBe(true)
	})

	it('rejects conflicting authored raw key Config instead of silently overriding it during $i18n lowering', async () => {
		const bundle = await runtimeBundle(localizedLabelPlugin, FixtureRenderer, localizedLabelCatalog)
		const result = createController(bundle, viewFixture({}, {
			id: 'label', type: 'LocalizedLabel', config: { title: { $i18n: 'title' }, titleKey: 'other' },
		}), context())
		expect(result).not.toBeInstanceOf(LiveViewRuntimeController)
		if (result instanceof LiveViewRuntimeController) return
		expect(result.diagnostics.some(item => item.code === 'i18n.config_field_conflict')).toBe(true)
	})

	it('refuses materialized runtime members that do not match the validated Adapter ownership set', async () => {
		const translation = translationRuntime()
		const rootShell = createRootShellPlugin(translation)
		const set = await validatedSet('Counter')
		const result = await materializeRuntimeAdapterBundle({
			set, rootShellPlugin: rootShell, rootShellRenderer: createRootShellRenderer(rootShell),
			decoder: {
				async decodePlugin() { return rootWriterPlugin },
				async decodeRenderer() { return { type: 'RootWriter', component: FixtureRenderer } },
			},
		})
		expect(result.state).toBe('invalid')
		expect(result.state === 'invalid' && result.diagnostics.some(item => item.code === 'adapter.runtime_plugin_ownership_mismatch')).toBe(true)
	})
})

async function runtimeBundle(
	plugin: typeof counterPlugin | typeof rootWriterPlugin | typeof localizedLabelPlugin,
	renderer: ReturnType<typeof defineComponent>,
	catalog?: AdapterWidgetCatalogEntry,
) {
	const translation = translationRuntime()
	const rootShell = createRootShellPlugin(translation)
	const set = await validatedSet(plugin.type, catalog)
	const result = await materializeRuntimeAdapterBundle({
		set, rootShellPlugin: rootShell, rootShellRenderer: createRootShellRenderer(rootShell),
		decoder: {
			async decodePlugin(member) { if (member !== plugin.type) throw new Error('unexpected plugin member'); return plugin },
			async decodeRenderer(member) { if (member !== plugin.type) throw new Error('unexpected renderer member'); return { type: plugin.type, component: renderer } },
		},
	})
	if (result.state !== 'ready') throw new Error(JSON.stringify(result.diagnostics))
	return result.bundle
}

async function validatedSet(type: string, catalog?: AdapterWidgetCatalogEntry) {
	const manifest: AdapterManifest = {
		id: 'fixture', apiVersion: 'test', widgetPlugins: [type],
		catalog: { widgets: catalog ? { [type]: catalog } : {} },
		renderers: [type], providers: [], styles: [], tokens: [],
	}
	const result = await resolveWorkspaceAdapterSet({
		workspaceRoot: '/fixture',
		adapters: [{ moduleSpecifier: '@fixture/adapter' }],
		resolver: { async resolve(_root, moduleSpecifier) { return { moduleSpecifier, resolvedPath: '/fixture/adapter.mjs', moduleIdentity: 'file:///fixture/adapter.mjs' } } },
		loader: { async loadManifest() { return manifest } },
		apiCompatibility: { isCompatible() { return true } },
		registryInspector: { async inspect() { return { widgetTypes: [type], rendererKeys: [type] } } },
	})
	if (result.state !== 'valid') throw new Error(JSON.stringify(result.diagnostics))
	return result.set
}

function translationRuntime() {
	const state = createTranslationRuntime('en-US', new Map([
		['en-US', { title: 'Title', countTitle: 'Count {count}' }],
		['zh-TW', { title: '標題', countTitle: '計數 {count}' }],
	]))
	if (state.state !== 'ready') throw new Error(JSON.stringify(state.findings))
	return state.runtime
}

function createController(bundle: Awaited<ReturnType<typeof runtimeBundle>>, view: ViewResource, renderContext: ResolvedRenderContext) {
	return LiveViewRuntimeController.create({ view, adapters: bundle, context: renderContext })
}

function counterState(runtime: { getWidget(id: string): unknown }): RuntimeState<number> {
	const widget = runtime.getWidget('counter') as { state?: { count?: RuntimeState<number> } } | null
	if (!widget?.state?.count) throw new Error('Counter state missing')
	return widget.state.count
}

function viewFixture(
	variants: ViewResource['variants'] = {},
	child: Readonly<Record<string, unknown>> = { id: 'counter', type: 'Counter' },
): ViewResource {
	return {
		id: VIEW_ID, name: 'Runtime fixture',
		ir: { type: 'RootShell', id: 'root', slots: { content: [child] } } as never,
		variants,
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

function context(overrides: Partial<ResolvedRenderContext> = {}): ResolvedRenderContext {
	return {
		viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light', ...overrides,
	}
}

function isOptionalStringConfig(input: unknown, keys: readonly string[]): input is Readonly<Record<string, string>> {
	if (input === undefined || input === null) return true
	if (typeof input !== 'object' || Array.isArray(input)) return false
	const record = input as Record<string, unknown>
	return Object.keys(record).every(key => keys.includes(key) && typeof record[key] === 'string')
}

function isTranslationResultLike(value: unknown): value is TranslationResult {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		&& typeof (value as { text?: unknown }).text === 'string'
		&& Array.isArray((value as { warnings?: unknown }).warnings)
}
