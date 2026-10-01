import Ajv2020 from 'ajv/dist/2020'
import type { AnySchema } from 'ajv'
import {
	jsonPointer,
	isJsonValue,
	validateDigest,
	validateJsonValue,
	Validator,
	type JsonObject,
	type JsonValue,
	type ValidationResult,
} from '../validation'
import { validateI18nFieldMapping, type I18nFieldMapping } from '../i18n/schema'

/** Draft 2020-12 schemas may be objects or the standard boolean schemas. */
export type JsonSchema2020_12 = JsonObject | boolean
export type AdapterAssetCapability = Readonly<{
	acceptedMediaTypes?: readonly string[]
	acceptedCategories?: readonly string[]
}>
export type AdapterCatalog = Readonly<{
	i18n?: Readonly<{ fields: Readonly<Record<string, I18nFieldMapping>>; [key: string]: JsonValue }>
	assetFields?: Readonly<Record<string, AdapterAssetCapability>>
	[key: string]: JsonValue
}>

/** Runtime registration members remain owned by Widget and Adapter packages. */
export type AdapterManifest<
	PluginDefinition = unknown,
	RendererRegistration = unknown,
	ProviderSetup = unknown,
	StyleOrTokenResource = unknown,
> = Readonly<{
	id: string
	apiVersion: string
	widgetPlugins: readonly PluginDefinition[]
	catalog: AdapterCatalog
	renderers: readonly RendererRegistration[]
	providers: readonly ProviderSetup[]
	styles: readonly StyleOrTokenResource[]
	tokens: readonly StyleOrTokenResource[]
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
	for (const field of ['widgetPlugins', 'renderers', 'providers', 'styles', 'tokens'] as const)
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
	if (!catalog)
		return
	if (Object.hasOwn(catalog, 'i18n')) {
		const i18n = v.object(catalog.i18n, `${path}/i18n`)
		const fields = i18n ? v.object(i18n.fields, `${path}/i18n/fields`) : undefined
		if (fields) {
			const mappedNames = new Map<string, string>()
			for (const [field, mapping] of Object.entries(fields)) {
				const fieldPath = jsonPointer(`${path}/i18n/fields`, field)
				if (!field)
					v.issue('adapter.empty_catalog_field', `${path}/i18n/fields`, 'Catalog author-field identities must be non-empty.')
				const validation = validateI18nFieldMapping(mapping, fieldPath)
				v.diagnostics.push(...validation.diagnostics)
				if (!validation.ok) continue
				for (const [role, name] of [
					['configField', validation.value.configField],
					['resultProperty', validation.value.resultProperty],
					['textProperty', validation.value.textProperty],
				] as const) {
					const owner = mappedNames.get(name)
					if (owner !== undefined)
						v.issue('adapter.i18n_mapping_collision', `${fieldPath}/${role}`, `Mapped runtime member ${name} conflicts with ${owner}; i18n mapping names must be unique and non-conflicting.`)
					else
						mappedNames.set(name, `${field}.${role}`)
				}
			}
		}
	}
	if (Object.hasOwn(catalog, 'assetFields')) {
		const assetFields = v.object(catalog.assetFields, `${path}/assetFields`)
		if (assetFields) {
			for (const [field, capabilityValue] of Object.entries(assetFields)) {
				const fieldPath = jsonPointer(`${path}/assetFields`, field)
				if (!field)
					v.issue('adapter.empty_catalog_field', fieldPath, 'Catalog author-field identities must be non-empty.')
				const capability = v.object(capabilityValue, fieldPath)
				if (!capability)
					continue
				const types = validateStringArray(capability.acceptedMediaTypes, `${fieldPath}/acceptedMediaTypes`, v)
				const categories = validateStringArray(capability.acceptedCategories, `${fieldPath}/acceptedCategories`, v)
				if (!types && !categories)
					v.issue('adapter.asset_capability_unbounded', fieldPath, 'An asset-capable field must declare accepted media types or categories.')
			}
		}
	}
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
}>

export function validateAdapterProvenance(input: unknown, path = ''): ValidationResult<AdapterProvenance> {
	const v = new Validator()
	const provenance = v.object(input, path)
	if (!provenance)
		return v.finish<AdapterProvenance>(input)
	for (const key of ['moduleSpecifier', 'adapterId', 'apiVersion', 'moduleIdentity'] as const)
		v.string(provenance[key], `${path}/${key}`, true)
	if (Object.hasOwn(provenance, 'packageVersion')) v.string(provenance.packageVersion, `${path}/packageVersion`, true)
	if (Object.hasOwn(provenance, 'contentDigest')) validateDigest(provenance.contentDigest, `${path}/contentDigest`, v)
	if (!Object.hasOwn(provenance, 'packageVersion') && !Object.hasOwn(provenance, 'contentDigest'))
		v.issue('adapter.provenance_unverifiable', path, 'Adapter provenance requires a package version when available or a verifiable content digest for a local adapter.')
	return v.finish<AdapterProvenance>(input)
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
