import type { DescribedWidgetCatalogEntry } from '../../src/preview/widget-catalog'
import { catalogEntryOf, type FindingResource, type ViewUsage } from './checks'

/**
 * The Catalog block of the Product Kit page's Components section (Rule
 * 01a17443-6b37-797e-963c-282f2ec400a7): the rows, which Views use each entry and each entry's
 * problems. Pure, over the server's Catalog read, the Adapter set's diagnostics and the Views'
 * Widgets as Checks reads them; nothing is persisted.
 */

export type CatalogDiagnostic = Readonly<{ code: string; path: string; message: string }>

/**
 * - `used`: at least one View has a Widget of the type.
 * - `unused`: every View was read and none has one.
 * - `unknown`: a View was not read, or its Widgets could not be derived, so the entry is not said to be unused.
 */
export type CatalogUsageState = 'used' | 'unused' | 'unknown'

export type CatalogRow = Readonly<{
	entry: DescribedWidgetCatalogEntry
	/** `<adapterIndex>:<type>`: the same type of two Adapters cannot share one key. */
	key: string
	usage: CatalogUsageState
	views: readonly Readonly<{ resource: FindingResource; widgets: number }>[]
	problems: readonly CatalogDiagnostic[]
}>

export type CatalogView = Readonly<{
	rows: readonly CatalogRow[]
	/** Problems that name no listed entry: the Adapter set's own, or an entry the Catalog read did not list. */
	setProblems: readonly CatalogDiagnostic[]
}>

export function catalogRowKey(entry: Readonly<{ adapterIndex: number; type: string }>): string {
	return `${entry.adapterIndex}:${entry.type}`
}

/** Only the Catalog's own problems: a diagnostic whose path names an Adapter's Catalog entry or the Adapter set. */
export function isCatalogProblem(diagnostic: CatalogDiagnostic): boolean {
	return diagnostic.path.startsWith('/adapters/')
}

export function catalogView(
	entries: readonly DescribedWidgetCatalogEntry[],
	usage: readonly ViewUsage[],
	usageComplete: boolean,
	diagnostics: readonly CatalogDiagnostic[],
): CatalogView {
	const known = new Set(entries.map(catalogRowKey))
	const attributed = new Map<string, CatalogDiagnostic[]>()
	const setProblems: CatalogDiagnostic[] = []
	for (const diagnostic of diagnostics) {
		const target = catalogEntryOf(diagnostic.path)
		const key = target ? catalogRowKey({ adapterIndex: target.adapterIndex, type: target.widgetType }) : undefined
		if (key && known.has(key)) attributed.set(key, [...attributed.get(key) ?? [], diagnostic])
		else setProblems.push(diagnostic)
	}
	const rows = entries.map((entry): CatalogRow => {
		const key = catalogRowKey(entry)
		const views = usage
			.map(view => ({ resource: view.resource, widgets: view.widgets.filter(widget => widget.type === entry.type).length }))
			.filter(view => view.widgets > 0)
		return {
			entry,
			key,
			views,
			usage: views.length ? 'used' : usageComplete ? 'unused' : 'unknown',
			problems: attributed.get(key) ?? [],
		}
	})
	return { rows, setProblems }
}

/** Rows whose Adapter, type or description contains the text, case-insensitively; all rows for blank text. */
export function filterCatalogRows(rows: readonly CatalogRow[], text: string): readonly CatalogRow[] {
	const needle = text.trim().toLowerCase()
	if (!needle) return rows
	return rows.filter(row => [row.entry.adapterId, row.entry.type, row.entry.description].some(value => value.toLowerCase().includes(needle)))
}

export type ConfigProperty = Readonly<{ name: string; type: string; required: boolean; description: string }>

/**
 * The top-level members a Config JSON Schema declares, for a table; an unreadable schema yields none
 * (the raw schema is shown as well). `type` is the schema's `type` (a union joined by `|`), `enum` and
 * `$ref` shown as they are.
 */
export function configProperties(schema: unknown): readonly ConfigProperty[] {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return []
	const record = schema as Record<string, unknown>
	const properties = record.properties
	if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return []
	const required = new Set(Array.isArray(record.required) ? record.required.filter((name): name is string => typeof name === 'string') : [])
	return Object.entries(properties as Record<string, unknown>).map(([name, member]) => {
		const value = member && typeof member === 'object' && !Array.isArray(member) ? member as Record<string, unknown> : {}
		return { name, type: schemaType(value), required: required.has(name), description: typeof value.description === 'string' ? value.description : '' }
	})
}

function schemaType(value: Readonly<Record<string, unknown>>): string {
	if (typeof value.type === 'string') return value.type
	if (Array.isArray(value.type)) return value.type.filter((item): item is string => typeof item === 'string').join(' | ')
	if (Array.isArray(value.enum)) return value.enum.map(item => JSON.stringify(item)).join(' | ')
	if (typeof value.$ref === 'string') return value.$ref
	return ''
}
