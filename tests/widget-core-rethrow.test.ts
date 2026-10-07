import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWidgetPlugin, createWidgetSystem, WidgetSystemConfigurationError, type WidgetSystemRuntime } from '@deviltea/widget-core'
import { WidgetInspectionError } from '@deviltea/widget-core/inspection'
import { defineComponent, h } from 'vue'

import type { AdapterManifest } from '../src/domain/adapters/schema'
import { createStandalonePreviewMount, type StandaloneAdapterDescriptor } from '../src/preview/browser-runtime'
import { WidgetEventObserver } from '../src/preview/widget-event-observer'
import { createAdapterWidgetSystem } from '../src/runtime/widget-core-diagnostics'

/**
 * UIUX maps only widget-core's documented coded errors (`WidgetSystemConfigurationError` with a
 * known code, `WidgetInspectionError`) to diagnostics or "nothing to report". Any other exception is
 * a defect and must propagate. widget-core 0.0.4 never throws those, so the entries are wrapped
 * here: each delegates to the real implementation unless a test installs a replacement.
 */

const overrides = vi.hoisted(() => ({
	createWidgetSystem: undefined as undefined | (() => never),
	inspectPlugin: undefined as undefined | (() => never),
	inspectRuntime: undefined as undefined | (() => never),
}))

vi.mock('@deviltea/widget-core', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@deviltea/widget-core')>()
	return {
		...actual,
		createWidgetSystem: ((options: Parameters<typeof actual.createWidgetSystem>[0]) =>
			overrides.createWidgetSystem ? overrides.createWidgetSystem() : actual.createWidgetSystem(options)) as typeof actual.createWidgetSystem,
	}
})

vi.mock('@deviltea/widget-core/inspection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@deviltea/widget-core/inspection')>()
	return {
		...actual,
		inspectPlugin: ((plugin: Parameters<typeof actual.inspectPlugin>[0]) =>
			overrides.inspectPlugin ? overrides.inspectPlugin() : actual.inspectPlugin(plugin)) as typeof actual.inspectPlugin,
		inspectRuntime: ((runtime: Parameters<typeof actual.inspectRuntime>[0]) =>
			overrides.inspectRuntime ? overrides.inspectRuntime() : actual.inspectRuntime(runtime)) as typeof actual.inspectRuntime,
	}
})

afterEach(() => {
	overrides.createWidgetSystem = undefined
	overrides.inspectPlugin = undefined
	overrides.inspectRuntime = undefined
})

const alpha = createWidgetPlugin('Alpha').done()

describe('createAdapterWidgetSystem rethrows what it does not map', () => {
	it('propagates an exception that is not a WidgetSystemConfigurationError', () => {
		const defect = new TypeError('widget-core defect')
		overrides.createWidgetSystem = () => { throw defect }
		expect(() => createAdapterWidgetSystem([alpha], ['/a'])).toThrow(defect)
	})

	it('propagates a WidgetSystemConfigurationError with a code it does not map', () => {
		const unmapped = new WidgetSystemConfigurationError('future-code' as unknown as WidgetSystemConfigurationError['code'], 0, 'Alpha')
		overrides.createWidgetSystem = () => { throw unmapped }
		expect(() => createAdapterWidgetSystem([alpha], ['/a'])).toThrow(unmapped)
	})
})

describe('WidgetEventObserver rethrows inspectRuntime defects', () => {
	function realRuntime(): WidgetSystemRuntime {
		const blueprint = createWidgetSystem({ plugins: [alpha] }).createBlueprint({ id: 'a', type: 'Alpha' })
		if (blueprint.status !== 'valid') throw new Error('fixture blueprint invalid')
		return blueprint.createRuntime()
	}

	it('observes nothing when inspectRuntime throws WidgetInspectionError', () => {
		overrides.inspectRuntime = () => { throw new WidgetInspectionError('foreign-runtime') }
		const runtime = realRuntime()
		const observer = new WidgetEventObserver(() => {})
		observer.attach(runtime)
		expect(() => observer.setArm('arm-1', [{ widgetId: 'a', event: 'pressed' }])).not.toThrow()
		expect(observer.snapshot()).toMatchObject({ armId: 'arm-1', observing: 0 })
		observer.dispose()
		runtime.dispose()
	})

	it('propagates any other exception from inspectRuntime', () => {
		const defect = new TypeError('inspection defect')
		overrides.inspectRuntime = () => { throw defect }
		const runtime = realRuntime()
		const observer = new WidgetEventObserver(() => {})
		observer.attach(runtime)
		expect(() => observer.setArm('arm-1', [{ widgetId: 'a', event: 'pressed' }])).toThrow(defect)
		observer.dispose()
		runtime.dispose()
	})
})

describe('describeDeclaredWidgetEvents rethrows inspectPlugin defects', () => {
	const Renderer = defineComponent({ render: () => h('div') })

	function mountFactory() {
		const manifest: AdapterManifest = {
			id: 'alpha-adapter',
			apiVersion: '1',
			widgetPlugins: [alpha],
			catalog: { widgets: {} },
			renderers: [{ type: 'Alpha', component: Renderer }],
			providers: [],
			styles: [],
			tokens: [],
		}
		const descriptor: StandaloneAdapterDescriptor = { index: 0, id: 'alpha-adapter', apiVersion: '1', widgetTypes: ['Alpha'], rendererKeys: ['Alpha'], namespace: { default: manifest } }
		// Decoding runs the real inspectPlugin; the override applies only to the later Event read.
		return createStandalonePreviewMount({ adapterDescriptors: [descriptor] })
	}

	it('reads declared Events through the real inspectPlugin', () => {
		expect(mountFactory().describeDeclaredWidgetEvents()).toEqual({ Alpha: [] })
	})

	it('omits a plugin that inspectPlugin rejects with WidgetInspectionError', () => {
		const factory = mountFactory()
		overrides.inspectPlugin = () => { throw new WidgetInspectionError('foreign-plugin') }
		expect(factory.describeDeclaredWidgetEvents()).toEqual({})
	})

	it('propagates any other exception from inspectPlugin', () => {
		const factory = mountFactory()
		const defect = new TypeError('inspection defect')
		overrides.inspectPlugin = () => { throw defect }
		expect(() => factory.describeDeclaredWidgetEvents()).toThrow(defect)
	})
})
