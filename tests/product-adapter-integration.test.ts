import { describe, expect, it } from 'vitest'
import { createWidgetPlugin } from '@deviltea/widget-core'
import { WidgetInspectionError } from '@deviltea/widget-core/inspection'
import { defineComponent, h } from 'vue'

import {
	ADAPTER_API_HOST_MINOR,
	ADAPTER_API_MEMBER_MINORS,
	extractProductAdapterManifest,
	productAdapterApiCompatibility,
	productAdapterRegistryInspector,
	productAdapterRuntimeMemberDecoder,
} from '../src/adapters/product-integration'
import { resolveWorkspaceAdapterSet } from '../src/adapters/resolution'
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
		it('accepts `1` and `1.<minor>` up to the host ceiling', () => {
			for (const version of ['1', '1.0', '1.1', `1.${ADAPTER_API_HOST_MINOR}`])
				expect(productAdapterApiCompatibility.refusal(version), version).toBeUndefined()
		})

		it('keeps the non-normative `test` hook', () => {
			expect(productAdapterApiCompatibility.refusal('test')).toBeUndefined()
			expect(productAdapterApiCompatibility.memberMinorViolations(makeManifest('hook', { apiVersion: 'test', providers: [() => {}], themeSupport: { supports: () => true } }))).toEqual([])
		})

		it('refuses API versions outside the `1` / `1.<minor>` grammar as malformed', () => {
			for (const version of ['1.foo', '1.01', '01', '2', '', '1.', '.1', '1.0.0', '1.1.0', ' 1', '1 ', '1.-1', '1.1e2', '0.1.0', '2.0.0', '2.0'])
				expect(productAdapterApiCompatibility.refusal(version), JSON.stringify(version)).toBe('malformed')
		})

		it('refuses a minor above the host ceiling as a newer minor', () => {
			// Rule 01a11a5a-4aa0-7537-bbfc-600ea0ea61c5.
			for (const version of [`1.${ADAPTER_API_HOST_MINOR + 1}`, '1.12', '1.99999999999999999999'])
				expect(productAdapterApiCompatibility.refusal(version), version).toBe('newer_minor')
		})

		it('has a host ceiling equal to the highest minor that introduces a member', () => {
			// Clause 01a11a5a-41f3-7474-ba83-128fec22a1f7: providers 1.1, themeSupport 1.2, sources 1.3.
			expect(ADAPTER_API_MEMBER_MINORS).toEqual({ providers: 1, themeSupport: 2, sources: 3 })
			expect(ADAPTER_API_HOST_MINOR).toBe(Math.max(...Object.values(ADAPTER_API_MEMBER_MINORS)))
		})

		it('lists each member used under a lower declared minor, and none at or above its minor', () => {
			// Rule 01a11a5a-4ba0-745f-a297-bd8d33babded.
			const used = { providers: [() => {}], themeSupport: { supports: () => true }, sources: {} }
			const violations = (apiVersion: string, overrides: Partial<AdapterManifest> = used) =>
				productAdapterApiCompatibility.memberMinorViolations(makeManifest('bound', { apiVersion, ...overrides })).map(item => item.member)
			expect(violations('1')).toEqual(['providers', 'themeSupport', 'sources'])
			expect(violations('1.0')).toEqual(['providers', 'themeSupport', 'sources'])
			expect(violations('1.1')).toEqual(['themeSupport', 'sources'])
			expect(violations('1.2')).toEqual(['sources'])
			expect(violations('1.3')).toEqual([])
			// An empty `providers` has no entries, so it needs no minor; absent members need none.
			expect(violations('1', { providers: [] })).toEqual([])
		})
	})

	describe('Adapter set resolution with the product API policy', () => {
		async function resolveWithApiVersion(apiVersion: string) {
			return resolveWorkspaceAdapterSet({
				workspaceRoot: '/virtual/workspace',
				adapters: [{ moduleSpecifier: 'fixture-adapter' }],
				resolver: {
					async resolve(_root: string, moduleSpecifier: string) {
						return { moduleSpecifier, resolvedPath: `/virtual/${moduleSpecifier}.mjs`, moduleIdentity: `file:///virtual/${moduleSpecifier}.mjs` }
					},
				},
				loader: { async loadManifest() { return makeManifest('fixture', { apiVersion }) } },
				apiCompatibility: productAdapterApiCompatibility,
				registryInspector: productAdapterRegistryInspector,
			})
		}

		it('refuses an Adapter whose apiVersion `1.foo` is malformed', async () => {
			const result = await resolveWithApiVersion('1.foo')
			expect(result.state).toBe('invalid')
			expect(result.diagnostics).toEqual([expect.objectContaining({
				code: 'adapter.api_version_incompatible',
				path: '/adapters/0/manifest/apiVersion',
			})])
		})

		it('accepts an Adapter whose apiVersion is the host ceiling', async () => {
			const result = await resolveWithApiVersion(`1.${ADAPTER_API_HOST_MINOR}`)
			expect(result.diagnostics).toEqual([])
			expect(result.state).not.toBe('invalid')
		})

		it('refuses an Adapter that needs a newer API minor than UIUX implements, with upgrade guidance', async () => {
			// Scenario 01a11a5b-19e5-7a18-9809-5a036bd0047f; Rules 01a11a5a-4aa0-7537-bbfc-600ea0ea61c5 and 01a11a5a-4b1f-7ebf-bd9f-e9156ae438d0.
			const result = await resolveWithApiVersion(`1.${ADAPTER_API_HOST_MINOR + 1}`)
			expect(result.state).toBe('invalid')
			expect(result.diagnostics).toEqual([expect.objectContaining({
				code: 'adapter.api_minor_unsupported',
				path: '/adapters/0/manifest/apiVersion',
				message: expect.stringContaining('upgrade UIUX'),
			})])
		})

		async function resolveManifest(overrides: Partial<AdapterManifest>) {
			return resolveWorkspaceAdapterSet({
				workspaceRoot: '/virtual/workspace',
				adapters: [{ moduleSpecifier: 'fixture-adapter' }],
				resolver: {
					async resolve(_root: string, moduleSpecifier: string) {
						return { moduleSpecifier, resolvedPath: `/virtual/${moduleSpecifier}.mjs`, moduleIdentity: `file:///virtual/${moduleSpecifier}.mjs` }
					},
				},
				loader: { async loadManifest() { return makeManifest('fixture', overrides) } },
				apiCompatibility: productAdapterApiCompatibility,
				registryInspector: productAdapterRegistryInspector,
			})
		}

		it('refuses an Adapter that declares apiVersion `1` and a themeSupport member', async () => {
			// Scenario 01a11a5b-1a71-7912-a88e-16a0c5fb7824; Clause 01a11a5a-41f3-7474-ba83-128fec22a1f7, Rule 01a11a5a-4ba0-745f-a297-bd8d33babded.
			const result = await resolveManifest({ apiVersion: '1', themeSupport: { supports: () => true } })
			expect(result.state).toBe('invalid')
			expect(result.diagnostics).toEqual([expect.objectContaining({
				code: 'adapter.api_member_minor_unmet',
				path: '/adapters/0/manifest/themeSupport',
				message: expect.stringContaining('1.2'),
			})])
		})

		it('refuses providers entries under `1.0` and `sources` under `1.2`, and accepts them at their minors', async () => {
			expect((await resolveManifest({ apiVersion: '1.0', providers: [() => {}] })).diagnostics).toEqual([expect.objectContaining({ code: 'adapter.api_member_minor_unmet', path: '/adapters/0/manifest/providers' })])
			expect((await resolveManifest({ apiVersion: '1.2', sources: {} })).diagnostics).toEqual([expect.objectContaining({ code: 'adapter.api_member_minor_unmet', path: '/adapters/0/manifest/sources' })])
			expect((await resolveManifest({ apiVersion: '1.1', providers: [() => {}] })).diagnostics).toEqual([])
			expect((await resolveManifest({ apiVersion: '1.2', themeSupport: { supports: () => true } })).diagnostics).toEqual([])
			expect((await resolveManifest({ apiVersion: '1.3', sources: {} })).diagnostics).toEqual([])
		})
	})
})
