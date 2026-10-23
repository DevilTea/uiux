import type { AdapterAssetCapability, AdapterWidgetCatalogEntry } from '../domain/adapters/schema'
import { validateAssetBinding, validateAssetBindingCompatibility } from '../domain/assets/schema'
import type { I18nFieldMapping } from '../domain/i18n/schema'
import type { Diagnostic, JsonValue } from '../domain/validation'
import { lowerI18nBinding } from '../i18n/bindings'
import type { AssetResolutionTable } from '../assets/bindings'

export type EffectiveViewSourceResult =
	| Readonly<{ state: 'ready'; source: JsonValue; diagnostics: readonly [] }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>

/**
 * Projects canonical UIUX authoring bindings into the effective Widget source consumed by Core.
 * The canonical View JSON is never mutated. Ordinary literal Config values are left untouched.
 *
 * A top-level Config member `{ "$asset": "<assetId>" }` in a field the Catalog declares asset-capable is
 * replaced, under the same field name, by the frozen runtime value the server resolved for that Asset
 * (`assets`, Clause 01a167f4-3e4e-7af1-b328-30fb52f7f4c5). A binding in a field that is not asset-capable,
 * to an Asset the server blocked or did not resolve, or to one whose media type the field does not accept
 * makes the source invalid, and nothing stands in for it (Rules 01a115cd-c0d2-7427-8a95-927b2b3518c9 and
 * 01a115cd-c106-71d6-b1f8-4d59cab22ad2).
 */
export function buildEffectiveViewSource(
	source: JsonValue,
	catalogByType: ReadonlyMap<string, AdapterWidgetCatalogEntry>,
	assets: AssetResolutionTable = {},
): EffectiveViewSourceResult {
	const diagnostics: Diagnostic[] = []
	const effective = lowerWidget(source, '/ir', catalogByType, assets, diagnostics)
	return diagnostics.length > 0
		? { state: 'invalid', diagnostics }
		: { state: 'ready', source: effective, diagnostics: [] }
}

function lowerWidget(
	value: JsonValue,
	path: string,
	catalogByType: ReadonlyMap<string, AdapterWidgetCatalogEntry>,
	assets: AssetResolutionTable,
	diagnostics: Diagnostic[],
): JsonValue {
	if (!isJsonObject(value)) return value

	let changed = false
	let output: Record<string, JsonValue> = value
	const widgetType = typeof value.type === 'string' ? value.type : undefined
	const catalog = widgetType === undefined ? undefined : catalogByType.get(widgetType)

	if (isJsonObject(value.config)) {
		const i18nConfig = lowerI18nConfig(value.config, catalog?.i18n?.fields ?? {}, `${path}/config`, diagnostics)
		const loweredConfig = isJsonObject(i18nConfig)
			? lowerAssetConfig(i18nConfig, catalog?.assetFields ?? {}, `${path}/config`, assets, diagnostics)
			: i18nConfig
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
				lowerWidget(child, `${path}/slots/${escapePointer(slotName)}/${index}`, catalogByType, assets, diagnostics))
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
	fields: Readonly<Record<string, I18nFieldMapping>>,
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

/**
 * The diagnostics of every `$asset` binding in a View's IR, as rendering it would report them, without
 * building anything: the server's Checks and View diagnostics and formal capture (Rule
 * 01a167f4-472f-7ae9-8ebb-3075216ad94c). Without `catalogByType` (the Adapter set could not be resolved)
 * only the binding shapes and their Assets are checked, not the fields they are bound in.
 */
export function assetBindingDiagnostics(
	source: JsonValue,
	catalogByType: ReadonlyMap<string, AdapterWidgetCatalogEntry> | undefined,
	assets: AssetResolutionTable,
): readonly Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	function scan(value: JsonValue, path: string): void {
		if (!isJsonObject(value)) return
		if (isJsonObject(value.config)) {
			const widgetType = typeof value.type === 'string' ? value.type : undefined
			const fields = catalogByType === undefined ? undefined : (widgetType === undefined ? undefined : catalogByType.get(widgetType))?.assetFields ?? {}
			lowerAssetConfig(value.config, fields, `${path}/config`, assets, diagnostics)
		}
		if (!isJsonObject(value.slots)) return
		for (const [slotName, children] of Object.entries(value.slots)) {
			if (Array.isArray(children)) children.forEach((child, index) => scan(child, `${path}/slots/${escapePointer(slotName)}/${index}`))
		}
	}
	scan(source, '/ir')
	return diagnostics
}

/**
 * Lowers the `$asset` bindings of one Widget's Config; `fields` `undefined` means the Catalog is unknown,
 * so the fields are not checked (only diagnosing calls pass it).
 */
function lowerAssetConfig(
	config: Readonly<Record<string, JsonValue>>,
	fields: Readonly<Record<string, AdapterAssetCapability>> | undefined,
	path: string,
	assets: AssetResolutionTable,
	diagnostics: Diagnostic[],
): Readonly<Record<string, JsonValue>> {
	let output: Record<string, JsonValue> | undefined
	for (const [authorField, authored] of Object.entries(config)) {
		if (!isJsonObject(authored) || !Object.hasOwn(authored, '$asset')) continue

		const fieldPath = `${path}/${escapePointer(authorField)}`
		const binding = validateAssetBinding(authored, fieldPath)
		if (!binding.ok) {
			diagnostics.push(...binding.diagnostics)
			continue
		}
		const capability = fields !== undefined && Object.hasOwn(fields, authorField) ? fields[authorField] : undefined
		if (fields !== undefined && !capability) diagnostics.push(...validateAssetBindingCompatibility('', undefined, fieldPath).diagnostics)

		const assetId = binding.value.$asset
		const resolution = Object.hasOwn(assets, assetId) ? assets[assetId] : undefined
		if (!resolution) {
			diagnostics.push({ code: 'asset.unresolved_reference', path: `${fieldPath}/$asset`, message: `Asset ${assetId} was not resolved for this render.` })
			continue
		}
		if (resolution.state === 'blocked') {
			// The Asset's own diagnostics, located at the binding that names it.
			diagnostics.push(...resolution.diagnostics.map(item => ({ code: item.code, path: `${fieldPath}/$asset`, message: item.message })))
			continue
		}
		if (!capability) continue
		const compatibility = validateAssetBindingCompatibility(resolution.value.mediaType, capability, fieldPath)
		if (!compatibility.ok) {
			diagnostics.push(...compatibility.diagnostics)
			continue
		}
		output ??= { ...config }
		output[authorField] = Object.freeze({
			url: resolution.value.url,
			mediaType: resolution.value.mediaType,
			contentDigest: resolution.value.contentDigest,
		})
	}
	return output ?? config
}

function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapePointer(value: string): string {
	return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
