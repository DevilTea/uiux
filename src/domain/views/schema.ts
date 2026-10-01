import { jsonPointer, rejectUnknownKeys, validateJsonValue, validateUuid, Validator, type JsonValue, type ValidationResult } from '../validation'
import { validateViewSpec, type ViewSpec } from '../spec/schema'

export type VariantEntry = Readonly<{
	state: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>
	[key: string]: JsonValue
}>

export type ViewResource = Readonly<{
	id: string
	name: string
	feature?: string
	ir: JsonValue
	variants: Readonly<Record<string, VariantEntry>>
	spec: ViewSpec
}>

export type RootShellIdentity = Readonly<{ type: 'RootShell'; id: 'root' }>

/**
 * UIUX validates its reserved root identity while the Widget plugin owns the
 * executable IR and serialized Slot schema.
 */
export function validateRootShellIdentity(input: unknown, path = '/ir'): ValidationResult<RootShellIdentity> {
	const v = new Validator()
	const root = v.object(input, path)
	if (!root)
		return v.finish<RootShellIdentity>(input)
	if (root.type !== 'RootShell')
		v.issue('view.invalid_root_type', `${path}/type`, 'View IR must have the UIUX-managed RootShell as its root Widget.')
	if (root.id !== 'root')
		v.issue('view.invalid_root_id', `${path}/id`, 'The reserved RootShell identity is id "root".')
	return v.finish<RootShellIdentity>(input)
}

/** Called after the Widget contract resolves RootShell's required content Slot. */
export function validateRootShellContentSlot(children: unknown, path = '/ir/content'): ValidationResult<readonly JsonValue[]> {
	const v = new Validator()
	const list = v.array(children, path)
	list?.forEach((child, index) => validateJsonValue(child, jsonPointer(path, index), v))
	return v.finish<readonly JsonValue[]>(children)
}

export function validateViewResource(input: unknown, filename?: string): ValidationResult<ViewResource> {
	const v = new Validator()
	const view = v.object(input, '')
	if (!view)
		return v.finish<ViewResource>(input)
	validateJsonValue(input, '', v)
	rejectUnknownKeys(view, ['id', 'name', 'feature', 'ir', 'variants', 'spec'], '', v)
	const idIsUuid = validateUuid(view.id, '/id', v, 'View id')
	v.string(view.name, '/name', true)
	if (Object.hasOwn(view, 'feature'))
		v.string(view.feature, '/feature', true)
	validateRootShellIdentity(view.ir)
		.diagnostics.forEach(diagnostic => v.diagnostics.push(diagnostic))
	validateVariants(view.variants, v)
	const specResult = validateViewSpec(view.spec, '/spec')
	v.diagnostics.push(...specResult.diagnostics)
	if (filename !== undefined && idIsUuid) {
		const match = /^([0-9a-f-]+)\.view\.json$/iu.exec(filename)
		if (!match || match[1] !== view.id)
			v.issue('identity.filename_id_mismatch', '/id', 'View filename UUID must exactly match the immutable id.')
	}
	return v.finish<ViewResource>(input)
}

function validateVariants(value: unknown, v: Validator): void {
	const variants = v.object(value, '/variants')
	if (!variants)
		return
	for (const [name, entry] of Object.entries(variants)) {
		const path = jsonPointer('/variants', name)
		if (name.length === 0)
			v.issue('variant.empty_name', path, 'Variant names must be non-empty View-local identities.')
		const variant = v.object(entry, path)
		if (!variant)
			continue
		const state = v.object(variant.state, `${path}/state`)
		if (!state)
			continue
		for (const [widgetId, overrides] of Object.entries(state)) {
			if (widgetId.length === 0)
				v.issue('variant.empty_widget_id', `${path}/state`, 'Variant state keys must identify a Widget.')
			const widgetState = v.object(overrides, jsonPointer(`${path}/state`, widgetId))
			if (widgetState) {
				for (const property of Object.keys(widgetState)) {
					if (property.length === 0)
						v.issue('variant.empty_state_member', jsonPointer(`${path}/state/${widgetId}`, property), 'Variant state member keys must be non-empty.')
				}
				validateJsonValue(widgetState, jsonPointer(`${path}/state`, widgetId), v)
			}
		}
	}
}
