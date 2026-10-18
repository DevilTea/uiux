// The public Adapter authoring entry `@deviltea/uiux/adapter` (Contract 01a115cd-cdb2-7d01-9485-dd50fee323a3,
// Clauses 01a11a5a-462c-7f59-af78-6d01787a275f, 01a11a5a-46ac-75d1-99a4-1b06c8480028,
// 01a11a5a-472a-74f0-9d70-81a3b7f477a6 and 01a11a5a-47bf-7a84-acc5-5ac420b500b1).
//
// These declarations are the one definition of the Adapter author types: UIUX's own modules import them
// from here (`src/domain/adapters/schema.ts`, `src/domain/i18n/schema.ts`, `src/runtime/root-shell.ts`,
// `src/domain/validation.ts`), so nothing is defined twice. They may import types only from
// `@deviltea/widget-core`, `@deviltea/widget-vue` and `vue`, the packages an Adapter declares as peer
// dependencies. The entry follows the Adapter API version (Rule 01a11a5a-53e6-7292-a6a6-a45eae1e66d7): a new
// minor only adds to it, and a breaking type change needs a new major version.

import type { AnyWidgetPlugin } from '@deviltea/widget-core'
import type { Component, Plugin } from 'vue'

/** A JSON value: what Catalog metadata, Adapter configuration and its schema are made of. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * The manifest `apiVersion`: `1` or `1.<minor>`, the lowest minor of Adapter API version 1 whose behavior
 * the Adapter relies on. The server's grammar (Clause 01a115cd-d095-790b-bc0b-95297733fed4) is
 * authoritative: TypeScript cannot express it, so this type also admits strings the server refuses, such
 * as `1.01`, `1.-1` or `1.1e3`. The entry deliberately exports no value naming the API version a host
 * implements.
 */
export type AdapterApiVersion = '1' | `1.${number}`

/** `catalog.widgets.<widgetType>.assetFields.<authorField>`: at least one non-empty list. */
export type AdapterAssetCapability = Readonly<{
	acceptedMediaTypes?: readonly string[]
	acceptedCategories?: readonly string[]
}>

/**
 * `catalog.widgets.<widgetType>.i18n.fields.<authorField>`, keyed by the translatable authoring field.
 * An omitted `textProperty` is `<authorField>` and an omitted `resultProperty` is `<authorField>Result`
 * (Clause 01a14e30-3676-7212-8cee-1ef84da6316c); UIUX validates a derived name as it validates a declared one.
 */
export type I18nFieldMapping = Readonly<{
	/** A top-level raw Config member, declared `type: "string"`, that holds the literal key. */
	configField: string
	/**
	 * A read-only computed Property with the value contract `TRANSLATION_RESULT_VALUE_CONTRACT_ID`;
	 * `<authorField>Result` when omitted.
	 */
	resultProperty?: string
	/** A read-only computed Property with the value contract `STRING_VALUE_CONTRACT_ID`; `<authorField>` when omitted. */
	textProperty?: string
	/** Placeholder names mapped to readable Properties. */
	params?: Readonly<Record<string, string>>
}>

/**
 * A JSON value whose arrays and objects may be read-only: the type of what an author writes (the Catalog's
 * other members, which the named members `i18n`, `assetFields` and `widgets` must also fit, and
 * `configSchema`) and of the deep-frozen configuration a provider receives.
 */
type ReadonlyJsonValue = string | number | boolean | null | readonly ReadonlyJsonValue[] | Readonly<{ [key: string]: ReadonlyJsonValue }>

/** The Catalog authoring metadata of one Widget type. */
export type AdapterWidgetCatalogEntry = Readonly<{
	i18n?: Readonly<{ fields: Readonly<Record<string, I18nFieldMapping>>; [key: string]: ReadonlyJsonValue }>
	assetFields?: Readonly<Record<string, AdapterAssetCapability>>
}> & Readonly<{
	[key: string]: ReadonlyJsonValue
}>

/** The manifest `catalog`: Widget metadata only under `widgets.<widgetType>`; the root is reserved. */
export type AdapterCatalog = Readonly<{
	widgets: Readonly<Record<string, AdapterWidgetCatalogEntry>>
}> & Readonly<{
	[key: string]: ReadonlyJsonValue
}>

/**
 * The install context a provider receives as its `app.use` options: frozen, with the Adapter entry's
 * validated configuration deep-frozen, or `undefined` when the entry has none.
 */
export type AdapterProviderContext = Readonly<{
	adapterId: string
	config: ReadonlyJsonValue | undefined
}>

/**
 * The Adapter manifest (Clause 01a115cd-d026-757d-a3ae-49d4dbf57538). The type parameters default to the
 * concrete author shapes: `@deviltea/widget-core` Widget plugins, `{ type, component }` Vue renderer
 * registrations and Vue plugins as providers.
 */
export type AdapterManifest<
	WidgetPluginDefinition = AnyWidgetPlugin,
	RendererRegistration = Readonly<{ type: string; component: Component }>,
	Provider = Plugin<AdapterProviderContext>,
> = Readonly<{
	id: string
	apiVersion: AdapterApiVersion
	widgetPlugins: readonly WidgetPluginDefinition[]
	catalog: AdapterCatalog
	renderers: readonly RendererRegistration[]
	providers: readonly Provider[]
	/** A JSON Schema Draft 2020-12 schema: a boolean, or an object whose `$schema` names that dialect. */
	configSchema?: Readonly<{ [key: string]: ReadonlyJsonValue }> | boolean
}>

/** A warning of RootShell's `t`; the union is closed, and another code needs a contract extension. */
export type TranslationWarning =
	| Readonly<{ code: 'missing-translation'; key: string; requestedLocale: string; fallbackLocale: string }>
	| Readonly<{ code: 'unresolved-key'; key: string; requestedLocale: string }>
	| Readonly<{ code: 'missing-parameter'; key: string; requestedLocale: string; parameter: string }>

/** What RootShell's `t` returns. */
export type TranslationResult = Readonly<{ text: string; warnings: readonly TranslationWarning[] }>

/** The interfaces of the UIUX-owned `RootShell` Widget, the root an Adapter Widget reads its context from. */
export interface RootShellInterfaces {
	slots: 'content'
	state: {
		locale: string
		viewport: Readonly<{ id: string; width: number; height: number }>
		themeId: string
		/** `null` for the base state. */
		variantName: string | null
	}
	methods: {
		t: (key: string, params?: Readonly<Record<string, string>>) => TranslationResult
	}
}

/** The value contract of a `resultProperty`. */
export declare const TRANSLATION_RESULT_VALUE_CONTRACT_ID: 'deviltea.uiux/translation-result@1'
/** The value contract of a `textProperty`. */
export declare const STRING_VALUE_CONTRACT_ID: 'deviltea.uiux/string@1'
/** The attribute an Adapter renderer puts on the outermost element it renders for a Widget, valued with its ID. */
export declare const WIDGET_ID_ATTRIBUTE: 'data-widget-id'

// In a declaration file every top-level declaration is exported unless the file has an export list; this
// empty one keeps `ReadonlyJsonValue` and the imported peer types private.
export {}
