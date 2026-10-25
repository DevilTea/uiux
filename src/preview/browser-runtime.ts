import { createApp, h, nextTick, shallowRef, type Component } from 'vue'
import type { AnyWidgetPlugin, WidgetSystemRuntime } from '@deviltea/widget-core'
import { inspectPlugin, WidgetInspectionError } from '@deviltea/widget-core/inspection'
import { createWidgetVueRenderer } from '@deviltea/widget-vue'

import type { AdapterProviderContext } from '../adapter-entry'
import type { AssetResolutionTable } from '../assets/bindings'
import type { Diagnostic, JsonValue } from '../domain/validation'
import type { ResolvedRenderContext } from '../domain/render-context/schema'
import type { ViewResource } from '../domain/views/schema'
import type { I18nResource } from '../domain/i18n/schema'
import { validateAdapterManifest, validateAdapterProviders, type AdapterManifest } from '../domain/adapters/schema'
import { isAllowedThemeAttributeName } from '../domain/product-kit/theme-attributes'
import { createTranslationRuntime, missingDefaultLocaleDiagnostic, type TranslationRuntime } from '../i18n'
import {
	catalogWidgetPath,
	createAdapterWidgetSystem,
	createRootShellPlugin,
	createRootShellRenderer,
	incompatibleWidgetCoreDiagnostic,
	IncompatibleWidgetCoreError,
	LiveViewRuntimeController,
	type RuntimeAdapterBundle,
	validateCatalogAgainstPlugin,
} from '../runtime'
import {
	extractProductAdapterManifest,
	productAdapterRuntimeMemberDecoder,
} from '../adapters/product-integration'
import { collectWidgetTypesFromIr } from './preview-runtime'
import { FALLBACK_LOCALE } from './render-context-options'
import { evaluateTranslationProperties, type TranslationEvaluation } from './translation-evaluation'
import { describeWidgetCatalogEntry, type DescribedWidgetCatalog } from './widget-catalog'
import { WidgetEventObserver, type WidgetEventReport } from './widget-event-observer'
import type { WidgetEventTrigger } from './protocol/widget-events'

export type StandaloneAdapterDescriptor = Readonly<{
	index: number
	id: string
	apiVersion: string
	widgetTypes: readonly string[]
	rendererKeys: readonly string[]
	/**
	 * The Adapter entry's configuration that passed server-side validation, embedded in the bundle;
	 * absent when the entry has none (Rules 01a11a5a-515e-7c1d-9990-82e883c33243 and
	 * 01a11a5a-535f-73f2-96d0-6ccb02910f0b).
	 */
	config?: JsonValue
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
	/** A persistent Workspace configuration error keeps the Preview from rendering (the missing default-Locale file). */
	| Readonly<{
		status: 'blocked'
		diagnostics: readonly Diagnostic[]
	}>

export interface PreviewRuntimeBridge {
	/** A new View; `assets`, when given, replaces the resolution of the Assets it binds. */
	updateView(view: ViewResource, assets?: AssetResolutionTable): void
	updateContext(context: ResolvedRenderContext): void
	updateLocales?(locales: ReadonlyMap<string, I18nResource> | Record<string, I18nResource>): void
	/**
	 * Applies a Widget Event arm (Part 2 "Widget Event reporting", decisions 3 and 4): full
	 * replacement, no triggers disarms. The host checks the arm's View and Variant first.
	 */
	armWidgetEvents?(armId: string, triggers: readonly WidgetEventTrigger[]): void
	/**
	 * The capture harness's live-versus-fresh hook (Rule 01a11bb1-a7bf-74ae-9639-b39f246fa117): writes
	 * a Variant's State into the mounted base-state Runtime in place, without remounting anything, and
	 * returns the diagnostics of that write. Only the formal capture harness calls it.
	 */
	applyVariantStateLive?(variantName: string): readonly Diagnostic[]
	/**
	 * The capture harness's translation evaluation (Rule 01a115cd-ba68-7c73-a157-08ef34be1e54): reads every
	 * Catalog-declared translation-result Property of the mounted View and Variant, hidden Widgets included,
	 * and returns the results and the Properties that could not be evaluated. It throws while the Runtime
	 * is not mounted. Only the formal capture harness calls it.
	 */
	evaluateTranslations?(): TranslationEvaluation
	dispose(): void
}

export interface PreviewRuntimeMountOptions {
	view: ViewResource
	context: ResolvedRenderContext
	onStatusChange?: (status: PreviewRuntimeStatus) => void
	locales?: ReadonlyMap<string, I18nResource> | Record<string, I18nResource>
	/**
	 * The server's resolution of every Asset the View binds (Clause 01a167f4-3e4e-7af1-b328-30fb52f7f4c5):
	 * a bound Asset missing from it, or blocked in it, keeps the View from rendering.
	 */
	assets?: AssetResolutionTable
	/** The Workspace `i18n.defaultLocale`: the fallback for keys missing from the requested locale. */
	defaultLocale?: string
	/** Receives at most one report per Widget Event arm; never any Event argument. */
	onWidgetEvent?: (report: WidgetEventReport) => void
	/**
	 * The Product Kit stylesheet's URL. The construction links it first, at the end of the document's
	 * head, and renders only once it has loaded; a load error fails the construction (Rules
	 * 01a11a5a-4d38-7f2c-98be-755d8c404d98, 01a11bb1-ad41-761c-ad47-a0e7ed5b8240 and
	 * 01a11be8-6078-7669-8e6d-6005d42c16dd). Without it the construction renders at once.
	 */
	stylesheetHref?: string
	/**
	 * The Product Kit `themes`: Workspace theme ID to root attributes, set on the document element for
	 * the active theme and swapped on a live theme change (Rules 01a11bb1-ada4-7dd7-b3da-733de7a85df4
	 * and 01a11bb1-ae0b-7120-888f-97234df0aa3b).
	 */
	themes?: PreviewThemeAttributes
}

/** Workspace theme ID to the root attributes (name to value) the Product Kit sets for it. */
export type PreviewThemeAttributes = Readonly<Record<string, Readonly<Record<string, string>>>>

/** The diagnostic of a Product Kit stylesheet that failed to load (Rule 01a11a5a-5059-716e-b0a5-d178395be034). */
export function stylesheetLoadFailedDiagnostic(href: string): Diagnostic {
	return {
		code: 'preview.stylesheet_load_failed',
		path: '/product-kit',
		message: `The Product Kit stylesheet ${href} failed to load, so the Preview cannot be constructed.`,
	}
}

/**
 * The diagnostic of a provider entry that failed a construction, naming the Adapter, the member and
 * the entry index (Rule 01a11a5a-5059-716e-b0a5-d178395be034): its install threw, or returned a
 * promise (Rule 01a11a5a-4ecd-7edb-a9e2-5918f01880e7). `adapterIndex` is the Product Kit index.
 */
export function providerInstallFailedDiagnostic(input: Readonly<{ adapterIndex: number; adapterId: string; entryIndex: number; cause?: unknown; returnedPromise?: boolean }>): Diagnostic {
	const subject = `Provider ${input.entryIndex} of Adapter ${input.adapterId} (providers/${input.entryIndex})`
	return input.returnedPromise
		? {
				code: 'adapter.provider_install_async',
				path: `/adapters/${input.adapterIndex}/manifest/providers/${input.entryIndex}`,
				message: `${subject} returned a promise from its install; a provider installs synchronously, so the Preview cannot be constructed.`,
			}
		: {
				code: 'adapter.provider_install_failed',
				path: `/adapters/${input.adapterIndex}/manifest/providers/${input.entryIndex}`,
				message: `${subject} failed to install, so the Preview cannot be constructed: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
			}
}

/** A deep-frozen copy of a JSON value: what a provider receives as its configuration. */
function deepFrozenCopy(value: JsonValue): JsonValue {
	return deepFreeze(structuredClone(value))
}

function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null) {
		for (const member of Object.values(value)) deepFreeze(member)
		Object.freeze(value)
	}
	return value
}

/** Marks the Product Kit stylesheet link a construction inserts. */
export const PRODUCT_KIT_STYLESHEET_ATTRIBUTE = 'data-uiux-product-kit-stylesheet'

/**
 * The active theme's root attributes on a document element. Applying a theme first restores what
 * the previous one replaced, so a swap leaves no attribute of the old theme behind, and `restore`
 * returns the element to how the construction found it.
 */
function createThemeRootAttributes(element: Element, themes: PreviewThemeAttributes) {
	const replaced = new Map<string, string | null>()
	function restore(): void {
		for (const [name, previous] of replaced) {
			if (previous === null) element.removeAttribute(name)
			else element.setAttribute(name, previous)
		}
		replaced.clear()
	}
	return {
		apply(themeId: string): void {
			restore()
			const attributes = Object.hasOwn(themes, themeId) ? themes[themeId]! : {}
			for (const [rawName, value] of Object.entries(attributes)) {
				// HTML lowercases attribute names, so track the name the element stores: a mixed-case name
				// would otherwise be recorded twice and leave the first value behind on restore.
				const name = rawName.toLowerCase()
				// Defense in depth: only `class` and `data-*`, even when the validator was bypassed.
				if (!isAllowedThemeAttributeName(name) || typeof value !== 'string') continue
				if (!replaced.has(name)) replaced.set(name, element.getAttribute(name))
				element.setAttribute(name, value)
			}
		},
		restore,
	}
}

/** A Widget type's declared Events, from `inspectPlugin(plugin).events` (metadata only). */
export type DeclaredWidgetEvent = Readonly<{ name: string; description: string }>
export type DeclaredWidgetEvents = Readonly<Record<string, readonly DeclaredWidgetEvent[]>>

/**
 * Chooses the translation runtime's default (fallback) locale: always the Workspace default locale
 * when one is known. UIUX never substitutes another Locale for it (Rule
 * 01a115cd-b24f-7bcd-acd8-6b00d0aceff2); a known default without its resource blocks the Preview
 * instead (`mountPreviewRuntime`, Rule 01a115cd-b30b-706e-b8a2-46e62259156e). Callers that do not
 * know the Workspace default get the same fallback the render context uses when no Workspace
 * manifest is available, else the requested locale.
 */
export function resolveTranslationFallbackLocale(
	requestedLocale: string,
	workspaceDefaultLocale: string | undefined,
	resources: ReadonlyMap<string, unknown>,
): string {
	if (workspaceDefaultLocale) return workspaceDefaultLocale
	if (resources.has(FALLBACK_LOCALE)) return FALLBACK_LOCALE
	return requestedLocale
}

export type StandalonePreviewMountFactory = Readonly<{
	mountPreviewRuntime(container: HTMLElement, options: PreviewRuntimeMountOptions): PreviewRuntimeBridge
	/**
	 * The declared Events of every adapter Widget type, read through `inspectPlugin` from the same
	 * widget-core copy the bundle runs. Declaration metadata only: no Runtime is created. The server
	 * reads these in the same worker evaluation as `describeAdapterDiagnostics()`.
	 */
	describeDeclaredWidgetEvents(): DeclaredWidgetEvents
	/**
	 * The diagnostics of the checks the factory ran on the imported Adapter members with the bundle's
	 * own widget-core copy: manifest, identity, API version, plugin authenticity (Clause
	 * 01a116f0-cae2-7c64-9c76-d472f252789a), renderers, ownership and the Catalog's i18n mappings
	 * against the decoded plugins (Clause 01a115cd-d293-7515-a7bd-bb82a0674e5d). Empty when every
	 * Adapter passed.
	 * The server evaluates the bundle and reads these (`src/server/preview-adapter-check.ts`), so
	 * every surface reports what the Preview itself refuses.
	 */
	describeAdapterDiagnostics(): readonly Diagnostic[]
	/**
	 * One row per Widget type of the Adapters this bundle decoded, with the plugin's declarations and the
	 * Catalog entry (`src/preview/widget-catalog.ts`), for the Workbench's Catalog view. Metadata only.
	 */
	describeWidgetCatalog(): DescribedWidgetCatalog
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
		/** The `providers` entries, in entry order, and the validated configuration they receive. */
		providers: readonly unknown[]
		config: JsonValue | undefined
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

		// The provider entries' shape, as server-side resolution checks it (Rule 01a11a5a-4c2c-7330-8fac-11a6c970713a).
		for (const diag of validateAdapterProviders(manifest, `${basePath}/manifest`).diagnostics) buildDiagnostics.push(diag)

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
			providers: manifest.providers,
			config: desc.config,
		})
	}

	// The Catalog-against-plugin check of the runtime materialization (Clause
	// 01a115cd-d293-7515-a7bd-bb82a0674e5d), on the plugins this bundle decoded. A Catalog type
	// without a decoded plugin has nothing to check against here; a plugin that failed to decode
	// already has its own diagnostic.
	const decodedPluginsByType = new Map(validatedEntries.flatMap(entry => entry.decodedPlugins.map(plugin => [plugin.type, plugin] as const)))
	for (const entry of validatedEntries) {
		for (const [type, catalog] of Object.entries(entry.manifest.catalog.widgets)) {
			const plugin = decodedPluginsByType.get(type)
			if (plugin) buildDiagnostics.push(...validateCatalogAgainstPlugin(plugin, catalog, catalogWidgetPath(entry.index, type)))
		}
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

		// Rule 01a115cd-b30b-706e-b8a2-46e62259156e: while the Workspace default Locale has no Locale
		// file, the Preview is blocked; it never renders with another Locale as the fallback.
		if (options.defaultLocale && !resourceMap.has(options.defaultLocale)) {
			options.onStatusChange?.({
				status: 'blocked',
				diagnostics: [missingDefaultLocaleDiagnostic(options.defaultLocale)],
			})
			return createNoopBridge()
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
		let currentAssets: AssetResolutionTable = options.assets ?? {}

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
			assets: currentAssets,
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
		/**
		 * `linking` until the Product Kit stylesheet has loaded (the first render waits for it),
		 * `mounted` from the first render, `failed` once the stylesheet failed to load or a provider
		 * failed to install.
		 */
		let phase: 'linking' | 'mounted' | 'failed' = 'mounted'
		/** The latest status an update reported while linking, reported at the first render instead of `ready`. */
		let statusWhileLinking: PreviewRuntimeStatus | undefined
		function reportStatus(status: PreviewRuntimeStatus): void {
			if (phase === 'linking') statusWhileLinking = status
			else if (phase === 'mounted') options.onStatusChange?.(status)
		}
		// Widget Event observation (decision 4): it starts once a Runtime has mounted, so creation and
		// mount-time emissions never count, and it follows every Runtime instance swap.
		const eventObserver = new WidgetEventObserver(report => options.onWidgetEvent?.(report))

		/** Shows a new Runtime instance and observes it once it has mounted (after the re-render). */
		function showRuntime(runtime: WidgetSystemRuntime): void {
			activeRuntime.value = runtime
			void nextTick().then(() => {
				if (!disposed && phase === 'mounted' && activeRuntime.value === runtime) eventObserver.attach(runtime)
			})
		}

		const app = createApp({
			setup() {
				return () => h('div', { class: 'uiux-preview-materialized-root' }, [
					h(bundle.renderer, { runtime: activeRuntime.value }),
				])
			},
		})

		const ownerDocument = container.ownerDocument
		// The active theme's root attributes are on the document before the stylesheet applies.
		const rootAttributes = createThemeRootAttributes(ownerDocument.documentElement, options.themes ?? {})
		let appliedThemeId = currentContext.themeId
		rootAttributes.apply(appliedThemeId)

		let stylesheetLink: HTMLLinkElement | undefined
		/** The cleanups the providers registered through `app.onUnmount`, for a construction that fails before it mounts. */
		const providerCleanups: Array<() => unknown> = []

		/**
		 * Installs every provider on the Preview's Vue app, in Adapter-list order and then entry order,
		 * once per construction and before its first render (Rules 01a11a5a-4d38-7f2c-98be-755d8c404d98
		 * and 01a115cd-ae6b-7a85-be8e-0a42517daf17). An Adapter's providers receive, as the `app.use`
		 * options, one frozen install context `{ adapterId, config }` whose `config` is a deep-frozen copy
		 * of the configuration that passed validation, or `undefined` (Clause
		 * 01a11a5a-4309-7ad5-8279-e1f60045017f, Rule 01a11a5a-515e-7c1d-9990-82e883c33243); this is the
		 * only way Adapter code reaches its configuration (Rule 01a11a5a-51dc-743c-993c-d4b3079beec7).
		 *
		 * Each entry is installed as Vue's `app.use(entry, context)` installs it (an `install` function is
		 * called with the entry as `this`, otherwise the entry itself, and an entry already installed on
		 * this app is skipped), but called here directly so that what the install returns is seen: a
		 * promise fails the construction (Rule 01a11a5a-4ecd-7edb-a9e2-5918f01880e7), as a throw does.
		 * Returns the diagnostic of the entry that failed, if any.
		 */
		function installProviders(): Diagnostic | undefined {
			const registerUnmountCleanup = app.onUnmount
			app.onUnmount = (cleanup) => {
				providerCleanups.push(cleanup)
				registerUnmountCleanup(cleanup)
			}
			const installed = new WeakSet<object>()
			try {
				for (const entry of validatedEntries) {
					const context: AdapterProviderContext = Object.freeze({
						adapterId: entry.manifest.id,
						config: entry.config === undefined ? undefined : deepFrozenCopy(entry.config),
					})
					for (const [entryIndex, provider] of entry.providers.entries()) {
						const plugin = provider as ((...args: unknown[]) => unknown) & { install?: (...args: unknown[]) => unknown }
						if (installed.has(plugin)) continue
						installed.add(plugin)
						let result: unknown
						let returnedPromise: boolean
						try {
							result = typeof plugin.install === 'function' ? plugin.install(app, context) : plugin(app, context)
							returnedPromise = isThenable(result)
						}
						catch (cause) {
							return providerInstallFailedDiagnostic({ adapterIndex: entry.index, adapterId: entry.manifest.id, entryIndex, cause })
						}
						if (returnedPromise) {
							// The construction has failed; a later rejection of the promise is not reported again.
							Promise.resolve(result).catch(() => {})
							return providerInstallFailedDiagnostic({ adapterIndex: entry.index, adapterId: entry.manifest.id, entryIndex, returnedPromise: true })
						}
					}
				}
				return undefined
			}
			finally {
				app.onUnmount = registerUnmountCleanup
			}
		}

		/**
		 * Fails the whole construction and keeps nothing of it (Rules 01a115cd-ae3e-7ef7-8a53-5ccd86e143bf
		 * and 01a11a5a-4e44-77e0-bdf6-49ab11f5f3a5): the stylesheet link, the root attributes, the Runtime
		 * and, since the app never mounted and so never unmounts, the cleanups its providers registered.
		 */
		function failConstruction(diagnostic: Diagnostic): void {
			phase = 'failed'
			stylesheetLink?.remove()
			rootAttributes.restore()
			eventObserver.dispose()
			activeController.dispose()
			for (const cleanup of providerCleanups.splice(0)) {
				try {
					cleanup()
				}
				catch {
					// One provider's failing cleanup does not keep the others from running.
				}
			}
			options.onStatusChange?.({ status: 'invalid', diagnostics: [diagnostic] })
		}

		function firstRender(): void {
			const failure = installProviders()
			if (failure) {
				failConstruction(failure)
				return
			}
			providerCleanups.length = 0
			phase = 'mounted'
			container.innerHTML = ''
			app.mount(container)
			options.onStatusChange?.(statusWhileLinking ?? {
				status: 'ready',
				supportedTypes: Object.freeze([...supportedTypes]),
			})
			eventObserver.attach(activeRuntime.value)
		}

		// The Product Kit stylesheet is linked first, after UIUX's own stylesheets in the head, and the
		// first render waits for it; a load error fails the whole construction and keeps nothing of it.
		// The providers install once it has loaded, right before the first render, so a construction
		// disposed while linking has installed none and has nothing of theirs to undo.
		if (options.stylesheetHref) {
			const href = options.stylesheetHref
			phase = 'linking'
			const link = ownerDocument.createElement('link')
			link.rel = 'stylesheet'
			link.href = href
			link.setAttribute(PRODUCT_KIT_STYLESHEET_ATTRIBUTE, '')
			link.addEventListener('load', () => {
				if (!disposed && phase === 'linking') firstRender()
			}, { once: true })
			link.addEventListener('error', () => {
				if (disposed || phase !== 'linking') return
				failConstruction(stylesheetLoadFailedDiagnostic(href))
			}, { once: true })
			stylesheetLink = link
			ownerDocument.head.append(link)
		}
		else {
			firstRender()
		}

		return {
			updateView(newView: ViewResource, assets?: AssetResolutionTable) {
				if (disposed || phase === 'failed') return
				if (newView.id !== currentView.id) eventObserver.clearArm()
				currentView = newView
				if (assets) currentAssets = assets
				const nextUnsupported = checkViewSupport(currentView)
				if (nextUnsupported.length > 0) {
					reportStatus({
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
					assets: currentAssets,
				})

				if (!(nextController instanceof LiveViewRuntimeController)) {
					reportStatus({
						status: 'invalid',
						diagnostics: nextController.state === 'invalid' ? nextController.diagnostics : [],
					})
					return
				}

				activeController = nextController
				showRuntime(activeController.runtime)
				reportStatus({
					status: 'ready',
					supportedTypes: Object.freeze([...supportedTypes]),
				})
			},

			updateContext(nextContext: ResolvedRenderContext) {
				if (disposed || phase === 'failed') return
				currentContext = nextContext
				// A live theme change swaps the root attributes inside this construction.
				if (nextContext.themeId !== appliedThemeId) {
					appliedThemeId = nextContext.themeId
					rootAttributes.apply(appliedThemeId)
				}
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
						if (phase === 'mounted') eventObserver.attach(activeController.runtime)
						reportStatus({
							status: 'invalid',
							diagnostics: switchResult.diagnostics,
						})
					}
				}
			},

			updateLocales(locales: ReadonlyMap<string, I18nResource> | Record<string, I18nResource>) {
				if (disposed || phase === 'failed') return
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
					assets: currentAssets,
				})
				if (nextController instanceof LiveViewRuntimeController) {
					activeController = nextController
					showRuntime(activeController.runtime)
				}
			},

			armWidgetEvents(armId: string, triggers: readonly WidgetEventTrigger[]) {
				eventObserver.setArm(armId, triggers)
			},

			applyVariantStateLive(variantName: string): readonly Diagnostic[] {
				if (disposed || phase === 'failed') return [{ code: 'preview.runtime_failed', path: '/preview', message: 'The Preview runtime is not mounted.' }]
				const diagnostics = activeController.applyVariantStateLive(variantName)
				currentContext = activeController.context
				return diagnostics
			},

			evaluateTranslations(): TranslationEvaluation {
				if (disposed || phase !== 'mounted') throw new Error('The Preview runtime is not mounted.')
				return evaluateTranslationProperties({
					view: currentView,
					runtime: activeController.runtime,
					catalogByType: bundle.catalogByType,
					variantName: activeController.context.variantName,
				})
			},

			dispose() {
				if (disposed) return
				disposed = true
				// The construction's stylesheet link and root attributes go with it.
				stylesheetLink?.remove()
				if (phase === 'failed') return
				rootAttributes.restore()
				eventObserver.dispose()
				if (phase === 'mounted') app.unmount()
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

	function describeAdapterDiagnostics(): readonly Diagnostic[] {
		return Object.freeze([...buildDiagnostics])
	}

	function describeWidgetCatalog(): DescribedWidgetCatalog {
		return Object.freeze(validatedEntries.flatMap(entry => entry.decodedPlugins.map(plugin => describeWidgetCatalogEntry({
			adapterIndex: entry.index,
			adapterId: entry.manifest.id,
			plugin,
			catalog: Object.hasOwn(entry.manifest.catalog.widgets, plugin.type) ? entry.manifest.catalog.widgets[plugin.type] : undefined,
		}))))
	}

	return { mountPreviewRuntime, describeDeclaredWidgetEvents, describeAdapterDiagnostics, describeWidgetCatalog }
}

function createNoopBridge(): PreviewRuntimeBridge {
	return {
		updateView() {},
		updateContext() {},
		armWidgetEvents() {},
		dispose() {},
	}
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return false
	const a = [...actual].sort()
	const e = [...expected].sort()
	return a.every((value, index) => value === e[index])
}
