import type { AnyWidgetPlugin } from '@deviltea/widget-core'
import { inspectPlugin, WidgetInspectionError } from '@deviltea/widget-core/inspection'

import type { AdapterWidgetCatalogEntry } from '../domain/adapters/schema'
import { resolveI18nPropertyNames } from '../domain/i18n/schema'

/**
 * One row of the Workbench's Catalog view (Rule 01a116f0-8b11-7eba-96eb-786ba7098589, Discussion #241
 * owner ruling 2026-10-26): a Widget type of an active Adapter with what its plugin declares and what
 * its Catalog entry adds. Declaration metadata only, read in the server's one bundle evaluation: no
 * Runtime is created and nothing is persisted. It is not a wire contract.
 */
export type DescribedWidgetCatalogEntry = Readonly<{
	adapterIndex: number
	adapterId: string
	type: string
	/** The plugin's own description of the Widget type. */
	description: string
	/** `null` when the plugin declares no Config. */
	config: Readonly<{ description: string; schema: unknown }> | null
	properties: readonly Readonly<{ name: string; valueContractId: string | null }>[]
	state: readonly Readonly<{ name: string; authorWritable: boolean }>[]
	events: readonly Readonly<{ name: string; description: string }>[]
	/** The Catalog's i18n mapping per translatable authoring field, the omitted Property names resolved. */
	i18n: readonly Readonly<{
		authorField: string
		configField: string
		resultProperty: string
		textProperty: string
		params: Readonly<Record<string, string>>
	}>[]
	/** The asset-capable authoring fields and what each accepts. */
	assetFields: readonly Readonly<{
		field: string
		acceptedMediaTypes: readonly string[]
		acceptedCategories: readonly string[]
	}>[]
}>

export type DescribedWidgetCatalog = readonly DescribedWidgetCatalogEntry[]

/** The row of one decoded plugin and its Catalog entry (absent when the Adapter declares none for the type). */
export function describeWidgetCatalogEntry(input: Readonly<{
	adapterIndex: number
	adapterId: string
	plugin: AnyWidgetPlugin
	catalog: AdapterWidgetCatalogEntry | undefined
}>): DescribedWidgetCatalogEntry {
	const { plugin, catalog } = input
	// widget-core documents that inspectPlugin rejects a plugin this module instance did not complete
	// with `WidgetInspectionError`: such a plugin has no known members. Any other exception is a defect.
	let inspection: ReturnType<typeof inspectPlugin> | undefined
	try {
		inspection = inspectPlugin(plugin)
	}
	catch (cause) {
		if (!(cause instanceof WidgetInspectionError)) throw cause
	}
	return Object.freeze({
		adapterIndex: input.adapterIndex,
		adapterId: input.adapterId,
		type: plugin.type,
		description: plugin.description,
		config: plugin.config ? Object.freeze({ description: plugin.config.description, schema: plugin.config.schema }) : null,
		properties: Object.freeze([...(inspection?.properties?.values() ?? [])].map(member => Object.freeze({ name: String(member.name), valueContractId: member.valueContractId }))),
		state: Object.freeze([...(inspection?.state?.values() ?? [])].map(member => Object.freeze({ name: String(member.name), authorWritable: member.authorWritable }))),
		events: Object.freeze([...(inspection?.events?.values() ?? [])].map(member => Object.freeze({ name: String(member.name), description: member.description }))),
		i18n: Object.freeze(Object.entries(catalog?.i18n?.fields ?? {}).map(([authorField, mapping]) => {
			const names = resolveI18nPropertyNames(authorField, mapping)
			return Object.freeze({ authorField, configField: mapping.configField, resultProperty: names.resultProperty, textProperty: names.textProperty, params: Object.freeze({ ...mapping.params }) })
		})),
		assetFields: Object.freeze(Object.entries(catalog?.assetFields ?? {}).map(([field, capability]) => Object.freeze({
			field,
			acceptedMediaTypes: Object.freeze([...(capability.acceptedMediaTypes ?? [])]),
			acceptedCategories: Object.freeze([...(capability.acceptedCategories ?? [])]),
		}))),
	})
}

/** A report from the worker that is the shape `DescribedWidgetCatalog` promises (it crossed a structured clone). */
export function isDescribedWidgetCatalog(value: unknown): value is DescribedWidgetCatalog {
	return Array.isArray(value) && value.every(isEntry)
}

function isEntry(value: unknown): value is DescribedWidgetCatalogEntry {
	if (!value || typeof value !== 'object') return false
	const entry = value as Record<string, unknown>
	return typeof entry.adapterIndex === 'number' && typeof entry.adapterId === 'string'
		&& typeof entry.type === 'string' && typeof entry.description === 'string'
		&& Array.isArray(entry.properties) && Array.isArray(entry.state) && Array.isArray(entry.events)
		&& Array.isArray(entry.i18n) && Array.isArray(entry.assetFields)
}
