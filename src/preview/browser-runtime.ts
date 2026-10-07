import { createApp, h, nextTick, shallowRef, type Component } from 'vue'
import type { AnyWidgetPlugin, WidgetSystemRuntime } from '@deviltea/widget-core'
import { inspectPlugin, WidgetInspectionError } from '@deviltea/widget-core/inspection'
import { createWidgetVueRenderer } from '@deviltea/widget-vue'

import type { Diagnostic } from '../domain/validation'
import type { ResolvedRenderContext } from '../domain/render-context/schema'
import type { ViewResource } from '../domain/views/schema'
import type { I18nResource } from '../domain/i18n/schema'
import { validateAdapterManifest, type AdapterManifest } from '../domain/adapters/schema'
import { createTranslationRuntime, type TranslationRuntime } from '../i18n'
import {
	createAdapterWidgetSystem,
	createRootShellPlugin,
	createRootShellRenderer,
	incompatibleWidgetCoreDiagnostic,
	IncompatibleWidgetCoreError,
	LiveViewRuntimeController,
	type RuntimeAdapterBundle,
} from '../runtime'
import {
	extractProductAdapterManifest,
	productAdapterRuntimeMemberDecoder,
} from '../adapters/product-integration'
import { collectWidgetTypesFromIr } from './preview-runtime'
import { FALLBACK_LOCALE } from './render-context-options'
import { WidgetEventObserver, type WidgetEventReport } from './widget-event-observer'
import type { WidgetEventTrigger } from './protocol/widget-events'

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
	/**
	 * Applies a Widget Event arm (Part 2 "Widget Event reporting", decisions 3 and 4): full
	 * replacement, no triggers disarms. The host checks the arm's View and Variant first.
	 */
	armWidgetEvents?(armId: string, triggers: readonly WidgetEventTrigger[]): void
	dispose(): void
}

export interface PreviewRuntimeMountOptions {
	view: ViewResource
	context: ResolvedRenderContext
	onStatusChange?: (status: PreviewRuntimeStatus) => void
	locales?: ReadonlyMap<string, I18nResource> | Record<string, I18nResource>
	/** The Workspace `i18n.defaultLocale`: the fallback for keys missing from the requested locale. */
	defaultLocale?: string
	/** Receives at most one report per Widget Event arm; never any Event argument. */
	onWidgetEvent?: (report: WidgetEventReport) => void
}

/** A Widget type's declared Events, from `inspectPlugin(plugin).events` (metadata only). */
export type DeclaredWidgetEvent = Readonly<{ name: string; description: string }>
export type DeclaredWidgetEvents = Readonly<Record<string, readonly DeclaredWidgetEvent[]>>

/**
 * Chooses the translation runtime's default (fallback) locale: the Workspace
 * default locale when its resource is loaded, otherwise the requested locale.
 * Callers that do not know the Workspace default get the same fallback the
 * render context uses when no Workspace manifest is available.
 */
export function resolveTranslationFallbackLocale(
	requestedLocale: string,
	workspaceDefaultLocale: string | undefined,
	resources: ReadonlyMap<string, unknown>,
): string {
	const fallback = workspaceDefaultLocale || FALLBACK_LOCALE
	if (resources.has(fallback)) return fallback
	return requestedLocale
}

export type StandalonePreviewMountFactory = Readonly<{
	mountPreviewRuntime(container: HTMLElement, options: PreviewRuntimeMountOptions): PreviewRuntimeBridge
	/**
	 * The declared Events of every adapter Widget type, read through `inspectPlugin` from the same
	 * widget-core copy the bundle runs. Declaration metadata only: no Runtime is created.
	 */
	describeDeclaredWidgetEvents(): DeclaredWidgetEvents
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
		/** The `widgetPlugins` member path of each entry of `decodedPlugins`. */
		decodedPluginPaths: readonly string[]
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
		const decodedPluginPaths: string[] = []
		for (const [pluginIndex, member] of manifest.widgetPlugins.entries()) {
			const pluginPath = `${basePath}/manifest/widgetPlugins/${pluginIndex}`
			try {
				decodedPlugins.push(productAdapterRuntimeMemberDecoder.decodePlugin(member))
				decodedPluginPaths.push(pluginPath)
			}
			catch (cause) {
				buildDiagnostics.push(cause instanceof IncompatibleWidgetCoreError
					? incompatibleWidgetCoreDiagnostic(pluginPath, cause)
					: {
							code: 'adapter.runtime_plugin_decode_failed',
							path: pluginPath,
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
			decodedPluginPaths,
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
			// The runtime's default locale is the fallback for keys missing from the requested locale,
			// so it must be the Workspace default locale, not the requested one.
			const primaryLocale = resolveTranslationFallbackLocale(currentLocale, options.defaultLocale, resourceMap)
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
		// The JSON Pointer reported for each entry of `plugins`; RootShell is UIUX-owned and has none.
		const pluginPaths: string[] = ['']
		const renderers = new Map<string, Component>([['RootShell', rootShellRenderer]])
		const catalogByType = new Map()

		for (const entry of validatedEntries) {
			for (const [pluginIndex, plugin] of entry.decodedPlugins.entries()) {
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
				pluginPaths.push(entry.decodedPluginPaths[pluginIndex]!)
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
		const created = createAdapterWidgetSystem(plugins, pluginPaths)
		if (created.state === 'invalid') {
			options.onStatusChange?.({ status: 'invalid', diagnostics: created.diagnostics })
			return createNoopBridge()
		}
		const system = created.system

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
		let disposed = false
		// Widget Event observation (decision 4): it starts once a Runtime has mounted, so creation and
		// mount-time emissions never count, and it follows every Runtime instance swap.
		const eventObserver = new WidgetEventObserver(report => options.onWidgetEvent?.(report))

		/** Shows a new Runtime instance and observes it once it has mounted (after the re-render). */
		function showRuntime(runtime: WidgetSystemRuntime): void {
			activeRuntime.value = runtime
			void nextTick().then(() => {
				if (!disposed && activeRuntime.value === runtime) eventObserver.attach(runtime)
			})
		}

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
		eventObserver.attach(activeRuntime.value)

		return {
			updateView(newView: ViewResource) {
				if (newView.id !== currentView.id) eventObserver.clearArm()
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

				eventObserver.detach()
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
				showRuntime(activeController.runtime)
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
					// A Variant change clears the arm; the Workbench arms the new context itself.
					eventObserver.clearArm()
					eventObserver.detach()
					const switchResult = activeController.switchVariant(nextContext.variantName)
					if (switchResult.state === 'ready') {
						showRuntime(activeController.runtime)
					}
					else {
						eventObserver.attach(activeController.runtime)
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
				eventObserver.detach()
				activeController.dispose()
				const nextController = LiveViewRuntimeController.create({
					view: currentView,
					adapters: bundle,
					context: currentContext,
				})
				if (nextController instanceof LiveViewRuntimeController) {
					activeController = nextController
					showRuntime(activeController.runtime)
				}
			},

			armWidgetEvents(armId: string, triggers: readonly WidgetEventTrigger[]) {
				eventObserver.setArm(armId, triggers)
			},

			dispose() {
				disposed = true
				eventObserver.dispose()
				app.unmount()
				activeController.dispose()
				container.innerHTML = ''
			},
		}
	}

	function describeDeclaredWidgetEvents(): DeclaredWidgetEvents {
		const result: Record<string, readonly DeclaredWidgetEvent[]> = {}
		for (const entry of validatedEntries) {
			for (const plugin of entry.decodedPlugins) {
				try {
					const events = inspectPlugin(plugin).events
					result[plugin.type] = Object.freeze([...(events?.values() ?? [])]
						.filter(member => typeof member.name === 'string')
						.map(member => Object.freeze({ name: member.name, description: member.description })))
				}
				catch (cause) {
					// widget-core documents that inspectPlugin rejects a Plugin this module instance did not
					// complete with `WidgetInspectionError`: such a plugin has no known declared Events.
					// Any other exception is a defect and propagates.
					if (!(cause instanceof WidgetInspectionError)) throw cause
				}
			}
		}
		return Object.freeze(result)
	}

	return { mountPreviewRuntime, describeDeclaredWidgetEvents }
}

function createNoopBridge(): PreviewRuntimeBridge {
	return {
		updateView() {},
		updateContext() {},
		armWidgetEvents() {},
		dispose() {},
	}
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return false
	const a = [...actual].sort()
	const e = [...expected].sort()
	return a.every((value, index) => value === e[index])
}
