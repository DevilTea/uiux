import {
	jsonPointer,
	isCanonicalLocaleFilename,
	isCanonicalLocaleTag,
	isRecord,
	type JsonValue,
	validateJsonValue,
	Validator,
	type ValidationResult,
} from '../validation'

/** Property names in this DTO realize the accepted Workspace concepts. */
export type WorkspaceManifest = {
	schemaVersion: number
	i18n: { defaultLocale: string; [key: string]: JsonValue }
	viewports: Record<string, ViewportPreset>
	themes: Record<string, ThemeEntry>
}

export type WorkspaceAdapterSelection = {
	moduleSpecifier: string
	config?: JsonValue
}

export type ViewportPreset = {
	dimensions: { width: number; height: number; [key: string]: JsonValue }
	[key: string]: JsonValue
}

/** Theme entries deliberately remain open because only registry identity is fixed. */
export type ThemeEntry = { [key: string]: JsonValue }

export function isPortableAdapterModuleSpecifier(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value))
		return false
	if (value.startsWith('./'))
		return value.length > 2 && !value.includes('\\')
	if (value.startsWith('.') || value.startsWith('/') || value.startsWith('\\'))
		return false
	if (/^[A-Za-z]:/u.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value))
		return false
	return !value.includes('\\')
}

export function validateWorkspaceManifest(input: unknown): ValidationResult<WorkspaceManifest> {
	const v = new Validator()
	const root = v.object(input, '')
	if (!root)
		return v.finish<WorkspaceManifest>(input)
	validateJsonValue(input, '', v)

	if (!Number.isInteger(root.schemaVersion) || typeof root.schemaVersion !== 'number' || root.schemaVersion < 1)
		v.issue('workspace.invalid_schema_version', '/schemaVersion', 'Workspace schemaVersion must be a positive integer.')

	const i18n = v.object(root.i18n, '/i18n')
	if (i18n && !isCanonicalLocaleTag(i18n.defaultLocale))
		v.issue('workspace.invalid_default_locale', '/i18n/defaultLocale', 'Workspace defaultLocale must be a canonical BCP 47 tag.')

	// Clause 01a1144e-5336-73e7-84a0-3bcd0cb454f6: the manifest has no `adapters`; the Adapter list
	// lives in the Product Kit file.
	if (Object.hasOwn(root, 'adapters'))
		v.issue('schema.unknown_field', '/adapters', 'The Adapter list lives in the Product Kit file, not in the manifest.')

	validateRegistry(root.viewports, '/viewports', v, (entry, path) => {
		const viewport = v.object(entry, path)
		if (!viewport)
			return
		const dimensions = v.object(viewport.dimensions, `${path}/dimensions`)
		if (!dimensions)
			return
		for (const dimension of ['width', 'height'] as const) {
			v.finiteNumber(dimensions[dimension], `${path}/dimensions/${dimension}`)
		}
	})
	validateRegistry(root.themes, '/themes', v, (entry, path) => {
		if (!isRecord(entry))
			v.issue('workspace.invalid_theme_entry', path, 'Theme entry must be an object.')
	})

	return v.finish<WorkspaceManifest>(input)
}

/**
 * An ordered Adapter list (Clause 01a1144e-538e-705f-afdc-841028c410e4), in the Product Kit file.
 */
export function validateAdapterSelections(input: unknown, path: string, v: Validator): void {
	v.array(input, path)?.forEach((entry, index) => {
		const entryPath = jsonPointer(path, index)
		const adapter = v.object(entry, entryPath)
		if (!adapter)
			return
		if (!isPortableAdapterModuleSpecifier(adapter.moduleSpecifier))
			v.issue('workspace.invalid_adapter_specifier', `${entryPath}/moduleSpecifier`, 'Adapter moduleSpecifier must be a bare package specifier or a ./ Workspace-relative specifier.')
		if (Object.hasOwn(adapter, 'config'))
			validateJsonValue(adapter.config, `${entryPath}/config`, v)
	})
}

function validateRegistry(
	input: unknown,
	path: string,
	v: Validator,
	validateEntry: (entry: unknown, path: string) => void,
): void {
	const registry = v.object(input, path)
	if (!registry)
		return
	for (const [id, entry] of Object.entries(registry)) {
		if (id.length === 0)
			v.issue('workspace.empty_registry_key', path, 'Workspace registry keys must be non-empty strings.')
		validateEntry(entry, jsonPointer(path, id))
	}
}

/** Locale discovery is file based; non-canonical filenames are ignored. */
export function discoverLocaleFiles(filenames: readonly string[]): string[] {
	return filenames
		.filter(isCanonicalLocaleFilename)
		.map(filename => filename.slice(0, -'.json'.length))
		.sort()
}
