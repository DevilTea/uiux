import Ajv2020 from 'ajv/dist/2020.js'
import type { AnySchema } from 'ajv'
import {
	jsonPointer,
	isJsonValue,
	validateDigest,
	validateJsonValue,
	Validator,
	type Diagnostic,
	type JsonObject,
	type JsonValue,
	type ValidationResult,
} from '../validation'
import { derivedI18nPropertyNote, resolveI18nPropertyNames, validateI18nFieldMapping } from '../i18n/schema'
import { sha256Identity } from '../artifacts/schema'
import { canonicalJsonBytes } from '../canonical-json'
import type {
	AdapterAssetCapability,
	AdapterCatalog,
	AdapterManifest as AuthoredAdapterManifest,
	AdapterWidgetCatalogEntry,
} from '../../adapter-entry'

// The manifest and Catalog types are defined once, by the public Adapter authoring entry.
export type { AdapterAssetCapability, AdapterCatalog, AdapterWidgetCatalogEntry }

/** Draft 2020-12 schemas may be objects or the standard boolean schemas. */
export type JsonSchema2020_12 = JsonObject | boolean

/**
 * The manifest as UIUX validates it: the authoring entry's shape, with the runtime registration members
 * opaque (they remain owned by Widget and Adapter packages and are decoded by the runtime),
 * `apiVersion` any string the grammar check then judges, the non-normative `test` hook included, and
 * `configSchema`, which an author may write read-only, the JSON the schema validator reads.
 */
export type AdapterManifest<
	PluginDefinition = unknown,
	RendererRegistration = unknown,
	ProviderSetup = unknown,
> = Readonly<Omit<AuthoredAdapterManifest<PluginDefinition, RendererRegistration, ProviderSetup>, 'apiVersion' | 'configSchema'> & {
	apiVersion: string
	configSchema?: JsonSchema2020_12
}>

export type AuthoredAdapterConfig = Readonly<{ moduleSpecifier: string; config?: JsonValue }>
export type JsonSchemaIssue = Readonly<{ path: string; message: string }>
export type JsonSchema202012Validator = (
	schema: JsonSchema2020_12,
	value: JsonValue,
) => readonly JsonSchemaIssue[]

const DRAFT_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema'
const draft202012Ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })

/** The only JSON Schema execution boundary in UIUX: adapter-owned config. */
export function validateWithDraft202012(schema: JsonSchema2020_12, value: JsonValue): readonly JsonSchemaIssue[] {
	const validate = draft202012Ajv.compile(schema as AnySchema)
	if (validate(value)) return []
	return (validate.errors ?? []).map(error => ({
		path: error.instancePath ? `/config${error.instancePath}` : '/config',
		message: error.message ?? `${error.keyword} validation failed.`,
	}))
}

export function validateAdapterManifest(input: unknown): ValidationResult<AdapterManifest> {
	const v = new Validator()
	const manifest = v.object(input, '')
	if (!manifest)
		return v.finish<AdapterManifest>(input)
	v.string(manifest.id, '/id', true)
	v.string(manifest.apiVersion, '/apiVersion', true)
	for (const field of ['widgetPlugins', 'renderers', 'providers'] as const)
	v.array(manifest[field], `/${field}`)
	validateAdapterCatalog(manifest.catalog, '/catalog', v)
	if (Object.hasOwn(manifest, 'configSchema')) {
		const schemaValue = manifest.configSchema
		if (typeof schemaValue === 'boolean') {
			// A boolean schema has no `$schema` location; this contract applies it
			// under the only supported dialect, Draft 2020-12.
		}
		else {
			const schema = v.object(schemaValue, '/configSchema')
			if (schema && schema.$schema !== DRAFT_2020_12_URI)
				v.issue('adapter.unsupported_config_schema_dialect', '/configSchema/$schema', 'Adapter config schema must declare JSON Schema Draft 2020-12.')
		}
		validateJsonValue(schemaValue, '/configSchema', v)
	}
	return v.finish<AdapterManifest>(input)
}

function validateAdapterCatalog(input: unknown, path: string, v: Validator): void {
	const catalog = v.object(input, path)
	if (!catalog) return
	validateJsonValue(catalog, path, v)
	for (const misplaced of ['i18n', 'assetFields'] as const) {
		if (Object.hasOwn(catalog, misplaced))
			v.issue('adapter.catalog_widget_metadata_misplaced', `${path}/${misplaced}`, `Catalog ${misplaced} metadata must be declared under catalog.widgets.<widgetType>.`)
	}
	const widgets = v.object(catalog.widgets, `${path}/widgets`)
	if (!widgets) return
	for (const [widgetType, entryValue] of Object.entries(widgets)) {
		const entryPath = jsonPointer(`${path}/widgets`, widgetType)
		if (!widgetType) v.issue('adapter.empty_catalog_widget_type', `${path}/widgets`, 'Catalog Widget type identities must be non-empty.')
		const entry = v.object(entryValue, entryPath)
		if (!entry) continue
		validateAdapterWidgetCatalogEntry(entry, entryPath, v)
	}
}

function validateAdapterWidgetCatalogEntry(entry: Record<string, unknown>, path: string, v: Validator): void {
	if (Object.hasOwn(entry, 'i18n')) {
		const i18n = v.object(entry.i18n, `${path}/i18n`)
		const fields = i18n ? v.object(i18n.fields, `${path}/i18n/fields`) : undefined
		if (fields) {
			const mappedNames = new Map<string, string>()
			for (const [field, mapping] of Object.entries(fields)) {
				const fieldPath = jsonPointer(`${path}/i18n/fields`, field)
				if (!field) v.issue('adapter.empty_catalog_field', `${path}/i18n/fields`, 'Catalog author-field identities must be non-empty.')
				const validation = validateI18nFieldMapping(mapping, fieldPath)
				v.diagnostics.push(...validation.diagnostics)
				if (!validation.ok) continue
				// A derived Property name takes part exactly as a declared one (Clause 01a14e30-3676-7212-8cee-1ef84da6316c).
				const names = resolveI18nPropertyNames(field, validation.value)
				for (const [role, name] of [
					['configField', validation.value.configField],
					['resultProperty', names.resultProperty],
					['textProperty', names.textProperty],
				] as const) {
					const owner = mappedNames.get(name)
					if (owner !== undefined) v.issue('adapter.i18n_mapping_collision', `${fieldPath}/${role}`, `Mapped runtime member ${name}${derivedI18nPropertyNote(validation.value, role)} conflicts with ${owner}; i18n mapping names must be unique and non-conflicting within one Widget Catalog entry.`)
					else mappedNames.set(name, `${field}.${role}`)
				}
			}
		}
	}
	if (Object.hasOwn(entry, 'assetFields')) {
		const assetFields = v.object(entry.assetFields, `${path}/assetFields`)
		if (assetFields) {
			for (const [field, capabilityValue] of Object.entries(assetFields)) {
				const fieldPath = jsonPointer(`${path}/assetFields`, field)
				if (!field) v.issue('adapter.empty_catalog_field', fieldPath, 'Catalog author-field identities must be non-empty.')
				const capability = v.object(capabilityValue, fieldPath)
				if (!capability) continue
				const types = validateStringArray(capability.acceptedMediaTypes, `${fieldPath}/acceptedMediaTypes`, v)
				const categories = validateStringArray(capability.acceptedCategories, `${fieldPath}/acceptedCategories`, v)
				if (!types && !categories) v.issue('adapter.asset_capability_unbounded', fieldPath, 'An asset-capable field must declare accepted media types or categories.')
			}
		}
	}
}

/**
 * The shape of each `providers` entry (Clause 01a11a5a-4309-7ad5-8279-e1f60045017f): a Vue `Plugin`,
 * an object with an `install` function or a function. Server-side Adapter resolution applies it, so a
 * malformed entry makes the Adapter invalid on every surface (Rule 01a11a5a-4c2c-7330-8fac-11a6c970713a);
 * the Preview bundle applies it again to the members it imported. It only reads the entry: no provider
 * runs on the server (Rule 01a11a5a-4f4c-782a-8d6c-17150999333e). `path` is the manifest's path.
 */
export function validateAdapterProviders(manifest: AdapterManifest, path = ''): ValidationResult<readonly unknown[]> {
	const v = new Validator()
	manifest.providers.forEach((entry, index) => {
		if (!isProviderEntry(entry))
			v.issue('adapter.invalid_provider', `${path}/providers/${index}`, `Provider ${index} of Adapter ${manifest.id} must be a Vue plugin: an object with an install function, or a function.`)
	})
	return v.finish<readonly unknown[]>(manifest.providers)
}

/**
 * The shape of `themeSupport` (Clause 01a11a5a-448c-76ba-94d4-6766435b9e2b): when present, an object
 * whose `supports` is a function. Server-side Adapter resolution applies it, so a malformed member makes
 * the Adapter invalid on every surface (Rule 01a11a5a-4c2c-7330-8fac-11a6c970713a). It only reads the
 * member; asking the predicate is `evaluateAdapterThemeSupport`. `path` is the manifest's path.
 */
export function validateAdapterThemeSupport(manifest: AdapterManifest, path = ''): ValidationResult<AdapterManifest['themeSupport']> {
	const v = new Validator()
	if (Object.hasOwn(manifest, 'themeSupport')) {
		const member: unknown = manifest.themeSupport
		if (typeof member !== 'object' || member === null || typeof (member as { supports?: unknown }).supports !== 'function')
			v.issue('adapter.invalid_theme_support', `${path}/themeSupport`, `themeSupport of Adapter ${manifest.id} must be an object whose supports is a function.`)
	}
	return v.finish<AdapterManifest['themeSupport']>(manifest.themeSupport)
}

/** What asking one Adapter's theme-support predicate about every Workspace theme found. */
export type AdapterThemeSupportEvaluation = Readonly<{
	/** The theme IDs the predicate rejected, or could not answer for, in the order asked. */
	unsupportedThemeIds: readonly string[]
	/** One Adapter diagnostic per theme whose predicate threw or returned a non-boolean. */
	diagnostics: readonly Diagnostic[]
}>

/**
 * Asks a validated `themeSupport` predicate about each Workspace theme ID (Rules
 * 01a11a5a-5464-7797-82d3-f8ece37457e5, 01a11a5a-54e2-7216-a5a1-0de226971850 and
 * 01a11a5a-555f-7b4c-8fcc-311c31a99b7a): without the member every theme is supported; `false` makes a
 * theme unsupported, and a predicate that throws or returns a non-boolean (a promise included) is an
 * Adapter diagnostic and makes that theme unsupported too (fail closed). `config` is the Adapter
 * entry's validated configuration, passed deep-frozen so a predicate cannot change what the Preview
 * receives. `path` is the manifest's path.
 */
export function evaluateAdapterThemeSupport(
	manifest: AdapterManifest,
	config: JsonValue | undefined,
	themeIds: readonly string[],
	path = '',
): AdapterThemeSupportEvaluation {
	const themeSupport = manifest.themeSupport
	if (!themeSupport) return { unsupportedThemeIds: [], diagnostics: [] }
	const context = Object.freeze({ config: config === undefined ? undefined : deepFrozenCopy(config) })
	const unsupportedThemeIds: string[] = []
	const diagnostics: Diagnostic[] = []
	for (const themeId of themeIds) {
		let answer: unknown
		try {
			answer = themeSupport.supports(themeId, context)
		}
		catch (cause) {
			unsupportedThemeIds.push(themeId)
			diagnostics.push({
				code: 'adapter.theme_support_failed',
				path: `${path}/themeSupport`,
				message: `themeSupport.supports of Adapter ${manifest.id} threw for the theme ${themeId}, so that theme counts as unsupported: ${cause instanceof Error ? cause.message : String(cause)}`,
			})
			continue
		}
		if (typeof answer !== 'boolean') {
			// A returned promise is never awaited; its rejection must not surface as an unhandled one.
			if (typeof (answer as { then?: unknown } | null)?.then === 'function') Promise.resolve(answer).catch(() => undefined)
			unsupportedThemeIds.push(themeId)
			diagnostics.push({
				code: 'adapter.theme_support_failed',
				path: `${path}/themeSupport`,
				message: `themeSupport.supports of Adapter ${manifest.id} returned a non-boolean for the theme ${themeId}, so that theme counts as unsupported; the predicate is synchronous and returns a boolean.`,
			})
			continue
		}
		if (!answer) unsupportedThemeIds.push(themeId)
	}
	return { unsupportedThemeIds, diagnostics }
}

function deepFrozenCopy(value: JsonValue): JsonValue {
	const copy = structuredClone(value)
	const freeze = (member: unknown): void => {
		if (typeof member !== 'object' || member === null || Object.isFrozen(member)) return
		Object.freeze(member)
		for (const child of Object.values(member)) freeze(child)
	}
	freeze(copy)
	return copy
}

/** A Vue `Plugin`: a function, or an object (a function too may carry `install`) with an `install` function. */
export function isProviderEntry(entry: unknown): entry is ((...args: unknown[]) => unknown) | { install: (...args: unknown[]) => unknown } {
	if (typeof entry === 'function') return true
	return typeof entry === 'object' && entry !== null && typeof (entry as { install?: unknown }).install === 'function'
}

export function validateAdapterConfigSchema(
	schema: JsonSchema2020_12 | undefined,
): ValidationResult<JsonSchema2020_12 | undefined> {
	const v = new Validator()
	if (schema === undefined)
		return v.finish<JsonSchema2020_12 | undefined>(undefined)
	if (typeof schema !== 'boolean' && schema.$schema !== DRAFT_2020_12_URI) {
		v.issue('adapter.unsupported_config_schema_dialect', '/configSchema/$schema', 'Adapter config schema must declare JSON Schema Draft 2020-12.')
		return v.finish<JsonSchema2020_12 | undefined>(schema)
	}
	try {
		draft202012Ajv.compile(schema as AnySchema)
	}
	catch {
		v.issue('adapter.invalid_config_schema', '/configSchema', 'Adapter config schema could not be compiled as Draft 2020-12.')
	}
	return v.finish<JsonSchema2020_12 | undefined>(schema)
}

/** Applies the adapter-owned schema through its Draft 2020-12 implementation. */
export function validateAdapterConfig(
	config: unknown,
	schema: JsonSchema2020_12 | undefined,
	jsonSchemaValidator: JsonSchema202012Validator = validateWithDraft202012,
): ValidationResult<JsonValue | undefined> {
	const v = new Validator()
	if (config === undefined)
		return v.finish<JsonValue | undefined>(undefined)
	if (!isJsonValue(config)) {
		v.issue('adapter.config_not_json_value', '/config', 'Adapter config must be a JSON-compatible JSON value.')
		return v.finish<JsonValue | undefined>(config)
	}
	if (schema === undefined) {
		v.issue('adapter.config_schema_required', '/config', 'Adapter-specific config is not accepted without an adapter-provided schema.')
		return v.finish<JsonValue | undefined>(config)
	}
	const schemaValidation = validateAdapterConfigSchema(schema)
	if (!schemaValidation.ok) {
		v.diagnostics.push(...schemaValidation.diagnostics)
		return v.finish<JsonValue | undefined>(config)
	}
	try {
		for (const issue of jsonSchemaValidator(schema, config))
			v.issue('adapter.config_schema_violation', issue.path || '/config', issue.message)
	}
	catch {
		v.issue('adapter.invalid_config_schema', '/configSchema', 'Adapter config schema could not be applied by the Draft 2020-12 validator.')
	}
	return v.finish<JsonValue | undefined>(config)
}

export type ResolvedAdapterRegistries = Readonly<{
	id: string
	widgetTypes: readonly string[]
	rendererKeys: readonly string[]
	catalogKeys: readonly string[]
}>

/** Checks unique semantic ownership across the complete, ordered resolved set. */
export function validateResolvedAdapterSet(adapters: readonly ResolvedAdapterRegistries[]): ValidationResult<readonly ResolvedAdapterRegistries[]> {
	const v = new Validator()
	for (const field of ['id', 'widgetTypes', 'rendererKeys', 'catalogKeys'] as const) {
		const owners = new Map<string, number>()
		adapters.forEach((adapter, index) => {
			const values = field === 'id' ? [adapter.id] : adapter[field]
			values.forEach((key, keyIndex) => {
				if (typeof key !== 'string' || key.length === 0) {
					v.issue('adapter.invalid_registry_identity', `/${index}/${field}/${keyIndex}`, 'Resolved adapter registry identities must be non-empty strings.')
					return
				}
				const first = owners.get(key)
				if (first !== undefined)
					v.issue('adapter.registry_collision', `/${index}/${field}/${keyIndex}`, `Registry identity collides with adapter at index ${first}; adapter order does not grant override authority.`)
				else
					owners.set(key, index)
			})
		})
	}
	return v.finish<readonly ResolvedAdapterRegistries[]>(adapters)
}

export type AdapterProvenance = Readonly<{
	moduleSpecifier: string
	adapterId: string
	apiVersion: string
	moduleIdentity: string
	packageVersion?: string
	contentDigest?: string
	/** The `sha256:` identity of the canonical JSON of the Adapter entry's `config`; absent when the entry has none. */
	configDigest?: string
}>

/**
 * `configDigest` (Clause 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5): the `sha256:` identity of the canonical
 * JSON of an Adapter entry's `config`, `undefined` when the entry has none.
 */
export async function adapterConfigDigest(config: JsonValue | undefined): Promise<string | undefined> {
	return config === undefined ? undefined : await sha256Identity(canonicalJsonBytes(config))
}

export function validateAdapterProvenance(input: unknown, path = ''): ValidationResult<AdapterProvenance> {
	const v = new Validator()
	const provenance = v.object(input, path)
	if (!provenance)
		return v.finish<AdapterProvenance>(input)
	v.string(provenance.moduleIdentity, `${path}/moduleIdentity`, true)
	validateAdapterProvenanceMembers(provenance, path, v)
	return v.finish<AdapterProvenance>(input)
}

/**
 * The members a Handoff Adapter provenance entry shares with the one a formal capture records
 * (Clauses 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5 and 01a1161c-008a-746d-8d53-a8301b23588f): all but
 * the host-specific `moduleIdentity`, with a package version or a content digest.
 */
export function validateAdapterProvenanceMembers(provenance: Readonly<Record<string, unknown>>, path: string, v: Validator): void {
	for (const key of ['moduleSpecifier', 'adapterId', 'apiVersion'] as const)
		v.string(provenance[key], `${path}/${key}`, true)
	if (Object.hasOwn(provenance, 'packageVersion')) v.string(provenance.packageVersion, `${path}/packageVersion`, true)
	if (Object.hasOwn(provenance, 'contentDigest')) validateDigest(provenance.contentDigest, `${path}/contentDigest`, v)
	if (Object.hasOwn(provenance, 'configDigest')) validateDigest(provenance.configDigest, `${path}/configDigest`, v)
	if (!Object.hasOwn(provenance, 'packageVersion') && !Object.hasOwn(provenance, 'contentDigest'))
		v.issue('adapter.provenance_unverifiable', path, 'Adapter provenance requires a package version when available or a verifiable content digest for a local adapter.')
}

function validateStringArray(value: unknown, path: string, v: Validator): boolean {
	if (value === undefined)
		return false
	const values = v.array(value, path)
	if (!values)
		return false
	values.forEach((item, index) => v.string(item, jsonPointer(path, index), true))
	if (values.length === 0)
		v.issue('adapter.empty_media_allowlist', path, 'A declared allowlist must contain at least one entry.')
	return values.length > 0
}
