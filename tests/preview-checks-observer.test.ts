import { describe, expect, it } from 'vitest'
import { createWidgetPlugin } from '@deviltea/widget-core'
import { defineComponent, h } from 'vue'

import { resolveWorkspaceAdapterSet } from '../src/adapters'
import type { AdapterManifest, AdapterWidgetCatalogEntry } from '../src/domain/adapters/schema'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import type { TranslationResult } from '../src/domain/i18n/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { createTranslationRuntime, UIUX_STRING_VALUE_CONTRACT, UIUX_TRANSLATION_RESULT_VALUE_CONTRACT } from '../src/i18n'
import { RuntimeChecksObserver, type ChecksObservation } from '../src/preview/checks-observer'
import {
	createRootShellPlugin, createRootShellRenderer, LiveViewRuntimeController, materializeRuntimeAdapterBundle,
} from '../src/runtime'

/**
 * The runtime's passive observation of translation-result Properties and failed Properties (issue
 * #347; Rules 01a115cd-b94f-7a87-830c-2060f2e63a2e, 01a115cd-b9be-7018-9247-003f129366f9 and
 * 01a115cd-b9fc-71d9-8bf9-91d65acd1096): only Properties something evaluated, their latest result, and
 * nothing of an earlier Locale.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'

interface LabelInterfaces {
	config: {
		raw: { readonly title?: string; readonly titleKey?: string }
		resolved: { readonly titleKey: string | null }
	}
	properties: { titleResult: TranslationResult; label: string }
}

/** `shape` makes the result Property return something that is not a TranslationResult, which widget-core reports as a failed Property. */
const labelPlugin = createWidgetPlugin('Label')
	.description('Checks observer fixture')
	.interfaces<LabelInterfaces>()
	.config({
		description: 'Label config',
		schema: {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			properties: { title: { type: 'string' }, titleKey: { type: 'string' } },
			additionalProperties: false,
		},
		validate: (input): input is LabelInterfaces['config']['raw'] => input === undefined || input === null || (typeof input === 'object' && !Array.isArray(input)),
		resolve: raw => ({ titleKey: raw?.titleKey ?? null }),
	})
	.properties(properties => properties
		.titleResult({
			valueContract: UIUX_TRANSLATION_RESULT_VALUE_CONTRACT,
			registerDeps: ({ dep }) => ({
				t: dep.root.methods.invoke('t').validate((value): value is TranslationResult => typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string'),
			}),
			compute: ({ config, deps, addDiagnostic }) => {
				if (config.titleKey === null) return { text: '', warnings: [] }
				// `diag` has the Property report a diagnostic of its own, which widget-core records as a failed result.
				if (config.titleKey === 'diag') {
					addDiagnostic({ message: 'the compute rejected its input' } as never)
					return { text: '', warnings: [] }
				}
				if (config.titleKey === 'shape') return { text: 5, warnings: [] } as unknown as TranslationResult
				const translated = deps.t(config.titleKey, {})
				return translated.ok && translated.value ? translated.value : { text: '', warnings: [] }
			},
		})
		.label({
			valueContract: UIUX_STRING_VALUE_CONTRACT,
			registerDeps: ({ dep }) => ({ result: dep.self.properties.get('titleResult') }),
			compute: ({ deps }) => {
				const result = deps.result()
				return result.ok ? result.value?.text ?? '' : ''
			},
		}))
	.done()

const labelCatalog: AdapterWidgetCatalogEntry = {
	i18n: { fields: { title: { configField: 'titleKey', resultProperty: 'titleResult', textProperty: 'label' } } },
}

const RESOURCES = new Map<string, Readonly<Record<string, string>>>([
	['en-US', { greeting: 'Hello', onlyEnglish: 'Only in English' }],
	['zh-TW', { greeting: '哈囉' }],
])

async function bundle() {
	const state = createTranslationRuntime('en-US', RESOURCES)
	if (state.state !== 'ready') throw new Error('translation runtime is blocked')
	const rootShell = createRootShellPlugin(state.runtime)
	const manifest: AdapterManifest = {
		id: 'fixture', apiVersion: 'test', widgetPlugins: ['Label'],
		catalog: { widgets: { Label: labelCatalog } }, renderers: ['Label'], providers: [],
	}
	const resolved = await resolveWorkspaceAdapterSet({
		workspaceRoot: '/fixture',
		adapters: [{ moduleSpecifier: '@fixture/adapter' }],
		resolver: { async resolve(_root, moduleSpecifier) { return { moduleSpecifier, resolvedPath: '/fixture/adapter.mjs', moduleIdentity: 'file:///fixture/adapter.mjs' } } },
		loader: { async loadManifest() { return manifest } },
		apiCompatibility: { isCompatible() { return true } },
		registryInspector: { async inspect() { return { widgetTypes: ['Label'], rendererKeys: ['Label'] } } },
	})
	if (resolved.state !== 'valid') throw new Error(JSON.stringify(resolved.diagnostics))
	const materialized = await materializeRuntimeAdapterBundle({
		set: resolved.set, rootShellPlugin: rootShell, rootShellRenderer: createRootShellRenderer(rootShell),
		decoder: {
			async decodePlugin() { return labelPlugin },
			async decodeRenderer() { return { type: 'Label', component: defineComponent({ name: 'LabelRenderer', setup: () => () => h('span') }) } },
		},
	})
	if (materialized.state !== 'ready') throw new Error(JSON.stringify(materialized.diagnostics))
	return { adapters: materialized.bundle, translation: state.runtime }
}

const label = (id: string, key: string) => ({ id, type: 'Label', config: { title: { $i18n: key } } })

function view(children: readonly Record<string, unknown>[]): ViewResource {
	return {
		id: VIEW_ID, name: 'Observer fixture',
		ir: { type: 'RootShell', id: 'root', slots: { content: children } } as never,
		variants: {},
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

const context = (overrides: Partial<ResolvedRenderContext> = {}): ResolvedRenderContext => ({ viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light', ...overrides })

async function setup(children: readonly Record<string, unknown>[]) {
	const { adapters } = await bundle()
	const controller = LiveViewRuntimeController.create({ view: view(children), adapters, context: context() })
	if (!(controller instanceof LiveViewRuntimeController)) throw new Error(JSON.stringify(controller))
	const observations: ChecksObservation[] = []
	const observer = new RuntimeChecksObserver(adapters.catalogByType, observation => observations.push(observation))
	const read = (widgetId: string, property: string) => (controller.runtime.getWidget(widgetId) as unknown as { properties: Record<string, { get: () => unknown }> }).properties[property]!.get()
	return { controller, observer, observations, read, adapters }
}

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe('RuntimeChecksObserver', () => {
	it('reports nothing for a Property nothing evaluated, and observing evaluates nothing', async () => {
		const { controller, observer, observations } = await setup([label('a', 'nowhere')])
		observer.attach(controller.runtime)
		await tick()
		expect(observer.observe().translationWarnings).toEqual([])
		expect(observations.at(-1)).toMatchObject({ translationWarnings: [], propertyErrors: [] })
		// Still never evaluated after being observed twice.
		expect(observer.observe().translationWarnings).toEqual([])
		controller.dispose()
	})

	it('reports the warnings of a Property once it is evaluated, replaces them when it recomputes, and skips the others', async () => {
		const { controller, observer, observations, read } = await setup([label('a', 'nowhere'), label('b', 'greeting'), label('c', 'onlyEnglish')])
		observer.attach(controller.runtime)
		await tick()
		read('a', 'titleResult')
		read('b', 'titleResult')
		await tick()
		// `c` was never evaluated, so nothing of it is reported; `b` evaluated clean.
		expect(observations.at(-1)?.translationWarnings).toEqual([
			{ widgetId: 'a', resultProperty: 'titleResult', warning: { code: 'unresolved-key', key: 'nowhere', requestedLocale: 'en-US' } },
		])

		// Evaluating `c` in zh-TW is a later result of the same kind: the report follows the latest result.
		controller.updateLocale('zh-TW')
		observer.reset()
		await tick()
		expect(observer.observe().translationWarnings).toEqual([])
		read('a', 'titleResult')
		read('c', 'titleResult')
		await tick()
		expect(observations.at(-1)?.translationWarnings.map(entry => [entry.widgetId, entry.warning.code, entry.warning.requestedLocale])).toEqual([
			['a', 'unresolved-key', 'zh-TW'],
			['c', 'missing-translation', 'zh-TW'],
		])
		controller.dispose()
	})

	it('forgets a Locale: nothing evaluated before a reset counts until the Property completes a new result', async () => {
		const { controller, observer, read } = await setup([label('a', 'nowhere')])
		observer.attach(controller.runtime)
		read('a', 'titleResult')
		expect(observer.observe().translationWarnings).toHaveLength(1)
		const before = observer.observe().context
		observer.reset()
		expect(observer.observe().translationWarnings).toEqual([])
		expect(observer.observe().context).toBe(before + 1)
		controller.dispose()
	})

	it('reports an evaluated result that is no translation result as a Property error', async () => {
		const { controller, observer, observations, read } = await setup([label('a', 'shape'), label('b', 'greeting')])
		observer.attach(controller.runtime)
		read('a', 'label')
		read('b', 'label')
		await tick()
		const latest = observations.at(-1)!
		// `titleResult` evaluated (through `label`, which reads it) to a result that is no translation result.
		expect(latest.propertyErrors.map(error => [error.widgetId, error.property])).toEqual([['a', 'titleResult']])
		expect(latest.propertyErrors[0]!.detail).toContain('not a { text, warnings }')
		expect(latest.translationWarnings).toEqual([])
		controller.dispose()
	})

	it('reports a Property whose evaluation failed (ok: false) as a Property error with its first diagnostic', async () => {
		const { controller, observer, observations, read } = await setup([label('a', 'diag'), label('b', 'greeting')])
		observer.attach(controller.runtime)
		expect(read('a', 'titleResult')).toMatchObject({ ok: false })
		read('b', 'titleResult')
		await tick()
		const latest = observations.at(-1)!
		expect(latest.propertyErrors).toHaveLength(1)
		expect(latest.propertyErrors[0]).toMatchObject({ widgetId: 'a', property: 'titleResult' })
		expect(latest.propertyErrors[0]!.detail).toContain('the compute rejected its input')
		controller.dispose()
	})

	it('observes a swapped Runtime as a new context, and stops at detach', async () => {
		const first = await setup([label('a', 'nowhere')])
		first.observer.attach(first.controller.runtime)
		first.read('a', 'titleResult')
		const firstContext = first.observer.observe().context
		first.observer.detach()
		expect(first.observer.observe()).toMatchObject({ translationWarnings: [], propertyErrors: [] })
		first.observer.attach(first.controller.runtime)
		expect(first.observer.observe().context).toBeGreaterThan(firstContext)
		// A detached observer reports nothing, even for results that complete afterwards.
		first.observer.detach()
		const before = first.observations.length
		first.read('a', 'label')
		await tick()
		expect(first.observations.length).toBe(before)
		first.controller.dispose()
	})
})
