import type { AnyWidgetPlugin, WidgetSystem } from '@deviltea/widget-core'
import { createWidgetSystem } from '@deviltea/widget-core'
import { inspectPlugin } from '@deviltea/widget-core/inspection'
import { createWidgetVueRenderer, type WidgetVueRenderer } from '@deviltea/widget-vue'
import type { Component } from 'vue'

import type { ValidatedAdapterEntry, ValidatedAdapterSet } from '../adapters'
import type { AdapterWidgetCatalogEntry } from '../domain/adapters/schema'
import type { Diagnostic } from '../domain/validation'
import {
	UIUX_STRING_VALUE_CONTRACT_ID,
	UIUX_TRANSLATION_RESULT_VALUE_CONTRACT_ID,
} from '../i18n/widget-contracts'
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
	catalogByType: ReadonlyMap<string, AdapterWidgetCatalogEntry>
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
	const catalogByType = new Map<string, AdapterWidgetCatalogEntry>()
	const pendingCatalogEntries: Array<Readonly<{ type: string; catalog: AdapterWidgetCatalogEntry; path: string }>> = []

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

		for (const [type, catalog] of Object.entries(entry.manifest.catalog.widgets)) {
			pendingCatalogEntries.push({
				type,
				catalog,
				path: `/adapters/${entry.index}/manifest/catalog/widgets/${escapePointer(type)}`,
			})
		}
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

	const pluginsByType = new Map(plugins.map(plugin => [plugin.type, plugin] as const))
	for (const entry of pendingCatalogEntries) {
		const plugin = pluginsByType.get(entry.type)
		if (!plugin) {
			diagnostics.push({ code: 'adapter.runtime_catalog_plugin_missing', path: entry.path, message: `Catalog Widget type ${entry.type} does not resolve to a decoded Widget plugin in the validated adapter set.` })
			continue
		}
		diagnostics.push(...validateCatalogAgainstPlugin(plugin, entry.catalog, entry.path))
		catalogByType.set(entry.type, entry.catalog)
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
		bundle: {
			system,
			renderer,
			pluginsByType,
			catalogByType,
		},
	}
}

function validateCatalogAgainstPlugin(
	plugin: AnyWidgetPlugin,
	catalog: AdapterWidgetCatalogEntry,
	path: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const fields = catalog.i18n?.fields
	if (!fields) return diagnostics

	const inspection = inspectPlugin(plugin)
	for (const [authorField, mapping] of Object.entries(fields)) {
		const fieldPath = `${path}/i18n/fields/${escapePointer(authorField)}`
		if (plugin.config === null) {
			diagnostics.push({ code: 'adapter.i18n_config_capability_missing', path: `${fieldPath}/configField`, message: `Widget plugin ${plugin.type} does not declare Config required by this i18n mapping.` })
		}
		else if (plugin.config.schema === null) {
			diagnostics.push({ code: 'adapter.i18n_config_schema_unavailable', path: `${fieldPath}/configField`, message: `Widget plugin ${plugin.type} does not expose Config schema metadata needed to prove the mapped string key field.` })
		}
		else if (!schemaDirectlyProvesStringField(plugin.config.schema, mapping.configField)) {
			diagnostics.push({ code: 'adapter.i18n_config_field_not_proven_string', path: `${fieldPath}/configField`, message: `Config field ${mapping.configField} is not directly provable as string-only from the Widget plugin Config schema.` })
		}

		const resultProperty = inspection.properties?.get(mapping.resultProperty)
		if (!resultProperty) {
			diagnostics.push({ code: 'adapter.i18n_result_property_missing', path: `${fieldPath}/resultProperty`, message: `Mapped result Property ${mapping.resultProperty} is not declared by Widget plugin ${plugin.type}.` })
		}
		else if (resultProperty.valueContractId !== UIUX_TRANSLATION_RESULT_VALUE_CONTRACT_ID) {
			diagnostics.push({ code: 'adapter.i18n_result_property_contract_mismatch', path: `${fieldPath}/resultProperty`, message: `Mapped result Property ${mapping.resultProperty} does not declare the required UIUX TranslationResult value contract.` })
		}

		const textProperty = inspection.properties?.get(mapping.textProperty)
		if (!textProperty) {
			diagnostics.push({ code: 'adapter.i18n_text_property_missing', path: `${fieldPath}/textProperty`, message: `Mapped text Property ${mapping.textProperty} is not declared by Widget plugin ${plugin.type}.` })
		}
		else if (textProperty.valueContractId !== UIUX_STRING_VALUE_CONTRACT_ID) {
			diagnostics.push({ code: 'adapter.i18n_text_property_contract_mismatch', path: `${fieldPath}/textProperty`, message: `Mapped text Property ${mapping.textProperty} does not declare the required UIUX string value contract.` })
		}

		for (const [parameter, propertyName] of Object.entries(mapping.params ?? {})) {
			if (!inspection.properties?.has(propertyName)) {
				diagnostics.push({ code: 'adapter.i18n_parameter_property_missing', path: `${fieldPath}/params/${escapePointer(parameter)}`, message: `Mapped interpolation Property ${propertyName} is not declared by Widget plugin ${plugin.type}.` })
			}
		}
	}
	return diagnostics
}

function schemaDirectlyProvesStringField(schema: unknown, field: string): boolean {
	if (!isRecord(schema)) return false
	const properties = schema.properties
	if (!isRecord(properties) || !Object.hasOwn(properties, field)) return false
	const fieldSchema = properties[field]
	if (!isRecord(fieldSchema)) return false
	const type = fieldSchema.type
	return type === 'string'
		|| (Array.isArray(type) && type.length === 1 && type[0] === 'string')
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapePointer(value: string): string {
	return value.replaceAll('~', '~0').replaceAll('/', '~1')
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
