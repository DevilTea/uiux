import type { AnyWidgetPlugin } from '@deviltea/widget-core'
import { createWidgetVueRenderer } from '@deviltea/widget-vue'
import type { Component } from 'vue'

import type { Diagnostic } from '../domain/validation'
import type { ResolvedRenderContext } from '../domain/render-context/schema'
import type { ViewResource } from '../domain/views/schema'
import { createTranslationRuntime } from '../i18n'
import {
	createAdapterWidgetSystem,
	createRootShellPlugin,
	createRootShellRenderer,
	LiveViewRuntimeController,
	type RuntimeAdapterBundle,
	type RuntimeAdapterBundleResult,
} from '../runtime'

export type PreviewMaterializationResult =
	| Readonly<{
		status: 'ready'
		controller?: LiveViewRuntimeController
		bundle?: RuntimeAdapterBundle
		supportedTypes?: readonly string[]
	}>
	| Readonly<{
		status: 'adapter_unavailable'
		diagnostics: readonly Diagnostic[]
		unsupportedTypes: readonly string[]
	}>
	| Readonly<{
		status: 'invalid'
		diagnostics: readonly Diagnostic[]
	}>

/**
 * Builds the canonical UIUX-owned RootShell adapter bundle for the browser preview. A widget-core
 * registration error (only possible when UIUX itself loads two widget-core copies) is returned as
 * diagnostics instead of thrown.
 */
export function buildRootShellAdapterBundle(locale = 'en-US'): RuntimeAdapterBundleResult {
	const translationResult = createTranslationRuntime(locale, new Map())
	const defaultResult = createTranslationRuntime('en-US', new Map())
	const translation = translationResult.state === 'ready'
		? translationResult.runtime
		: (defaultResult.state === 'ready' ? defaultResult.runtime : undefined as never)

	const rootShellPlugin = createRootShellPlugin(translation)
	const rootShellRenderer = createRootShellRenderer(rootShellPlugin)

	const plugins: AnyWidgetPlugin[] = [rootShellPlugin]
	const renderers = new Map<string, Component>([['RootShell', rootShellRenderer]])

	const created = createAdapterWidgetSystem(plugins, [''])
	if (created.state === 'invalid') return created
	const system = created.system
	const dynamicCreate = createWidgetVueRenderer as unknown as (
		sys: typeof system,
		build: (section: Record<string, (component: Component) => unknown>) => unknown,
	) => ReturnType<typeof createWidgetVueRenderer>

	const renderer = dynamicCreate(system, initial => {
		let section: unknown = initial
		for (const [type, comp] of renderers)
			section = (section as Record<string, (value: Component) => unknown>)[type]!(comp)
		return section
	})

	return {
		state: 'ready',
		diagnostics: [],
		bundle: {
			system,
			renderer,
			pluginsByType: new Map([['RootShell', rootShellPlugin]]),
			catalogByType: new Map(),
		},
	}
}

/**
 * Inspects a View's IR to detect any widget types outside the UIUX-managed RootShell.
 */
export function collectWidgetTypesFromIr(ir: unknown): readonly string[] {
	if (!isRecord(ir)) return []
	const types = new Set<string>()
	function scan(node: unknown) {
		if (!isRecord(node)) return
		if (typeof node.type === 'string' && node.type)
			types.add(node.type)
		if (isRecord(node.slots)) {
			for (const children of Object.values(node.slots)) {
				if (Array.isArray(children))
					children.forEach(scan)
			}
		}
	}
	scan(ir)
	return Object.freeze([...types])
}

/**
 * Evaluates and materializes the View in the browser preview environment.
 * If external adapter widgets are present, returns status: 'adapter_unavailable'
 * with explicit diagnostics documenting the missing module transport seam.
 */
export function materializePreviewView(input: Readonly<{
	view: ViewResource
	context: ResolvedRenderContext
	bundle?: RuntimeAdapterBundle
}>): PreviewMaterializationResult {
	const allTypes = collectWidgetTypesFromIr(input.view.ir)
	let bundle = input.bundle
	if (!bundle) {
		const built = buildRootShellAdapterBundle(input.context.locale)
		if (built.state === 'invalid') return { status: 'invalid', diagnostics: built.diagnostics }
		bundle = built.bundle
	}
	const supportedTypes = new Set(bundle.pluginsByType.keys())

	const unsupportedTypes = allTypes.filter(type => !supportedTypes.has(type))
	if (unsupportedTypes.length > 0) {
		return {
			status: 'adapter_unavailable',
			unsupportedTypes: Object.freeze(unsupportedTypes),
			diagnostics: Object.freeze([
				{
					code: 'adapter.materialization_unavailable',
					path: '/adapters',
					message: `Adapter browser materialization unavailable for widget types: [${unsupportedTypes.join(', ')}]. Loading external adapter packages in the browser requires an accepted server-to-browser module transport contract.`,
				},
			]),
		}
	}

	const controllerResult = LiveViewRuntimeController.create({
		view: input.view,
		adapters: bundle,
		context: input.context,
	})

	if (controllerResult instanceof LiveViewRuntimeController) {
		return {
			status: 'ready',
			controller: controllerResult,
			bundle,
		}
	}

	return {
		status: 'invalid',
		diagnostics: controllerResult.state === 'invalid' ? controllerResult.diagnostics : [],
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
