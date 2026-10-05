import { createApp, h, shallowRef, type Component } from 'vue'
import { createWidgetSystem, type AnyWidgetPlugin } from '@deviltea/widget-core'
import { createWidgetVueRenderer } from '@deviltea/widget-vue'

import type { Diagnostic } from '../domain/validation'
import type { ResolvedRenderContext } from '../domain/render-context/schema'
import type { ViewResource } from '../domain/views/schema'
import type { I18nResource } from '../domain/i18n/schema'
import { validateAdapterManifest, type AdapterManifest } from '../domain/adapters/schema'
import { createTranslationRuntime, type TranslationRuntime } from '../i18n'
import {
	createRootShellPlugin,
	createRootShellRenderer,
	LiveViewRuntimeController,
	type RuntimeAdapterBundle,
} from '../runtime'
import {
	extractProductAdapterManifest,
	productAdapterRuntimeMemberDecoder,
} from '../adapters/product-integration'
import { collectWidgetTypesFromIr } from './preview-runtime'

export type StandaloneAdapterDescriptor = Readonly<{
	index: number
	id: string
	apiVersion: string
	widgetTypes: readonly string[]
	rendererKeys: readonly string[]
	namespace: Readonly<Record<string, unknown>>
}>

export type PreviewRuntimeStatus =
	| Readonly<{
		status: 'ready'
		supportedTypes: readonly string[]
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

export interface PreviewRuntimeBridge {
	updateView(view: ViewResource): void
	updateContext(context: ResolvedRenderContext): void
	updateLocales?(locales: ReadonlyMap<string, I18nResource> | Record<string, I18nResource>): void
	dispose(): void
}

export interface PreviewRuntimeMountOptions {
	view: ViewResource
	context: ResolvedRenderContext
	onStatusChange?: (status: PreviewRuntimeStatus) => void
	locales?: ReadonlyMap<string, I18nResource> | Record<string, I18nResource>
}

export type StandalonePreviewMountFactory = Readonly<{
	mountPreviewRuntime(container: HTMLElement, options: PreviewRuntimeMountOptions): PreviewRuntimeBridge
}>

/**
 * Creates the browser preview mount factory for the standalone bundle.
 * It re-checks expected adapter identity and ownership against the runtime members
 * actually imported by the bundle, and exposes a mount/update/dispose bridge.
 */
export function createStandalonePreviewMount(input: Readonly<{
	adapterDescriptors: readonly StandaloneAdapterDescriptor[]
}>): StandalonePreviewMountFactory {
	const buildDiagnostics: Diagnostic[] = []
	const validatedEntries: Array<{
		index: number
		manifest: AdapterManifest
		widgetTypes: readonly string[]
		rendererKeys: readonly string[]
		decodedPlugins: readonly AnyWidgetPlugin[]
		decodedRenderers: ReadonlyMap<string, Component>
	}> = []

	for (const desc of input.adapterDescriptors) {
		const basePath = `/adapters/${desc.index}`
		let manifest: AdapterManifest
		try {
			manifest = extractProductAdapterManifest(desc.namespace)
		}
		catch (cause) {
			buildDiagnostics.push({
				code: 'adapter.runtime_manifest_extract_failed',
				path: `${basePath}/manifest`,
				message: cause instanceof Error ? cause.message : 'Failed to extract manifest from imported adapter module.',
			})
			continue
		}

		const validation = validateAdapterManifest(manifest)
		if (!validation.ok) {
			for (const diag of validation.diagnostics) {
				buildDiagnostics.push({
					...diag,
					path: `${basePath}/manifest${diag.path || ''}`,
				})
			}
			continue
		}

		if (manifest.id !== desc.id) {
			buildDiagnostics.push({
				code: 'adapter.runtime_identity_mismatch',
				path: `${basePath}/id`,
				message: `Imported adapter id '${manifest.id}' does not match expected id '${desc.id}'.`,
			})
		}

		if (manifest.apiVersion !== desc.apiVersion) {
			buildDiagnostics.push({
				code: 'adapter.runtime_api_version_mismatch',
				path: `${basePath}/apiVersion`,
				message: `Imported adapter apiVersion '${manifest.apiVersion}' does not match expected '${desc.apiVersion}'.`,
			})
		}

		const decodedPlugins: AnyWidgetPlugin[] = []
		for (const [pluginIndex, member] of manifest.widgetPlugins.entries()) {
			try {
				decodedPlugins.push(productAdapterRuntimeMemberDecoder.decodePlugin(member))
			}
			catch (cause) {
				buildDiagnostics.push({
					code: 'adapter.runtime_plugin_decode_failed',
					path: `${basePath}/manifest/widgetPlugins/${pluginIndex}`,
					message: cause instanceof Error ? cause.message : 'Plugin decode failed',
				})
			}
		}

		const decodedRenderers = new Map<string, Component>()
		for (const [rendererIndex, member] of manifest.renderers.entries()) {
			try {
				const decoded = productAdapterRuntimeMemberDecoder.decodeRenderer(member)
				if (decodedRenderers.has(decoded.type)) {
					buildDiagnostics.push({
						code: 'adapter.runtime_renderer_collision',
						path: `${basePath}/manifest/renderers/${rendererIndex}`,
						message: `Renderer type '${decoded.type}' is registered more than once by this adapter.`,
					})
				}
				else {
					decodedRenderers.set(decoded.type, decoded.component)
				}
			}
			catch (cause) {
				buildDiagnostics.push({
					code: 'adapter.runtime_renderer_decode_failed',
					path: `${basePath}/manifest/renderers/${rendererIndex}`,
					message: cause instanceof Error ? cause.message : 'Renderer decode failed',
				})
			}
		}

		const pluginTypes = decodedPlugins.map(p => p.type)
		const rendererTypes = [...decodedRenderers.keys()]

		if (!sameSet(pluginTypes, desc.widgetTypes)) {
			buildDiagnostics.push({
				code: 'adapter.runtime_plugin_ownership_mismatch',
				path: `${basePath}/manifest/widgetPlugins`,
				message: `Imported widget plugin types [${pluginTypes.join(', ')}] do not match expected ownership [${desc.widgetTypes.join(', ')}].`,
			})
		}

		if (!sameSet(rendererTypes, desc.rendererKeys)) {
			buildDiagnostics.push({
				code: 'adapter.runtime_renderer_ownership_mismatch',
				path: `${basePath}/manifest/renderers`,
				message: `Imported renderer keys [${rendererTypes.join(', ')}] do not match expected ownership [${desc.rendererKeys.join(', ')}].`,
			})
		}

		validatedEntries.push({
			index: desc.index,
			manifest,
			widgetTypes: desc.widgetTypes,
			rendererKeys: desc.rendererKeys,
			decodedPlugins,
			decodedRenderers,
		})
	}

	function mountPreviewRuntime(container: HTMLElement, options: PreviewRuntimeMountOptions): PreviewRuntimeBridge {
		if (buildDiagnostics.length > 0) {
			options.onStatusChange?.({
				status: 'invalid',
				diagnostics: Object.freeze([...buildDiagnostics]),
			})
			return createNoopBridge()
		}

		const resourceMap = new Map<string, I18nResource>()
		if (options.locales) {
			if (options.locales instanceof Map) {
				for (const [k, v] of options.locales) resourceMap.set(k, v)
			}
			else {
				for (const [k, v] of Object.entries(options.locales)) resourceMap.set(k, v)
			}
		}

		function getTranslationRuntime(currentLocale: string): TranslationRuntime {
			const hasPrimary = resourceMap.has(currentLocale)
			const hasFallback = resourceMap.has('en-US')
			const primaryLocale = hasPrimary ? currentLocale : (hasFallback ? 'en-US' : currentLocale)
			const res = createTranslationRuntime(primaryLocale, resourceMap)
			if (res.state === 'ready') {
				return res.runtime
			}
			return {
				defaultLocale: primaryLocale,
				translate(requestedLocale, key) {
					return {
						text: `⟦missing:${key}⟧`,
						warnings: [{ code: 'unresolved-key', key, requestedLocale }],
					}
				},
			}
		}

		let currentTranslationRuntime = getTranslationRuntime(options.context.locale)

		const dynamicTranslation: TranslationRuntime = {
			get defaultLocale() {
				return currentTranslationRuntime.defaultLocale
			},
			translate(requestedLocale, key, params) {
				return currentTranslationRuntime.translate(requestedLocale, key, params)
			},
		}

		const rootShellPlugin = createRootShellPlugin(dynamicTranslation)
		const rootShellRenderer = createRootShellRenderer(rootShellPlugin)

		const plugins: AnyWidgetPlugin[] = [rootShellPlugin]
		const renderers = new Map<string, Component>([['RootShell', rootShellRenderer]])
		const catalogByType = new Map()

		for (const entry of validatedEntries) {
			for (const plugin of entry.decodedPlugins) {
				if (plugin.type === 'RootShell') {
					options.onStatusChange?.({
						status: 'invalid',
						diagnostics: [{
							code: 'adapter.reserved_root_shell_type',
							path: `/adapters/${entry.index}/manifest/widgetPlugins`,
							message: 'RootShell is owned exclusively by UIUX.',
						}],
					})
					return createNoopBridge()
				}
				plugins.push(plugin)
			}
			for (const [type, component] of entry.decodedRenderers) {
				if (type === 'RootShell') {
					options.onStatusChange?.({
						status: 'invalid',
						diagnostics: [{
							code: 'adapter.reserved_root_shell_renderer',
							path: `/adapters/${entry.index}/manifest/renderers`,
							message: 'RootShell renderer is owned exclusively by UIUX.',
						}],
					})
					return createNoopBridge()
				}
				renderers.set(type, component)
			}
			for (const [type, catalog] of Object.entries(entry.manifest.catalog.widgets)) {
				catalogByType.set(type, catalog)
			}
		}

		const pluginsByType = new Map(plugins.map(p => [p.type, p] as const))
		const system = createWidgetSystem({ plugins })

		const dynamicCreate = createWidgetVueRenderer as unknown as (
			sys: typeof system,
			build: (section: Record<string, (component: Component) => unknown>) => unknown,
		) => ReturnType<typeof createWidgetVueRenderer>

		const renderer = dynamicCreate(system, (initial) => {
			let section: unknown = initial
			for (const [type, comp] of renderers) {
				section = (section as Record<string, (value: Component) => unknown>)[type]!(comp)
			}
			return section
		})

		const bundle: RuntimeAdapterBundle = {
			system,
			renderer,
			pluginsByType,
			catalogByType,
		}

		const supportedTypes = new Set(bundle.pluginsByType.keys())
		let currentView = options.view
		let currentContext = options.context

		function checkViewSupport(view: ViewResource): readonly string[] {
			const allTypes = collectWidgetTypesFromIr(view.ir)
			return allTypes.filter(t => !supportedTypes.has(t))
		}

		const unsupported = checkViewSupport(currentView)
		if (unsupported.length > 0) {
			options.onStatusChange?.({
				status: 'adapter_unavailable',
				unsupportedTypes: Object.freeze(unsupported),
				diagnostics: Object.freeze([
					{
						code: 'adapter.materialization_unavailable',
						path: '/adapters',
						message: `Adapter browser materialization unavailable for widget types: [${unsupported.join(', ')}].`,
					},
				]),
			})
			return createNoopBridge()
		}

		const controllerResult = LiveViewRuntimeController.create({
			view: currentView,
			adapters: bundle,
			context: currentContext,
		})

		if (!(controllerResult instanceof LiveViewRuntimeController)) {
			options.onStatusChange?.({
				status: 'invalid',
				diagnostics: controllerResult.state === 'invalid' ? controllerResult.diagnostics : [],
			})
			return createNoopBridge()
		}

		let activeController: LiveViewRuntimeController = controllerResult
		const activeRuntime = shallowRef(activeController.runtime)

		const app = createApp({
			setup() {
				return () => h('div', { class: 'uiux-preview-materialized-root' }, [
					h(bundle.renderer, { runtime: activeRuntime.value }),
				])
			},
		})

		container.innerHTML = ''
		app.mount(container)

		options.onStatusChange?.({
			status: 'ready',
			supportedTypes: Object.freeze([...supportedTypes]),
		})

		return {
			updateView(newView: ViewResource) {
				currentView = newView
				const nextUnsupported = checkViewSupport(currentView)
				if (nextUnsupported.length > 0) {
					options.onStatusChange?.({
						status: 'adapter_unavailable',
						unsupportedTypes: Object.freeze(nextUnsupported),
						diagnostics: Object.freeze([
							{
								code: 'adapter.materialization_unavailable',
								path: '/adapters',
								message: `Adapter browser materialization unavailable for widget types: [${nextUnsupported.join(', ')}].`,
							},
						]),
					})
					return
				}

				activeController.dispose()
				const nextController = LiveViewRuntimeController.create({
					view: currentView,
					adapters: bundle,
					context: currentContext,
				})

				if (!(nextController instanceof LiveViewRuntimeController)) {
					options.onStatusChange?.({
						status: 'invalid',
						diagnostics: nextController.state === 'invalid' ? nextController.diagnostics : [],
					})
					return
				}

				activeController = nextController
				activeRuntime.value = activeController.runtime
				options.onStatusChange?.({
					status: 'ready',
					supportedTypes: Object.freeze([...supportedTypes]),
				})
			},

			updateContext(nextContext: ResolvedRenderContext) {
				currentContext = nextContext
				if (nextContext.locale !== activeController.context.locale) {
					currentTranslationRuntime = getTranslationRuntime(nextContext.locale)
					activeController.updateLocale(nextContext.locale)
				}
				if (nextContext.themeId !== activeController.context.themeId) {
					activeController.updateTheme(nextContext.themeId)
				}
				if (
					nextContext.viewportId !== activeController.context.viewportId
					|| nextContext.viewport.width !== activeController.context.viewport.width
					|| nextContext.viewport.height !== activeController.context.viewport.height
				) {
					activeController.updateViewport(nextContext.viewportId, nextContext.viewport)
				}
				if (nextContext.variantName !== activeController.context.variantName) {
					const switchResult = activeController.switchVariant(nextContext.variantName)
					if (switchResult.state === 'ready') {
						activeRuntime.value = activeController.runtime
					}
					else {
						options.onStatusChange?.({
							status: 'invalid',
							diagnostics: switchResult.diagnostics,
						})
					}
				}
			},

			updateLocales(locales: ReadonlyMap<string, I18nResource> | Record<string, I18nResource>) {
				if (locales instanceof Map) {
					for (const [k, v] of locales) resourceMap.set(k, v)
				}
				else {
					for (const [k, v] of Object.entries(locales)) resourceMap.set(k, v)
				}
				currentTranslationRuntime = getTranslationRuntime(activeController.context.locale)
				activeController.dispose()
				const nextController = LiveViewRuntimeController.create({
					view: currentView,
					adapters: bundle,
					context: currentContext,
				})
				if (nextController instanceof LiveViewRuntimeController) {
					activeController = nextController
					activeRuntime.value = activeController.runtime
				}
			},

			dispose() {
				app.unmount()
				activeController.dispose()
				container.innerHTML = ''
			},
		}
	}

	return { mountPreviewRuntime }
}

function createNoopBridge(): PreviewRuntimeBridge {
	return {
		updateView() {},
		updateContext() {},
		dispose() {},
	}
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return false
	const a = [...actual].sort()
	const e = [...expected].sort()
	return a.every((value, index) => value === e[index])
}
