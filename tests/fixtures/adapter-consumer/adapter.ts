// A minimal third-party Adapter that imports only the public authoring entry `@deviltea/uiux/adapter` and the
// peer packages. tests/adapter-entry.test.ts and scripts/smoke-package.mjs type-check it as a consumer would.

import { createWidgetPlugin, createWidgetValueContract } from '@deviltea/widget-core'
import { useWidget } from '@deviltea/widget-vue'
import { defineComponent, h } from 'vue'
import {
	STRING_VALUE_CONTRACT_ID,
	TRANSLATION_RESULT_VALUE_CONTRACT_ID,
	WIDGET_ID_ATTRIBUTE,
	type AdapterApiVersion,
	type AdapterAssetCapability,
	type AdapterCatalog,
	type AdapterManifest,
	type AdapterProviderContext,
	type AdapterWidgetCatalogEntry,
	type I18nFieldMapping,
	type JsonValue,
	type RootShellInterfaces,
	type TranslationResult,
	type TranslationWarning,
} from '@deviltea/uiux/adapter'

const translationResultId: 'deviltea.uiux/translation-result@1' = TRANSLATION_RESULT_VALUE_CONTRACT_ID
const stringId: 'deviltea.uiux/string@1' = STRING_VALUE_CONTRACT_ID
const widgetIdAttribute: 'data-widget-id' = WIDGET_ID_ATTRIBUTE
export const STRING = createWidgetValueContract<string>(stringId)
export const TRANSLATION_RESULT = createWidgetValueContract<TranslationResult>(translationResultId)

const plugin = createWidgetPlugin('Label')
	.description('A label.')
	.interfaces<{ state: { text: string } }>()
	.state(state => state.text({ validate: (input): input is string => typeof input === 'string', default: () => '' }))
	.done()

const LabelRenderer = defineComponent({
	setup() {
		const { useState } = useWidget(plugin)
		const state = useState()
		return () => h('span', { [widgetIdAttribute]: 'label' }, state.text.value ?? '')
	},
})

const mapping: I18nFieldMapping = { configField: 'label', resultProperty: 'labelResult', textProperty: 'labelText' }
// The two Property names may be omitted; UIUX derives them from the authoring field.
export const derivedMapping: I18nFieldMapping = { configField: 'captionKey' }
const asset: AdapterAssetCapability = { acceptedMediaTypes: ['image/png'] }
const entry: AdapterWidgetCatalogEntry = { i18n: { fields: { label: mapping } }, assetFields: { icon: asset } }
const catalog: AdapterCatalog = { widgets: { Label: entry } }
const version: AdapterApiVersion = '1.0'
const config: JsonValue = { themeMap: { dark: 'midnight' } }
// An author may write the schema read-only, as with `as const`.
const configSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['themeMap'] } as const

export const manifest: AdapterManifest = {
	id: 'consumer-adapter',
	apiVersion: version,
	widgetPlugins: [plugin],
	catalog,
	renderers: [{ type: 'Label', component: LabelRenderer }],
	providers: [{ install(_app, context: AdapterProviderContext) { void context.adapterId } }],
	configSchema,
	// The Adapter maps Workspace theme IDs through its own configuration (Clause 01a11a5a-448c-76ba-94d4-6766435b9e2b).
	themeSupport: {
		supports(themeId, context) {
			const config = context.config
			const themeMap = typeof config === 'object' && config !== null && !Array.isArray(config) ? (config as { themeMap?: unknown }).themeMap : undefined
			return themeId === 'light' || (typeof themeMap === 'object' && themeMap !== null && Object.hasOwn(themeMap, themeId))
		},
	},
}

export function describeWarning(warning: TranslationWarning): string {
	switch (warning.code) {
		case 'missing-translation': return warning.fallbackLocale
		case 'unresolved-key': return warning.key
		case 'missing-parameter': return warning.parameter
	}
}

export type Root = RootShellInterfaces['state']['viewport']
export const values = [config]

// @ts-expect-error -- `apiVersion` is `1` or `1.<minor>`.
export const wrongVersion: AdapterApiVersion = '2'
// @ts-expect-error -- `configField` is required; only the Property names are derived.
export const noConfigField: I18nFieldMapping = { resultProperty: 'labelResult' }
// @ts-expect-error -- the warning union is closed.
export const otherWarning: TranslationWarning = { code: 'other', key: 'k', requestedLocale: 'en-US' }
// @ts-expect-error -- the theme-support predicate is synchronous and returns a boolean.
export const asyncThemeSupport: AdapterManifest['themeSupport'] = { supports: async () => true }
// @ts-expect-error -- the entry exports only the types its Clause lists.
import type { ReadonlyJsonValue } from '@deviltea/uiux/adapter'
export type NotExported = ReadonlyJsonValue
