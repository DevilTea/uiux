import type { AdapterWidgetCatalogEntry } from '../domain/adapters/schema'
import type { Diagnostic, JsonValue } from '../domain/validation'
import { lowerI18nBinding } from '../i18n/bindings'

export type EffectiveViewSourceResult =
	| Readonly<{ state: 'ready'; source: JsonValue; diagnostics: readonly [] }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>

/**
 * Projects canonical UIUX authoring bindings into the effective Widget source consumed by Core.
 * The canonical View JSON is never mutated. Ordinary literal Config values are left untouched.
 */
export function buildEffectiveViewSource(
	source: JsonValue,
	catalogByType: ReadonlyMap<string, AdapterWidgetCatalogEntry>,
): EffectiveViewSourceResult {
	const diagnostics: Diagnostic[] = []
	const effective = lowerWidget(source, '/ir', catalogByType, diagnostics)
	return diagnostics.length > 0
		? { state: 'invalid', diagnostics }
		: { state: 'ready', source: effective, diagnostics: [] }
}

function lowerWidget(
	value: JsonValue,
	path: string,
	catalogByType: ReadonlyMap<string, AdapterWidgetCatalogEntry>,
	diagnostics: Diagnostic[],
): JsonValue {
	if (!isJsonObject(value)) return value

	let changed = false
	let output: Record<string, JsonValue> = value
	const widgetType = typeof value.type === 'string' ? value.type : undefined
	const catalog = widgetType === undefined ? undefined : catalogByType.get(widgetType)

	if (isJsonObject(value.config)) {
		const loweredConfig = lowerI18nConfig(value.config, catalog?.i18n?.fields ?? {}, `${path}/config`, diagnostics)
		if (loweredConfig !== value.config) {
			output = { ...output, config: loweredConfig }
			changed = true
		}
	}

	if (isJsonObject(value.slots)) {
		let slotsChanged = false
		const loweredSlots: Record<string, JsonValue> = { ...value.slots }
		for (const [slotName, slotValue] of Object.entries(value.slots)) {
			if (!Array.isArray(slotValue)) continue
			const loweredChildren = slotValue.map((child, index) =>
				lowerWidget(child, `${path}/slots/${escapePointer(slotName)}/${index}`, catalogByType, diagnostics))
			if (loweredChildren.some((child, index) => child !== slotValue[index])) {
				loweredSlots[slotName] = loweredChildren
				slotsChanged = true
			}
		}
		if (slotsChanged) {
			if (!changed) output = { ...output }
			output.slots = loweredSlots
			changed = true
		}
	}

	return changed ? output : value
}

function lowerI18nConfig(
	config: Readonly<Record<string, JsonValue>>,
	fields: Readonly<Record<string, Readonly<{
		configField: string
		resultProperty: string
		textProperty: string
		params?: Readonly<Record<string, string>>
	}>>>,
	path: string,
	diagnostics: Diagnostic[],
): JsonValue {
	let output: Record<string, JsonValue> | undefined
	for (const [authorField, authored] of Object.entries(config)) {
		if (!isJsonObject(authored) || !Object.hasOwn(authored, '$i18n')) continue

		const fieldPath = `${path}/${escapePointer(authorField)}`
		const lowered = lowerI18nBinding({ binding: authored, authorField, fields, path: fieldPath })
		if (lowered.state === 'invalid') {
			diagnostics.push(...lowered.diagnostics)
			continue
		}
		const mapping = fields[authorField]!

		if (mapping.configField !== authorField && Object.hasOwn(config, mapping.configField)) {
			diagnostics.push({
				code: 'i18n.config_field_conflict',
				path: `${path}/${escapePointer(mapping.configField)}`,
				message: `Authored $i18n field ${authorField} cannot lower to ${mapping.configField} because that raw Config field is already present.`,
			})
			continue
		}

		output ??= { ...config }
		if (mapping.configField !== authorField) delete output[authorField]
		output[mapping.configField] = lowered.value.key
	}
	return output ?? config
}

function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapePointer(value: string): string {
	return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
