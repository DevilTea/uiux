import { describe, expect, it } from 'vitest'
import { createWidgetPlugin } from '@deviltea/widget-core'
import { WidgetInspectionError } from '@deviltea/widget-core/inspection'
import { defineComponent, h } from 'vue'

import {
	extractProductAdapterManifest,
	productAdapterApiCompatibility,
	productAdapterRegistryInspector,
	productAdapterRuntimeMemberDecoder,
} from '../src/adapters/product-integration'
import type { AdapterManifest } from '../src/domain/adapters/schema'
import { IncompatibleWidgetCoreError } from '../src/runtime/widget-core-diagnostics'

const dummyPlugin = createWidgetPlugin('DummyWidget').description('Test DummyWidget Widget.').interfaces<Record<never, never>>().done()
const DummyRenderer = defineComponent({ render: () => h('div') })

function makeManifest(id: string, overrides: Partial<AdapterManifest> = {}): AdapterManifest {
	return {
		id,
		apiVersion: '1',
		widgetPlugins: [dummyPlugin],
		catalog: { widgets: { DummyWidget: {} } },
		renderers: [{ type: 'DummyWidget', component: DummyRenderer }],
		providers: [],
		styles: [],
		tokens: [],
		...overrides,
	}
}

describe('product adapter integration', () => {
	describe('extractProductAdapterManifest', () => {
		it('extracts manifest regardless of export name (default or named)', () => {
			const manifest = makeManifest('test-adapter')
			expect(extractProductAdapterManifest({ default: manifest })).toBe(manifest)
			expect(extractProductAdapterManifest({ myCustomAdapterExport: manifest })).toBe(manifest)
			expect(extractProductAdapterManifest({ manifest })).toBe(manifest)
		})

		it('allows the same manifest object re-exported under multiple names', () => {
			const manifest = makeManifest('re-exported')
			expect(extractProductAdapterManifest({ default: manifest, named: manifest })).toBe(manifest)
		})

		it('fails with explicit diagnostic when zero valid manifests exist in module namespace', () => {
			expect(() => extractProductAdapterManifest({ notAManifest: { foo: 'bar' } })).toThrow(
				/No valid AdapterManifest export found/,
			)
			expect(() => extractProductAdapterManifest({})).toThrow(
				/No valid AdapterManifest export found/,
			)
		})

		it('fails with explicit diagnostic when multiple distinct manifests are exported', () => {
			const first = makeManifest('first')
			const second = makeManifest('second')
			expect(() => extractProductAdapterManifest({ first, second })).toThrow(
				/Ambiguous AdapterManifest exports found/,
			)
		})
	})

	describe('productAdapterRuntimeMemberDecoder', () => {
		it('decodes valid AnyWidgetPlugin', () => {
			const decoded = productAdapterRuntimeMemberDecoder.decodePlugin(dummyPlugin)
			expect(decoded.type).toBe('DummyWidget')
		})

		it('rejects a plugin member from another widget-core copy as an incompatible widget-core copy', () => {
			// A structural look-alike and a Plugin from another module instance share widget-core's
			// documented `foreign-plugin` inspection code.
			let thrown: unknown
			try {
				productAdapterRuntimeMemberDecoder.decodePlugin({ type: 'Broken' })
			}
			catch (cause) {
				thrown = cause
			}
			expect(thrown).toBeInstanceOf(IncompatibleWidgetCoreError)
			expect((thrown as IncompatibleWidgetCoreError).pluginType).toBe('Broken')
			expect((thrown as Error).message).toMatch(/Widget plugin 'Broken' .*incompatible widget-core copy/)
			expect((thrown as Error).cause).toBeInstanceOf(WidgetInspectionError)
			expect(((thrown as Error).cause as WidgetInspectionError).code).toBe('foreign-plugin')
		})

		it('rejects a member without a usable type before inspection', () => {
			expect(() => productAdapterRuntimeMemberDecoder.decodePlugin({ type: '' })).toThrow(
				/non-empty string type/,
			)
		})

		it('decodes valid renderer registration', () => {
			const decoded = productAdapterRuntimeMemberDecoder.decodeRenderer(
				{ type: 'DummyWidget', component: DummyRenderer },
			)
			expect(decoded.type).toBe('DummyWidget')
			expect(decoded.component).toBe(DummyRenderer)
		})

		it('rejects malformed renderer registration', () => {
			expect(() => productAdapterRuntimeMemberDecoder.decodeRenderer({ type: '' })).toThrow()
			expect(() => productAdapterRuntimeMemberDecoder.decodeRenderer({ type: 'Foo', component: 123 })).toThrow(
				/component must be a Vue component/,
			)
		})
	})

	describe('productAdapterRegistryInspector', () => {
		it('inspects manifest ownership of plugins and renderers', async () => {
			const manifest = makeManifest('inspect-test')
			const ownership = await productAdapterRegistryInspector.inspect(manifest)
			expect(ownership.widgetTypes).toEqual(['DummyWidget'])
			expect(ownership.rendererKeys).toEqual(['DummyWidget'])
		})
	})

	describe('productAdapterApiCompatibility', () => {
		it('accepts supported API versions and rejects unsupported ones', () => {
			expect(productAdapterApiCompatibility.isCompatible('1')).toBe(true)
			expect(productAdapterApiCompatibility.isCompatible('1.0.0')).toBe(true)
			expect(productAdapterApiCompatibility.isCompatible('test')).toBe(true)
			expect(productAdapterApiCompatibility.isCompatible('0.1.0')).toBe(false)
			expect(productAdapterApiCompatibility.isCompatible('2.0.0')).toBe(false)
		})
	})
})
