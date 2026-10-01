import type { AnyWidgetPlugin, WidgetSystem } from '@deviltea/widget-core'
import { createWidgetSystem } from '@deviltea/widget-core'
import { createWidgetVueRenderer, type WidgetVueRenderer } from '@deviltea/widget-vue'
import type { Component } from 'vue'

import type { ValidatedAdapterEntry, ValidatedAdapterSet } from '../adapters'
import type { Diagnostic } from '../domain/validation'
import type { RootShellPlugin } from './root-shell'

export type DecodedRendererRegistration = Readonly<{ type: string; component: Component }>

/**
 * Implementation seam only: decodes the runtime members already present in the validated manifest.
 * It cannot substitute a shadow registry and deliberately does not define the adapter package's JS member shape.
 */
export interface AdapterRuntimeMemberDecoder {
	decodePlugin(member: unknown, context: Readonly<{ entry: ValidatedAdapterEntry; index: number }>): AnyWidgetPlugin | Promise<AnyWidgetPlugin>
	decodeRenderer(member: unknown, context: Readonly<{ entry: ValidatedAdapterEntry; index: number }>): DecodedRendererRegistration | Promise<DecodedRendererRegistration>
}

export type RuntimeAdapterBundle = Readonly<{
	system: WidgetSystem
	renderer: WidgetVueRenderer<readonly AnyWidgetPlugin[]>
	pluginsByType: ReadonlyMap<string, AnyWidgetPlugin>
}>

export type RuntimeAdapterBundleResult =
	| Readonly<{ state: 'ready'; bundle: RuntimeAdapterBundle; diagnostics: readonly [] }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>

export async function materializeRuntimeAdapterBundle(input: Readonly<{
	set: ValidatedAdapterSet
	decoder: AdapterRuntimeMemberDecoder
	rootShellPlugin: RootShellPlugin
	rootShellRenderer: Component
}>): Promise<RuntimeAdapterBundleResult> {
	const diagnostics: Diagnostic[] = []
	const plugins: AnyWidgetPlugin[] = [input.rootShellPlugin]
	const renderers = new Map<string, Component>([['RootShell', input.rootShellRenderer]])

	for (const entry of input.set.entries) {
		const decodedPlugins: AnyWidgetPlugin[] = []
		const decodedRenderers = new Map<string, Component>()

		for (const [index, member] of entry.manifest.widgetPlugins.entries()) {
			try { decodedPlugins.push(await input.decoder.decodePlugin(member, { entry, index })) }
			catch (cause) {
				diagnostics.push({ code: 'adapter.runtime_plugin_decode_failed', path: `/adapters/${entry.index}/manifest/widgetPlugins/${index}`, message: messageOf('Widget plugin manifest member could not be decoded.', cause) })
			}
		}
		for (const [index, member] of entry.manifest.renderers.entries()) {
			try {
				const decoded = await input.decoder.decodeRenderer(member, { entry, index })
				if (decodedRenderers.has(decoded.type))
					diagnostics.push({ code: 'adapter.runtime_renderer_collision', path: `/adapters/${entry.index}/manifest/renderers/${index}`, message: `Renderer type ${decoded.type} is registered more than once by this adapter.` })
				else decodedRenderers.set(decoded.type, decoded.component)
			}
			catch (cause) {
				diagnostics.push({ code: 'adapter.runtime_renderer_decode_failed', path: `/adapters/${entry.index}/manifest/renderers/${index}`, message: messageOf('Vue renderer manifest member could not be decoded.', cause) })
			}
		}

		const pluginTypes = decodedPlugins.map(plugin => plugin.type)
		const rendererTypes = [...decodedRenderers.keys()]
		if (!sameSet(pluginTypes, entry.ownership.widgetTypes))
			diagnostics.push({ code: 'adapter.runtime_plugin_ownership_mismatch', path: `/adapters/${entry.index}/manifest/widgetPlugins`, message: 'Decoded Widget plugin types do not match the validated adapter ownership set.' })
		if (!sameSet(rendererTypes, entry.ownership.rendererKeys))
			diagnostics.push({ code: 'adapter.runtime_renderer_ownership_mismatch', path: `/adapters/${entry.index}/manifest/renderers`, message: 'Decoded Vue renderer keys do not match the validated adapter ownership set.' })
		for (const plugin of decodedPlugins) {
			if (plugin.type === 'RootShell') diagnostics.push({ code: 'adapter.reserved_root_shell_type', path: `/adapters/${entry.index}/manifest/widgetPlugins`, message: 'RootShell is owned exclusively by UIUX.' })
			plugins.push(plugin)
		}
		for (const [type, component] of decodedRenderers) {
			if (type === 'RootShell') diagnostics.push({ code: 'adapter.reserved_root_shell_renderer', path: `/adapters/${entry.index}/manifest/renderers`, message: 'RootShell renderer is owned exclusively by UIUX.' })
			if (renderers.has(type)) diagnostics.push({ code: 'adapter.runtime_renderer_collision', path: `/adapters/${entry.index}/manifest/renderers`, message: `Renderer type ${type} is already registered.` })
			else renderers.set(type, component)
		}
	}
	if (diagnostics.length > 0) return { state: 'invalid', diagnostics }

	const system = createWidgetSystem({ plugins: plugins as readonly AnyWidgetPlugin[] })
	let renderer: WidgetVueRenderer<readonly AnyWidgetPlugin[]>
	try { renderer = createDynamicRenderer(system, renderers) }
	catch (cause) {
		return { state: 'invalid', diagnostics: [{ code: 'adapter.vue_renderer_registry_invalid', path: '/adapters', message: messageOf('Vue renderer registry could not be constructed.', cause) }] }
	}
	return {
		state: 'ready',
		diagnostics: [],
		bundle: { system, renderer, pluginsByType: new Map(plugins.map(plugin => [plugin.type, plugin])) },
	}
}

function createDynamicRenderer(system: WidgetSystem, renderers: ReadonlyMap<string, Component>): WidgetVueRenderer<readonly AnyWidgetPlugin[]> {
	const dynamicCreate = createWidgetVueRenderer as unknown as (system: WidgetSystem, build: (section: Record<string, (component: Component) => unknown>) => unknown) => WidgetVueRenderer<readonly AnyWidgetPlugin[]>
	return dynamicCreate(system, (initial) => {
		let section: unknown = initial
		for (const [type, component] of renderers)
			section = (section as Record<string, (value: Component) => unknown>)[type]!(component)
		return section
	})
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return false
	const a = [...actual].sort()
	const e = [...expected].sort()
	return a.every((value, index) => value === e[index])
}

function messageOf(prefix: string, cause: unknown): string {
	return cause instanceof Error && cause.message ? `${prefix} ${cause.message}` : prefix
}
