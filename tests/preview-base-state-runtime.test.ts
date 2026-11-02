import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { createWidgetPlugin, createWidgetSystem, type WidgetSystemRuntime } from '@deviltea/widget-core'
import { inspectRuntime } from '@deviltea/widget-core/inspection'

import type { PreviewRuntimeBridge, PreviewRuntimeMountOptions } from '../src/preview/browser-runtime'
import { answerBaseStateRequest, readBaseState, type BaseStateMounted } from '../src/preview/base-state'
import {
	BASE_STATE_FEATURE,
	MAX_BASE_STATE_RESPONSE_LENGTH,
	validateBaseStateMessage,
	type BaseStateRequestMessage,
} from '../src/preview/protocol/base-state'
import { RuntimePreviewProtocolBridge, WorkbenchPreviewProtocolBridge, type PreviewWireMessage } from '../src/preview/protocol/bridge'
import { FAILURE_REPORTS_FEATURE } from '../src/preview/protocol/failure-report'
import { buildViewRuntime } from '../src/runtime'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { buildWorkspacePreviewBundle, clearPreviewBundleCache } from '../src/server/preview-bundler'
import { resolveSelectedWorkspaceAdapters } from '../src/server/workspace-adapters'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * The runtime side of `inspection.base-state` (issue #52; Rules 01a19a9d-9d1b-7db9-a535-96dedc258395
 * and 01a19ab9-d787-7025-a293-7788659bb0b0; Clauses 01a19a9b-386b-7598-a0b9-6865cb9fd6e0 and
 * 01a19ab9-cc7c-749c-98fc-ebf18dd27743): what a base Runtime is built from and read as, which
 * requests are answered and which dropped, what is Unavailable, that the base Runtime is isolated
 * from the live one and always disposed, and that the echoed render context is the applied one.
 */

const VIEW_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_VIEW_ID = '55555555-5555-4555-8555-555555555555'

// -------------------------------------------------------------------------------------------------
// The read, against real widget-core Runtimes and a substituted builder
// -------------------------------------------------------------------------------------------------

class Opaque { readonly x = 1 }
const cyclic: Record<string, unknown> = {}
cyclic.self = cyclic
let pokes = 0

interface StatefulInterfaces {
	state: { count: number; label: string; nothing: null; data: unknown; fn: unknown; nan: unknown; undef: unknown; opaque: unknown; cyclic: unknown; big: unknown; big2: unknown }
	methods: { poke: () => null }
	events: { poked: readonly [] }
}

const anything = (input: unknown): input is unknown => input !== Symbol.for('never')
const statefulPlugin = createWidgetPlugin('Stateful')
	.description('Base-state fixture')
	.interfaces<StatefulInterfaces>()
	.state(state => state
		.count({ authorWritable: true, validate: (v): v is number => typeof v === 'number', default: () => 0 })
		.label({ validate: (v): v is string => typeof v === 'string', default: () => 'base' })
		.nothing({ validate: (v): v is null => v === null, default: () => null })
		.data({ validate: anything, default: () => ({ list: [1, 'two', null], flag: true, ['__proto__']: 1 }) })
		.fn({ validate: anything, default: () => () => 1 })
		.nan({ validate: anything, default: () => Number.NaN })
		.undef({ validate: anything, default: () => undefined })
		.opaque({ validate: anything, default: () => new Opaque() })
		.cyclic({ validate: anything, default: () => cyclic })
		.big({ validate: anything, default: () => 'a'.repeat(600_000) })
		.big2({ validate: anything, default: () => 'b'.repeat(600_000) }))
	.methods(methods => methods.poke({ validateArgs: (args): args is [] => args.length === 0, execute: ({ emit }) => { pokes++; emit.poked(); return null } }))
	.events(events => events.poked({ description: 'Poked' }))
	.done()

function statefulRuntime(): WidgetSystemRuntime {
	const system = createWidgetSystem({ plugins: [statefulPlugin] })
	const blueprint = system.createBlueprint({ id: 'a', type: 'Stateful' })
	if (blueprint.status !== 'valid') throw new Error('fixture blueprint invalid')
	return blueprint.createRuntime()
}

type Build = typeof buildViewRuntime

/** A builder that records what it was asked to build and the Runtimes it handed out. */
function recordingBuilder() {
	const calls: ResolvedRenderContext[] = []
	const runtimes: WidgetSystemRuntime[] = []
	const events: unknown[] = []
	const build: Build = (input) => {
		calls.push(input.context)
		const runtime = statefulRuntime()
		runtimes.push(runtime)
		// Observe every Widget Event of the base Runtime from the moment it exists.
		inspectRuntime(runtime).getWidget(inspectRuntime(runtime).blueprint.nodes.find(node => node.resolved && node.node.id === 'a')!.nodeId)?.getEvent('poked')?.subscribe(args => events.push(args))
		return { state: 'ready', runtime, context: input.context }
	}
	return { build, calls, runtimes, events }
}

const appliedContext: ResolvedRenderContext = { viewId: VIEW_ID, variantName: 'Many', locale: 'zh-TW', viewportId: 'mobile', viewport: { width: 390, height: 844 }, themeId: 'dark' }
const viewFixture = { id: VIEW_ID } as ViewResource
function mounted(overrides: Partial<BaseStateMounted> = {}): BaseStateMounted {
	return { view: viewFixture, adapters: {} as never, assets: {}, context: appliedContext, viewRevision: 'revision-9', ...overrides }
}
const memberOf = (reading: ReturnType<typeof readBaseState>, key: string) => reading.readings.find(entry => entry.key === key)?.member

describe('readBaseState', () => {
	it('builds one Runtime from the open View with no Variant and the applied Locale, viewport and theme, reads each key from it and disposes it', () => {
		const { build, calls, runtimes } = recordingBuilder()
		const reading = readBaseState(mounted(), 'a', ['count', 'label', 'nothing', 'data'], build)
		expect(calls).toHaveLength(1)
		expect(calls[0]).toEqual({ viewId: VIEW_ID, locale: 'zh-TW', viewportId: 'mobile', viewport: { width: 390, height: 844 }, themeId: 'dark' })
		expect(calls[0]).not.toHaveProperty('variantName')
		expect(reading.readings.map(entry => entry.key)).toEqual(['count', 'label', 'nothing', 'data'])
		expect(memberOf(reading, 'count')).toEqual({ value: 0 })
		expect(memberOf(reading, 'label')).toEqual({ value: 'base' })
		expect(memberOf(reading, 'nothing')).toEqual({ value: null })
		expect(memberOf(reading, 'data')).toEqual({ value: JSON.parse('{"list":[1,"two",null],"flag":true,"__proto__":1}') })
		// The render context echoes what the Runtime applied, with the revision of the View read it mounted.
		expect(reading.renderContext).toEqual({ viewRevision: 'revision-9', locale: 'zh-TW', viewportId: 'mobile', viewport: { width: 390, height: 844 }, themeId: 'dark' })
		expect(runtimes).toHaveLength(1)
		expect(runtimes[0]!.isDisposed).toBe(true)
	})

	it('answers Unavailable for a Widget or State member that does not exist, however the key is spelled', () => {
		const { build } = recordingBuilder()
		const reading = readBaseState(mounted(), 'a', ['missing', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'count'], build)
		for (const key of ['missing', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(memberOf(reading, key)).toEqual({ unavailable: true })
		expect(memberOf(reading, 'count')).toEqual({ value: 0 })
		const ghost = readBaseState(mounted(), 'ghost', ['count'], build)
		expect(memberOf(ghost, 'count')).toEqual({ unavailable: true })
		// Only a Widget of the View: the RootShell's own State is read like any other.
		expect(memberOf(readBaseState(mounted(), '__proto__', ['count'], build), 'count')).toEqual({ unavailable: true })
	})

	it('answers Unavailable for a value that is not allowed, never coercing it to null', () => {
		const { build } = recordingBuilder()
		const reading = readBaseState(mounted(), 'a', ['fn', 'nan', 'undef', 'opaque', 'cyclic', 'count'], build)
		for (const key of ['fn', 'nan', 'undef', 'opaque', 'cyclic']) expect(memberOf(reading, key)).toEqual({ unavailable: true })
		expect(memberOf(reading, 'count')).toEqual({ value: 0 })
	})

	it('answers every key Unavailable when no base Runtime can be built, and never throws', () => {
		const invalid: Build = () => ({ state: 'invalid', diagnostics: [{ code: 'x', path: '', message: 'broken' }] })
		const reading = readBaseState(mounted(), 'a', ['count', 'label'], invalid)
		expect(reading.readings).toEqual([{ key: 'count', member: { unavailable: true } }, { key: 'label', member: { unavailable: true } }])
		expect(reading.renderContext.viewRevision).toBe('revision-9')
		const throwing: Build = () => { throw new Error('adapter exploded') }
		expect(readBaseState(mounted(), 'a', ['count'], throwing).readings).toEqual([{ key: 'count', member: { unavailable: true } }])
	})

	it('disposes the base Runtime whatever the read does', () => {
		let disposed = 0
		// A Runtime this widget-core instance did not create cannot be inspected, so every read fails.
		const foreign: Build = input => ({ state: 'ready', runtime: { isDisposed: false, dispose() { disposed++ } } as never, context: input.context })
		expect(readBaseState(mounted(), 'a', ['count'], foreign).readings).toEqual([{ key: 'count', member: { unavailable: true } }])
		expect(disposed).toBe(1)
		// A Runtime that fails to dispose does not fail the answer.
		const stubborn: Build = input => ({ state: 'ready', runtime: { isDisposed: false, dispose() { throw new Error('no') } } as never, context: input.context })
		expect(readBaseState(mounted(), 'a', ['count'], stubborn).readings).toEqual([{ key: 'count', member: { unavailable: true } }])
	})

	it('is isolated: it invokes no Method, emits no Widget Event, and leaves the live Runtime and its State alone', () => {
		const live = statefulRuntime()
		const liveWidget = live.getWidget('a') as unknown as { state: { count: { set(value: number): unknown; get(): number } } }
		liveWidget.state.count.set(9)
		const liveEvents: unknown[] = []
		const inspection = inspectRuntime(live)
		inspection.getWidget(inspection.blueprint.nodes.find(node => node.resolved && node.node.id === 'a')!.nodeId)?.getEvent('poked')?.subscribe(args => liveEvents.push(args))
		const { build, events, runtimes } = recordingBuilder()
		const before = pokes
		const reading = readBaseState(mounted(), 'a', ['count', 'label', 'data'], build)
		expect(memberOf(reading, 'count')).toEqual({ value: 0 })
		expect(pokes).toBe(before)
		expect(events).toEqual([])
		expect(liveEvents).toEqual([])
		expect(live.isDisposed).toBe(false)
		expect(liveWidget.state.count.get()).toBe(9)
		expect(runtimes.every(runtime => runtime !== live)).toBe(true)
		live.dispose()
	})

	it('copies a value, so nothing of the base Runtime is shared with the answer', () => {
		const { build, runtimes } = recordingBuilder()
		const reading = readBaseState(mounted(), 'a', ['data'], build)
		const member = memberOf(reading, 'data')
		expect(runtimes[0]!.isDisposed).toBe(true)
		expect(member).toEqual({ value: JSON.parse('{"list":[1,"two",null],"flag":true,"__proto__":1}') })
	})
})

describe('answerBaseStateRequest', () => {
	const request = (overrides: { context?: Record<string, unknown>; payload?: Record<string, unknown> } = {}): BaseStateRequestMessage => ({
		type: 'inspection.base-state.request',
		context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID, variantId: 'Many', ...overrides.context },
		payload: { requestId: 'request-1', widgetId: 'a', keys: ['count', 'missing'], ...overrides.payload },
	} as BaseStateRequestMessage)

	it('answers a request for the mounted View and Variant, echoing its context, requestId and widgetId, with the applied render context', () => {
		const { build } = recordingBuilder()
		const answer = answerBaseStateRequest(request(), mounted(), build)
		expect(answer).toEqual({
			type: 'inspection.base-state.response',
			context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID, variantId: 'Many' },
			payload: {
				requestId: 'request-1',
				widgetId: 'a',
				renderContext: { viewRevision: 'revision-9', locale: 'zh-TW', viewportId: 'mobile', viewport: { width: 390, height: 844 }, themeId: 'dark' },
				values: { count: { value: 0 }, missing: { unavailable: true } },
			},
		})
		expect(validateBaseStateMessage(answer).ok).toBe(true)
	})

	it('drops a request whose View or Variant is not the mounted one, or when nothing is mounted', () => {
		const { build, calls } = recordingBuilder()
		expect(answerBaseStateRequest(request({ context: { viewId: OTHER_VIEW_ID } }), mounted(), build)).toBeUndefined()
		expect(answerBaseStateRequest(request({ context: { variantId: 'Other' } }), mounted(), build)).toBeUndefined()
		// The mounted Variant is open and the request names none, or the reverse.
		const withoutVariant = request()
		const base = { ...withoutVariant, context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID } } as BaseStateRequestMessage
		expect(answerBaseStateRequest(base, mounted(), build)).toBeUndefined()
		expect(answerBaseStateRequest(request(), mounted({ context: { ...appliedContext, variantName: undefined } }), build)).toBeUndefined()
		expect(answerBaseStateRequest(base, mounted({ context: { ...appliedContext, variantName: undefined } }), build)).toBeDefined()
		expect(answerBaseStateRequest(request(), undefined, build)).toBeUndefined()
		// A View whose mounted resource is another View than its context names is not the mounted View.
		expect(answerBaseStateRequest(request(), mounted({ view: { id: OTHER_VIEW_ID } as ViewResource }), build)).toBeUndefined()
		// Nothing was built for any dropped request.
		expect(calls).toHaveLength(1)
	})

	it('takes keys in request order and makes a value that would pass the envelope bound Unavailable', () => {
		const { build } = recordingBuilder()
		const answer = answerBaseStateRequest(request({ payload: { keys: ['big', 'big2', 'count'] } }), mounted(), build)!
		expect(answer.payload.values.big).toMatchObject({ value: expect.any(String) })
		expect(answer.payload.values.big2).toEqual({ unavailable: true })
		expect(answer.payload.values.count).toEqual({ value: 0 })
		expect(JSON.stringify(answer).length).toBeLessThanOrEqual(MAX_BASE_STATE_RESPONSE_LENGTH)
		const reversed = answerBaseStateRequest(request({ payload: { keys: ['big2', 'big'] } }), mounted(), build)!
		expect(reversed.payload.values.big2).toMatchObject({ value: expect.any(String) })
		expect(reversed.payload.values.big).toEqual({ unavailable: true })
	})

	it('never sends a failure.report for an Unavailable key or a Runtime it cannot build', () => {
		const workbenchOutbound: PreviewWireMessage[] = []
		const runtimeOutbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', { send: message => workbenchOutbound.push(message) }, () => ({ ok: true }))
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', { protocolVersion: 1, features: ['geometry', FAILURE_REPORTS_FEATURE, BASE_STATE_FEATURE] }, { send: message => runtimeOutbound.push(message) })
		workbench.receive(runtime.declareCapabilities())
		runtime.receive(workbenchOutbound[0])
		expect(workbench.sendBaseStateRequest(request({ payload: { keys: ['count', 'label'] } }))).toEqual({ status: 'sent' })
		const received = runtime.receive(workbenchOutbound.at(-1))
		if (received.status !== 'accepted' || received.message.type !== 'inspection.base-state.request') throw new Error('request not accepted')
		const unbuildable: Build = () => { throw new Error('adapter exploded') }
		const answer = answerBaseStateRequest(received.message, mounted(), unbuildable)!
		expect(runtime.sendBaseStateResponse(answer)).toEqual({ status: 'sent' })
		expect(runtimeOutbound.some(message => message.type === 'failure.report')).toBe(false)
		const arrived = workbench.receive(runtimeOutbound.at(-1))
		expect(arrived).toMatchObject({ status: 'accepted', message: { payload: { values: { count: { unavailable: true }, label: { unavailable: true } } } } })
	})
})

// -------------------------------------------------------------------------------------------------
// The mounted Preview runtime (bundle, Vue renderer): what it has applied, and what it has mounted
// -------------------------------------------------------------------------------------------------

const temporaryRoots: string[] = []
afterEach(async () => {
	clearPreviewBundleCache()
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const ADAPTER_SOURCE = `
import { createWidgetPlugin } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';
import { useWidget } from '@deviltea/widget-vue';

export const statefulPlugin = createWidgetPlugin('Stateful')
  .interfaces()
  .state(state => state
    .count({ authorWritable: true, validate: v => typeof v === 'number', default: () => 0 })
    .label({ validate: v => typeof v === 'string', default: () => 'base' }))
  .events(events => events.poked({ description: 'Poked' }))
  .done();

export const StatefulRenderer = defineComponent({
  name: 'StatefulRenderer',
  setup() {
    const { widgetId } = useWidget(statefulPlugin);
    return () => h('div', { 'data-widget-id': widgetId }, 'stateful');
  },
});

export const manifest = {
  id: 'stateful-adapter',
  apiVersion: '1',
  widgetPlugins: [statefulPlugin],
  catalog: { widgets: { Stateful: {} } },
  renderers: [{ type: 'Stateful', component: StatefulRenderer }],
  providers: [],
};
`

function statefulView(content: readonly Record<string, unknown>[] = [{ id: 'stateful-1', type: 'Stateful' }]): ViewResource {
	return {
		id: VIEW_ID,
		name: 'Stateful View',
		ir: { type: 'RootShell', id: 'root', slots: { content } } as never,
		variants: {
			Many: { state: { 'stateful-1': { count: 5 } } },
			Broken: { state: { 'stateful-1': { nope: 1 } } },
		},
		spec: { intent: 'Base-state fixture', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
	} as ViewResource
}

async function statefulWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-base-state-test-'))
	temporaryRoots.push(root)
	await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })
	for (const name of ['@deviltea/widget-core', '@deviltea/widget-vue', 'vue'])
		await symlink(join(process.cwd(), 'node_modules', name), join(root, 'node_modules', name)).catch(() => undefined)
	await writeCurrentWorkspace(root, { i18n: { defaultLocale: 'en-US' }, adapters: [{ moduleSpecifier: './adapters/stateful.mjs' }], viewports: {}, themes: {} })
	await writeFile(join(root, 'kit', 'adapters', 'stateful.mjs'), ADAPTER_SOURCE)
	return root
}

type BundleModule = Readonly<{
	mountPreviewRuntime: (container: HTMLElement, options: PreviewRuntimeMountOptions) => PreviewRuntimeBridge
}>

async function loadBundle(root: string): Promise<BundleModule> {
	const resolution = await resolveSelectedWorkspaceAdapters(root)
	if (resolution.state !== 'valid') throw new Error(JSON.stringify(resolution.diagnostics))
	const bundle = await buildWorkspacePreviewBundle({ workspaceRoot: root, set: resolution.set })
	const win = new Window()
	globalThis.window = win as unknown as typeof globalThis.window
	globalThis.document = win.document as unknown as Document
	globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement
	globalThis.Element = win.Element as unknown as typeof Element
	globalThis.Node = win.Node as unknown as typeof Node
	globalThis.SVGElement = win.SVGElement as unknown as typeof SVGElement
	const file = join(root, `bundle-${Date.now()}.mjs`)
	await writeFile(file, bundle.bundleJs)
	return await import(file) as BundleModule
}

function renderContext(overrides: Partial<ResolvedRenderContext> = {}): ResolvedRenderContext {
	return { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light', ...overrides }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function askFor(variantId: string | undefined, overrides: { viewId?: string; keys?: readonly string[] } = {}): BaseStateRequestMessage {
	return {
		type: 'inspection.base-state.request',
		context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: overrides.viewId ?? VIEW_ID, ...(variantId ? { variantId } : {}) },
		payload: { requestId: 'request-1', widgetId: 'stateful-1', keys: overrides.keys ?? ['count', 'label', 'missing'] },
	}
}

describe('mounted Preview runtime: base state', () => {
	it('reads the base state from a separate Runtime while the live one keeps its Variant, State and observers untouched', async () => {
		const bundle = await loadBundle(await statefulWorkspace())
		const events: unknown[] = []
		const container = document.createElement('div')
		document.body.appendChild(container)
		const bridge = bundle.mountPreviewRuntime(container, { view: statefulView(), viewRevision: 'revision-1', context: renderContext({ variantName: 'Many' }), onWidgetEvent: report => events.push(report) })
		bridge.armWidgetEvents?.('arm-1', [{ widgetId: 'stateful-1', event: 'poked' }])
		await wait(5)
		const probe = bridge.interactionProbe!()
		// The live Runtime holds the open Variant's value.
		expect(probe.readState('stateful-1', 'count')).toEqual({ found: true, value: 5 })
		const answer = bridge.answerBaseStateRequest!(askFor('Many'))!
		expect(answer.payload.values).toEqual({ count: { value: 0 }, label: { value: 'base' }, missing: { unavailable: true } })
		expect(answer.payload.renderContext).toEqual({ viewRevision: 'revision-1', locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' })
		expect(answer.payload.requestId).toBe('request-1')
		expect(answer.payload.widgetId).toBe('stateful-1')
		// Nothing changed in the live Runtime, and nothing was reported for the read.
		expect(probe.readState('stateful-1', 'count')).toEqual({ found: true, value: 5 })
		await wait(5)
		expect(events).toEqual([])
		expect(container.querySelectorAll('[data-widget-id="stateful-1"]')).toHaveLength(1)
		// A second read after the first gives the same answer: nothing was left behind.
		expect(bridge.answerBaseStateRequest!(askFor('Many'))!.payload.values).toEqual(answer.payload.values)
		bridge.dispose()
	})

	it('drops a request for another View or Variant than the mounted one', async () => {
		const bundle = await loadBundle(await statefulWorkspace())
		const container = document.createElement('div')
		document.body.appendChild(container)
		const bridge = bundle.mountPreviewRuntime(container, { view: statefulView(), viewRevision: 'revision-1', context: renderContext({ variantName: 'Many' }) })
		expect(bridge.answerBaseStateRequest!(askFor('Many', { viewId: OTHER_VIEW_ID }))).toBeUndefined()
		expect(bridge.answerBaseStateRequest!(askFor(undefined))).toBeUndefined()
		expect(bridge.answerBaseStateRequest!(askFor('Broken'))).toBeUndefined()
		expect(bridge.answerBaseStateRequest!(askFor('Many'))).toBeDefined()
		bridge.dispose()
		expect(bridge.answerBaseStateRequest!(askFor('Many'))).toBeUndefined()
	})

	it('echoes the render context the Runtime has applied, never one it is about to apply', async () => {
		const bundle = await loadBundle(await statefulWorkspace())
		const container = document.createElement('div')
		document.body.appendChild(container)
		const bridge = bundle.mountPreviewRuntime(container, { view: statefulView(), viewRevision: 'revision-1', context: renderContext({ variantName: 'Many' }) })
		bridge.updateContext(renderContext({ variantName: 'Many', locale: 'zh-TW', viewportId: 'mobile', viewport: { width: 390, height: 844 }, themeId: 'dark' }))
		const applied = bridge.answerBaseStateRequest!(askFor('Many'))!
		expect(applied.payload.renderContext).toEqual({ viewRevision: 'revision-1', locale: 'zh-TW', viewportId: 'mobile', viewport: { width: 390, height: 844 }, themeId: 'dark' })

		// A Variant the Runtime cannot switch to is not mounted: the old one stays, and a request for the new one is dropped.
		bridge.updateContext(renderContext({ variantName: 'Broken', locale: 'zh-TW', viewportId: 'mobile', viewport: { width: 390, height: 844 }, themeId: 'dark' }))
		expect(bridge.answerBaseStateRequest!(askFor('Broken'))).toBeUndefined()
		expect(bridge.answerBaseStateRequest!(askFor('Many'))).toBeDefined()
		bridge.dispose()
	})

	it('echoes the revision of the View read it mounted, and answers nothing for a View that is not mounted', async () => {
		const bundle = await loadBundle(await statefulWorkspace())
		const container = document.createElement('div')
		document.body.appendChild(container)
		const bridge = bundle.mountPreviewRuntime(container, { view: statefulView(), viewRevision: 'revision-1', context: renderContext() })
		expect(bridge.answerBaseStateRequest!(askFor(undefined))!.payload.renderContext.viewRevision).toBe('revision-1')
		bridge.updateView(statefulView(), undefined, 'revision-2')
		expect(bridge.answerBaseStateRequest!(askFor(undefined))!.payload.renderContext.viewRevision).toBe('revision-2')
		// A View an update refused (a Widget type no Adapter materializes) never reads as mounted.
		bridge.updateView(statefulView([{ id: 'stateful-1', type: 'Unknown' }]), undefined, 'revision-3')
		expect(bridge.answerBaseStateRequest!(askFor(undefined))!.payload.renderContext.viewRevision).toBe('revision-2')
		// Without a revision there is nothing to echo.
		bridge.updateView(statefulView())
		expect(bridge.answerBaseStateRequest!(askFor(undefined))).toBeUndefined()
		bridge.dispose()

		const without = bundle.mountPreviewRuntime(container, { view: statefulView(), context: renderContext() })
		expect(without.answerBaseStateRequest!(askFor(undefined))).toBeUndefined()
		without.dispose()
	})

	it('answers Unavailable for a Widget the mounted View does not have, and still answers', async () => {
		const bundle = await loadBundle(await statefulWorkspace())
		const container = document.createElement('div')
		document.body.appendChild(container)
		const bridge = bundle.mountPreviewRuntime(container, { view: statefulView(), viewRevision: 'revision-1', context: renderContext() })
		const answer = bridge.answerBaseStateRequest!({ ...askFor(undefined), payload: { requestId: 'r', widgetId: 'ghost', keys: ['count'] } })!
		expect(answer.payload.values).toEqual({ count: { unavailable: true } })
		expect(validateBaseStateMessage(answer).ok).toBe(true)
		bridge.dispose()
	})
})
