import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { createWidgetPlugin, createWidgetSystem, type RuntimeEvent, type RuntimeMethod, type WidgetSystemRuntime } from '@deviltea/widget-core'

import { resolveSelectedWorkspaceAdapters } from '../src/server/workspace-adapters'
import { buildWorkspacePreviewBundle, clearPreviewBundleCache } from '../src/server/preview-bundler'
import { readSelectedWorkspaceDeclaredWidgetEvents } from '../src/server/declared-widget-events'
import { WidgetEventObserver, type WidgetEventReport } from '../src/preview/widget-event-observer'
import { RuntimePreviewProtocolBridge, type PreviewWireMessage } from '../src/preview/protocol/bridge'
import type { PreviewRuntimeBridge, PreviewRuntimeMountOptions } from '../src/preview/browser-runtime'
import type { ViewResource } from '../src/domain/views/schema'

/**
 * The runtime observer of Widget Event reporting (Part 2 decision group, decision 4): the
 * read-only inspection surface, armed pairs only, one report per arm, quiet until mounted,
 * re-attachment on Runtime swaps, and a privacy sentinel proving no Event argument ever leaves.
 */

const SECRET = 'SENTINEL-7f00-do-not-leak'

// -------------------------------------------------------------------------------------------------
// The observer against a real widget-core Runtime (Method `execute` contexts emit, with arguments)
// -------------------------------------------------------------------------------------------------

interface ProbeInterfaces {
	methods: { press: (value: string) => null; poke: () => null }
	events: { pressed: readonly [string]; poked: readonly [] }
}

const probePlugin = createWidgetPlugin('Probe')
	.description('Widget Event fixture')
	.interfaces<ProbeInterfaces>()
	.methods(methods => methods
		.press({ validateArgs: (args): args is [string] => typeof args[0] === 'string', execute: ({ args, emit }) => { emit.pressed(args[0]); return null } })
		.poke({ validateArgs: (args): args is [] => args.length === 0, execute: ({ emit }) => { emit.poked(); return null } }))
	.events(events => events.pressed({ description: 'Pressed with a value' }).poked({ description: 'Poked' }))
	.done()

type ProbeWidget = {
	methods: { press: RuntimeMethod<(value: string) => null>; poke: RuntimeMethod<() => null> }
	events: { pressed: RuntimeEvent<readonly [string]>; poked: RuntimeEvent<readonly []> }
}

function probeRuntime(): { runtime: WidgetSystemRuntime; a: ProbeWidget } {
	const system = createWidgetSystem({ plugins: [probePlugin] })
	const blueprint = system.createBlueprint({ id: 'a', type: 'Probe' })
	if (blueprint.status !== 'valid') throw new Error('fixture blueprint invalid')
	const runtime = blueprint.createRuntime()
	const a = runtime.getWidget('a') as unknown as ProbeWidget
	return { runtime, a }
}

async function flush(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

describe('WidgetEventObserver (inspection surface)', () => {
	it('reports only armed pairs, once per arm, and never before attach', async () => {
		const { runtime, a } = probeRuntime()
		const reports: WidgetEventReport[] = []
		const observer = new WidgetEventObserver(report => reports.push(report))
		observer.setArm('arm-1', [{ widgetId: 'a', event: 'pressed' }])
		a.methods.press('before-mount')
		await flush()
		expect(reports).toEqual([])
		observer.attach(runtime)
		a.methods.poke()
		await flush()
		expect(reports).toEqual([])
		a.methods.press(SECRET)
		a.methods.press(SECRET)
		await flush()
		expect(reports).toEqual([{ armId: 'arm-1', widgetId: 'a', event: 'pressed' }])
		expect(observer.snapshot()).toMatchObject({ armId: 'arm-1', spent: true, observing: 0 })
		// Nothing more until a new arm; the new arm reports once more.
		a.methods.press(SECRET)
		await flush()
		expect(reports).toHaveLength(1)
		observer.setArm('arm-2', [{ widgetId: 'a', event: 'poked' }, { widgetId: 'a', event: 'pressed' }])
		a.methods.poke()
		a.methods.press(SECRET)
		await flush()
		expect(reports).toEqual([{ armId: 'arm-1', widgetId: 'a', event: 'pressed' }, { armId: 'arm-2', widgetId: 'a', event: 'poked' }])
		observer.dispose()
		runtime.dispose()
	})

	it('silently skips unknown pairs (missing Widget, undeclared Event)', async () => {
		const { runtime, a } = probeRuntime()
		const reports: WidgetEventReport[] = []
		const observer = new WidgetEventObserver(report => reports.push(report))
		observer.attach(runtime)
		observer.setArm('arm-1', [{ widgetId: 'ghost', event: 'pressed' }, { widgetId: 'a', event: 'click' }])
		expect(observer.snapshot().observing).toBe(0)
		a.methods.press(SECRET)
		await flush()
		expect(reports).toEqual([])
		observer.dispose()
		runtime.dispose()
	})

	it('an empty arm disarms; clearArm and dispose stop reporting', async () => {
		const { runtime, a } = probeRuntime()
		const reports: WidgetEventReport[] = []
		const observer = new WidgetEventObserver(report => reports.push(report))
		observer.attach(runtime)
		observer.setArm('arm-1', [{ widgetId: 'a', event: 'pressed' }])
		observer.setArm('arm-2', [])
		a.methods.press(SECRET)
		observer.setArm('arm-3', [{ widgetId: 'a', event: 'pressed' }])
		observer.clearArm()
		a.methods.press(SECRET)
		observer.setArm('arm-4', [{ widgetId: 'a', event: 'pressed' }])
		a.methods.press(SECRET)
		observer.dispose()
		await flush()
		// The emission happened before dispose, but nothing is reported after dispose.
		expect(reports).toEqual([])
		expect(observer.snapshot().observing).toBe(0)
		runtime.dispose()
	})

	it('keeps the arm and its spent state across Runtime instance swaps', async () => {
		const first = probeRuntime()
		const second = probeRuntime()
		const reports: WidgetEventReport[] = []
		const observer = new WidgetEventObserver(report => reports.push(report))
		observer.setArm('arm-1', [{ widgetId: 'a', event: 'pressed' }])
		observer.attach(first.runtime)
		observer.detach()
		first.a.methods.press(SECRET)
		observer.attach(second.runtime)
		second.a.methods.press(SECRET)
		await flush()
		expect(reports).toEqual([{ armId: 'arm-1', widgetId: 'a', event: 'pressed' }])
		// Spent stays spent on the next instance.
		observer.detach()
		observer.attach(first.runtime)
		first.a.methods.press(SECRET)
		await flush()
		expect(reports).toHaveLength(1)
		observer.dispose()
		first.runtime.dispose()
		second.runtime.dispose()
	})

	it('is passive: a throwing reporter changes neither emit nor the plugin\'s own listeners, which run after it', async () => {
		const { runtime, a } = probeRuntime()
		const order: string[] = []
		const observer = new WidgetEventObserver(() => {
			order.push('reporter')
			throw new Error('reporter failure')
		})
		observer.setArm('arm-1', [{ widgetId: 'a', event: 'pressed' }])
		observer.attach(runtime)
		const own: unknown[][] = []
		a.events.pressed.subscribe((...args) => {
			order.push('own')
			own.push(args)
		})
		const result = a.methods.press(SECRET)
		expect(result).toMatchObject({ ok: true })
		expect(own).toEqual([[SECRET]])
		// The report is scheduled outside the emitter, after the plugin's own listener ran.
		expect(order).toEqual(['own'])
		await flush()
		expect(order).toEqual(['own', 'reporter'])
		observer.dispose()
		runtime.dispose()
	})

	it('privacy sentinel: the listener never reads the argument tuple, so no report carries it', async () => {
		const { runtime, a } = probeRuntime()
		const reports: WidgetEventReport[] = []
		const observer = new WidgetEventObserver(report => reports.push(report))
		observer.attach(runtime)
		for (let index = 0; index < 3; index++) {
			observer.setArm(`arm-${index}`, [{ widgetId: 'a', event: 'pressed' }])
			a.methods.press(`${SECRET}-${index}`)
			await flush()
		}
		expect(reports).toHaveLength(3)
		for (const report of reports) expect(Object.keys(report).sort()).toEqual(['armId', 'event', 'widgetId'])
		expect(JSON.stringify(reports)).not.toContain(SECRET)
		observer.dispose()
		runtime.dispose()
	})
})

// -------------------------------------------------------------------------------------------------
// The mounted Preview runtime (bundle, Vue renderer): click, mount and timer emissions with args
// -------------------------------------------------------------------------------------------------

const temporaryRoots: string[] = []
afterEach(async () => {
	clearPreviewBundleCache()
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function tapAdapterSource(): string {
	return `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h, onMounted, onBeforeUnmount } from 'vue';
import { useWidget } from '@deviltea/widget-vue';

export const tapPlugin = createWidgetPlugin('Tap')
  .interfaces()
  .events(events => events
    .tap({ description: 'Tapped' })
    .mounted({ description: 'Emitted from onMounted' })
    .tick({ description: 'Emitted from a timer' })
    .hover({ description: 'Never armed' }))
  .done();

export const TapRenderer = defineComponent({
  name: 'TapRenderer',
  setup() {
    const { widgetId, emit } = useWidget(tapPlugin);
    let timer;
    onMounted(() => {
      emit.mounted('${SECRET}-mount');
      timer = setTimeout(() => emit.tick('${SECRET}-timer', { nested: '${SECRET}' }), 30);
    });
    onBeforeUnmount(() => clearTimeout(timer));
    return () => h('button', {
      'data-widget-id': widgetId,
      onClick: (event) => emit.tap('${SECRET}-click', event.clientX, { text: '${SECRET}' }),
      onPointerenter: () => emit.hover('${SECRET}-hover'),
    }, 'Tap');
  },
});

export const manifest = {
  id: 'tap-adapter',
  apiVersion: '1',
  widgetPlugins: [tapPlugin],
  catalog: { widgets: { Tap: {} } },
  renderers: [{ type: 'Tap', component: TapRenderer }],
  providers: [],
  styles: [],
  tokens: [],
};
`
}

const VIEW_ID = '33333333-3333-4333-8333-333333333333'

function tapView(): ViewResource {
	return {
		id: VIEW_ID,
		name: 'Tap View',
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ id: 'tap-1', type: 'Tap' }, { id: 'tap-2', type: 'Tap' }] } } as never,
		variants: { compact: { state: {} } },
		spec: { intent: 'Widget Event fixture', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	} as ViewResource
}

async function tapWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-widget-events-test-'))
	temporaryRoots.push(root)
	await mkdir(join(root, '.uiux'), { recursive: true })
	await mkdir(join(root, 'adapters'), { recursive: true })
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })
	for (const name of ['@deviltea/widget-core', '@deviltea/widget-vue', 'vue'])
		await symlink(join(process.cwd(), 'node_modules', name), join(root, 'node_modules', name)).catch(() => undefined)
	await writeFile(join(root, '.uiux', 'workspace.json'), JSON.stringify({ schemaVersion: 2, i18n: { defaultLocale: 'en-US' }, adapters: [{ moduleSpecifier: './adapters/tap.mjs' }], viewports: {}, themes: {} }))
	await writeFile(join(root, 'adapters', 'tap.mjs'), tapAdapterSource())
	return root
}

type BundleModule = Readonly<{
	mountPreviewRuntime: (container: HTMLElement, options: PreviewRuntimeMountOptions) => PreviewRuntimeBridge
	describeDeclaredWidgetEvents: () => unknown
}>

async function loadBundle(root: string): Promise<BundleModule> {
	const resolution = await resolveSelectedWorkspaceAdapters(root)
	if (resolution.state !== 'valid') throw new Error(JSON.stringify(resolution.diagnostics))
	const bundle = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
	const win = new Window()
	globalThis.window = win as unknown as Window & typeof globalThis
	globalThis.document = win.document as unknown as Document
	globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement
	globalThis.Element = win.Element as unknown as typeof Element
	globalThis.Node = win.Node as unknown as typeof Node
	globalThis.SVGElement = win.SVGElement as unknown as typeof SVGElement
	const file = join(root, `bundle-${Date.now()}.mjs`)
	await writeFile(file, bundle.bundleJs)
	return await import(file) as BundleModule
}

function context(variantName?: string) {
	return { viewId: VIEW_ID, ...(variantName ? { variantName } : {}), locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function click(container: HTMLElement, widgetId: string): void {
	const element = container.querySelector(`[data-widget-id="${widgetId}"]`) as HTMLElement | null
	if (!element) throw new Error(`no element for ${widgetId}`)
	element.click()
}

describe('mounted Preview runtime: Widget Event observation', () => {
	it('ignores mount-time emissions, counts clicks and timers, and reports once per arm through the closed wire', async () => {
		const bundle = await loadBundle(await tapWorkspace())
		// The Preview host's path: report → closed occurrence → runtime bridge, captured on the wire.
		const outbound: PreviewWireMessage[] = []
		const runtimeBridge = new RuntimePreviewProtocolBridge('session-a', 'generation-a', { protocolVersion: 1, features: ['geometry', 'widget.events'] }, { send: message => outbound.push(message) })
		runtimeBridge.declareCapabilities()
		runtimeBridge.receive({ type: 'capability.ack', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' }, payload: {} })
		const reports: Array<Readonly<{ armId: string; widgetId: string; event: string }>> = []
		const container = document.createElement('div')
		document.body.appendChild(container)
		const bridge = bundle.mountPreviewRuntime(container, {
			view: tapView(),
			context: context(),
			onWidgetEvent(report) {
				reports.push(report)
				runtimeBridge.sendWidgetEventOccurrence({
					type: 'widget.event.occurrence',
					context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID, widgetId: report.widgetId },
					payload: { armId: report.armId, event: report.event },
				})
			},
		})
		// The arm arrives before mount completes in practice; here it arrives after mount.
		bridge.armWidgetEvents?.('arm-1', [{ widgetId: 'tap-1', event: 'mounted' }, { widgetId: 'tap-1', event: 'tap' }])
		await wait(5)
		expect(reports).toEqual([])

		click(container, 'tap-2')
		await wait(0)
		expect(reports).toEqual([])
		click(container, 'tap-1')
		click(container, 'tap-1')
		await wait(0)
		expect(reports).toEqual([{ armId: 'arm-1', widgetId: 'tap-1', event: 'tap' }])

		// A timer emission after mount counts.
		bridge.armWidgetEvents?.('arm-2', [{ widgetId: 'tap-2', event: 'tick' }])
		await wait(60)
		expect(reports.at(-1)).toEqual({ armId: 'arm-2', widgetId: 'tap-2', event: 'tick' })

		// Privacy sentinel: nothing that left the runtime carries an argument.
		expect(outbound.filter(message => message.type === 'widget.event.occurrence')).toHaveLength(2)
		expect(JSON.stringify(outbound)).not.toContain(SECRET)
		for (const message of outbound.filter(item => item.type === 'widget.event.occurrence'))
			expect(Object.keys(message.payload).sort()).toEqual(['armId', 'event'])
		bridge.dispose()
	})

	it('re-attaches after updateView and updateLocales, clears on a Variant switch, and stops on dispose', async () => {
		const bundle = await loadBundle(await tapWorkspace())
		const reports: Array<Readonly<{ armId: string; widgetId: string; event: string }>> = []
		const container = document.createElement('div')
		document.body.appendChild(container)
		const bridge = bundle.mountPreviewRuntime(container, { view: tapView(), context: context(), onWidgetEvent: report => reports.push(report) })
		bridge.armWidgetEvents?.('arm-1', [{ widgetId: 'tap-1', event: 'tap' }, { widgetId: 'tap-1', event: 'mounted' }])

		// updateView swaps the Runtime: the new instance's mount-time emission is not reported,
		// the arm carries over, and a click on the new instance is.
		bridge.updateView(tapView())
		await wait(5)
		expect(reports).toEqual([])
		click(container, 'tap-1')
		await wait(0)
		expect(reports).toEqual([{ armId: 'arm-1', widgetId: 'tap-1', event: 'tap' }])

		// updateLocales swaps it again; a fresh arm observes the new instance.
		bridge.updateLocales?.(new Map())
		bridge.armWidgetEvents?.('arm-2', [{ widgetId: 'tap-1', event: 'tap' }])
		await wait(5)
		click(container, 'tap-1')
		await wait(0)
		expect(reports.at(-1)).toEqual({ armId: 'arm-2', widgetId: 'tap-1', event: 'tap' })

		// A Variant change clears the arm; an arm for the new context works on the new instance.
		bridge.armWidgetEvents?.('arm-3', [{ widgetId: 'tap-1', event: 'tap' }])
		bridge.updateContext(context('compact'))
		await wait(5)
		click(container, 'tap-1')
		await wait(0)
		expect(reports).toHaveLength(2)
		bridge.armWidgetEvents?.('arm-4', [{ widgetId: 'tap-1', event: 'tap' }])
		click(container, 'tap-1')
		await wait(0)
		expect(reports.at(-1)).toEqual({ armId: 'arm-4', widgetId: 'tap-1', event: 'tap' })

		bridge.armWidgetEvents?.('arm-5', [{ widgetId: 'tap-1', event: 'tick' }])
		bridge.dispose()
		await wait(60)
		expect(reports.map(report => report.armId)).toEqual(['arm-1', 'arm-2', 'arm-4'])
		expect(JSON.stringify(reports)).not.toContain(SECRET)
	})

	it('describes each Widget type\'s declared Events from the bundle, and the server reads them', async () => {
		const root = await tapWorkspace()
		const bundle = await loadBundle(root)
		expect(bundle.describeDeclaredWidgetEvents()).toEqual({
			Tap: [
				{ name: 'tap', description: 'Tapped' },
				{ name: 'mounted', description: 'Emitted from onMounted' },
				{ name: 'tick', description: 'Emitted from a timer' },
				{ name: 'hover', description: 'Never armed' },
			],
		})
		const read = await readSelectedWorkspaceDeclaredWidgetEvents(root)
		expect(read).toEqual({ state: 'valid', widgets: bundle.describeDeclaredWidgetEvents() })
	})
})
