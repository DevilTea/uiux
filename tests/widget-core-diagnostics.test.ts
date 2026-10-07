import { describe, expect, it } from 'vitest'
import { createWidgetPlugin, type AnyWidgetPlugin } from '@deviltea/widget-core'
import { defineComponent, h } from 'vue'

import type { AdapterManifest } from '../src/domain/adapters/schema'
import { createStandalonePreviewMount, type PreviewRuntimeStatus, type StandaloneAdapterDescriptor } from '../src/preview/browser-runtime'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { createAdapterWidgetSystem } from '../src/runtime/widget-core-diagnostics'

/**
 * widget-core 0.0.4's coded registration errors (`WidgetSystemConfigurationError`) become
 * `adapter.*` diagnostics instead of exceptions. A structural look-alike stands in for a Plugin
 * from another widget-core copy: widget-core documents both as the same `foreign-plugin` case.
 */

const alpha = createWidgetPlugin('Alpha').done()
const alphaAgain = createWidgetPlugin('Alpha').done()
const beta = createWidgetPlugin('Beta').done()
const foreignGamma = { type: 'Gamma' } as unknown as AnyWidgetPlugin
const Renderer = defineComponent({ render: () => h('div') })

describe('createAdapterWidgetSystem', () => {
	it('creates the system when widget-core accepts every Plugin', () => {
		const result = createAdapterWidgetSystem([alpha, beta], ['/a', '/b'])
		expect(result.state).toBe('ready')
	})

	it('reports a Plugin from another widget-core copy at its member path', () => {
		const result = createAdapterWidgetSystem([alpha, foreignGamma], ['/a', '/adapters/1/manifest/widgetPlugins/0'])
		expect(result).toEqual({
			state: 'invalid',
			diagnostics: [{
				code: 'adapter.runtime_widget_core_incompatible',
				path: '/adapters/1/manifest/widgetPlugins/0',
				message: expect.stringMatching(/Widget plugin 'Gamma' .*incompatible widget-core copy/),
			}],
		})
	})

	it('reports a duplicate Widget type at the second registration and names the first', () => {
		const result = createAdapterWidgetSystem([alpha, beta, alphaAgain], ['/adapters/0/manifest/widgetPlugins/0', '/b', '/adapters/1/manifest/widgetPlugins/0'])
		expect(result).toEqual({
			state: 'invalid',
			diagnostics: [{
				code: 'adapter.runtime_plugin_collision',
				path: '/adapters/1/manifest/widgetPlugins/0',
				message: 'Widget type Alpha is registered more than once; it was first registered at /adapters/0/manifest/widgetPlugins/0.',
			}],
		})
	})
})

describe('standalone Preview mount and widget-core registration errors', () => {
	const view: ViewResource = {
		kind: 'view',
		id: '12345678-1234-4234-8234-123456789abc',
		name: 'Registration errors',
		ir: { id: 'root', type: 'RootShell' },
	} as unknown as ViewResource
	const context = { locale: 'en-US', theme: 'default', viewport: 'desktop' } as unknown as ResolvedRenderContext

	function descriptor(index: number, id: string, plugin: unknown, type: string): StandaloneAdapterDescriptor {
		const manifest: AdapterManifest = {
			id,
			apiVersion: '1',
			widgetPlugins: [plugin],
			catalog: { widgets: {} },
			renderers: [{ type, component: Renderer }],
			providers: [],
			styles: [],
			tokens: [],
		}
		return { index, id, apiVersion: '1', widgetTypes: [type], rendererKeys: [type], namespace: { default: manifest } }
	}

	function mountStatuses(descriptors: readonly StandaloneAdapterDescriptor[]): PreviewRuntimeStatus[] {
		const statuses: PreviewRuntimeStatus[] = []
		createStandalonePreviewMount({ adapterDescriptors: descriptors })
			.mountPreviewRuntime({} as HTMLElement, { view, context, onStatusChange: status => statuses.push(status) })
		return statuses
	}

	it('reports a Widget plugin member from another widget-core copy instead of a decode failure', () => {
		const statuses = mountStatuses([descriptor(0, 'foreign-adapter', foreignGamma, 'Gamma')])
		expect(statuses).toHaveLength(1)
		const status = statuses[0]!
		expect(status.status).toBe('invalid')
		const diagnostics = status.status === 'invalid' ? status.diagnostics : []
		expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'adapter.runtime_widget_core_incompatible', path: '/adapters/0/manifest/widgetPlugins/0' }))
		expect(diagnostics.some(item => item.code === 'adapter.runtime_plugin_decode_failed')).toBe(false)
	})

	it('still reports a member that is not a Widget plugin object as a decode failure', () => {
		const statuses = mountStatuses([descriptor(0, 'broken-adapter', 'not-a-plugin', 'Gamma')])
		const status = statuses[0]!
		const diagnostics = status.status === 'invalid' ? status.diagnostics : []
		expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'adapter.runtime_plugin_decode_failed', path: '/adapters/0/manifest/widgetPlugins/0' }))
		expect(diagnostics.some(item => item.code === 'adapter.runtime_widget_core_incompatible')).toBe(false)
	})

	it('reports two Adapters registering one Widget type instead of throwing from createWidgetSystem', () => {
		// The server's resolved-set validation is the primary check; this is the backstop.
		const statuses = mountStatuses([descriptor(0, 'first-adapter', alpha, 'Alpha'), descriptor(1, 'second-adapter', alphaAgain, 'Alpha')])
		expect(statuses).toEqual([{
			status: 'invalid',
			diagnostics: [{
				code: 'adapter.runtime_plugin_collision',
				path: '/adapters/1/manifest/widgetPlugins/0',
				message: 'Widget type Alpha is registered more than once; it was first registered at /adapters/0/manifest/widgetPlugins/0.',
			}],
		}])
	})
})
