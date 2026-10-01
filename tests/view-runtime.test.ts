import { describe, expect, it } from 'vitest'
import { createWidgetPlugin, type RuntimeState, type RuntimeMethod } from '@deviltea/widget-core'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

import { resolveWorkspaceAdapterSet } from '../src/adapters'
import type { AdapterManifest } from '../src/domain/adapters/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { createTranslationRuntime } from '../src/i18n'
import {
	createRootShellPlugin, createRootShellRenderer, LiveViewRuntimeController,
	materializeRuntimeAdapterBundle,
} from '../src/runtime'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'

interface CounterInterfaces {
	state: { count: number }
}

const counterPlugin = createWidgetPlugin('Counter')
	.description('Counter fixture')
	.interfaces<CounterInterfaces>()
	.state(state => state.count({ validate: (input): input is number => typeof input === 'number', default: () => 0 }))
	.done()

interface RootWriterInterfaces {
	methods: { writeRoot: () => null }
}

let localizedLabelComputes = 0

interface LocalizedLabelInterfaces {
	properties: { label: string }
}

const localizedLabelPlugin = createWidgetPlugin('LocalizedLabel')
	.description('Locale dependency fixture')
	.interfaces<LocalizedLabelInterfaces>()
	.properties(properties => properties.label({
		registerDeps: ({ dep }) => ({
			t: dep.root.methods.invoke('t').validate((value): value is { text: string; warnings: readonly unknown[] } => isTranslationResultLike(value)),
		}),
		compute: ({ deps }) => {
			localizedLabelComputes++
			const translated = deps.t('title')
			return translated.ok ? translated.value?.text ?? '' : ''
		},
	}))
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

	it('invalidates child translation Properties through RootShell t when locale changes without replacing the Runtime', async () => {
		const bundle = await runtimeBundle(localizedLabelPlugin, FixtureRenderer)
		const controller = createController(bundle, viewFixture({}, { id: 'label', type: 'LocalizedLabel' }), context())
		expect(controller).toBeInstanceOf(LiveViewRuntimeController)
		if (!(controller instanceof LiveViewRuntimeController)) return
		const runtime = controller.runtime
		const label = runtime.getWidget('label') as unknown as { properties: { label: { get(): { ok: boolean; value?: string | null } } } }
		const beforeComputes = localizedLabelComputes
		expect(label.properties.label.get()).toMatchObject({ ok: true, value: 'Title' })
		expect(localizedLabelComputes).toBe(beforeComputes + 1)

		expect(controller.updateLocale('zh-TW')).toEqual([])
		expect(controller.runtime).toBe(runtime)
		expect(label.properties.label.get()).toMatchObject({ ok: true, value: '標題' })
		expect(localizedLabelComputes).toBe(beforeComputes + 2)
		controller.dispose()
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

	it('fails closed on non-empty Variant state when Core cannot prove author-writable schema metadata', async () => {
		const bundle = await runtimeBundle(counterPlugin, FixtureRenderer)
		const result = createController(bundle, viewFixture({ Filled: { state: { counter: { count: 2 } } } }), context({ variantName: 'Filled' }))
		expect(result).not.toBeInstanceOf(LiveViewRuntimeController)
		if (result instanceof LiveViewRuntimeController) return
		expect(result.state).toBe('invalid')
		expect(result.diagnostics.some(item => item.code === 'variant.author_writable_schema_unavailable')).toBe(true)
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

async function runtimeBundle(plugin: typeof counterPlugin | typeof rootWriterPlugin | typeof localizedLabelPlugin, renderer: ReturnType<typeof defineComponent>) {
	const translation = translationRuntime()
	const rootShell = createRootShellPlugin(translation)
	const set = await validatedSet(plugin.type)
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

async function validatedSet(type: string) {
	const manifest: AdapterManifest = { id: 'fixture', apiVersion: 'test', widgetPlugins: [type], catalog: {}, renderers: [type], providers: [], styles: [], tokens: [] }
	const result = await resolveWorkspaceAdapterSet({
		workspaceRoot: '/fixture',
		adapters: [{ moduleSpecifier: '@fixture/adapter' }],
		resolver: { async resolve(_root, moduleSpecifier) { return { moduleSpecifier, resolvedPath: '/fixture/adapter.mjs', moduleIdentity: 'file:///fixture/adapter.mjs' } } },
		loader: { async loadManifest() { return manifest } },
		apiCompatibility: { isCompatible() { return true } },
		registryInspector: { async inspect() { return { widgetTypes: [type], rendererKeys: [type], catalogKeys: [] } } },
	})
	if (result.state !== 'valid') throw new Error(JSON.stringify(result.diagnostics))
	return result.set
}

function translationRuntime() {
	const state = createTranslationRuntime('en-US', new Map([
		['en-US', { title: 'Title' }],
		['zh-TW', { title: '標題' }],
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

function isTranslationResultLike(value: unknown): value is { text: string; warnings: readonly unknown[] } {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		&& typeof (value as { text?: unknown }).text === 'string'
		&& Array.isArray((value as { warnings?: unknown }).warnings)
}
