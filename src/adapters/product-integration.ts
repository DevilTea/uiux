import type { AnyWidgetPlugin } from '@deviltea/widget-core'
import { inspectPlugin } from '@deviltea/widget-core/inspection'
import type { Component } from 'vue'

import { validateAdapterManifest, type AdapterManifest } from '../domain/adapters/schema'
import type { AdapterApiCompatibilityPolicy, AdapterRegistryInspector, AdapterRegistryOwnership } from './resolution'
import type { AdapterRuntimeMemberDecoder, DecodedRendererRegistration } from '../runtime/adapter-runtime'
import { IncompatibleWidgetCoreError, isForeignPluginInspectionError } from '../runtime/widget-core-diagnostics'

/**
 * Discovers exactly one valid AdapterManifest export from an ESM namespace.
 * Throws explicit diagnostics if zero or multiple distinct candidates exist.
 * Does not hardcode export names like "default" or "manifest".
 */
export function extractProductAdapterManifest(namespace: Readonly<Record<string, unknown>>): AdapterManifest {
	if (typeof namespace !== 'object' || namespace === null) {
		throw new Error('Adapter module namespace must be a non-null object.')
	}

	const matchingExports: Array<{ key: string; manifest: AdapterManifest }> = []
	for (const [key, value] of Object.entries(namespace)) {
		if (typeof value === 'object' && value !== null) {
			const validation = validateAdapterManifest(value)
			if (validation.ok) {
				matchingExports.push({ key, manifest: validation.value })
			}
		}
	}

	if (matchingExports.length === 0) {
		const exportedKeys = Object.keys(namespace)
		throw new Error(
			`No valid AdapterManifest export found in module namespace. Available export keys: [${exportedKeys.join(', ')}].`,
		)
	}

	// Deduplicate by object reference in case the same manifest is re-exported under multiple names
	const uniqueManifests = new Set(matchingExports.map(e => e.manifest))
	if (uniqueManifests.size > 1) {
		const candidateKeys = matchingExports.map(e => e.key)
		throw new Error(
			`Ambiguous AdapterManifest exports found in module namespace: [${candidateKeys.join(', ')}]. Exactly one AdapterManifest export is required.`,
		)
	}

	return matchingExports[0]!.manifest
}

/**
 * Implementation decoder for runtime members: inspects AnyWidgetPlugin via inspectPlugin
 * and validates renderer registrations { type, component }.
 *
 * A Plugin member that this widget-core module instance did not complete is rejected by
 * `inspectPlugin` with `WidgetInspectionError` code `foreign-plugin` (widget-core's documented
 * contract); the decoder rethrows it as `IncompatibleWidgetCoreError`, so the Adapter author is
 * told the Adapter bundles an incompatible widget-core copy.
 */
export const productAdapterRuntimeMemberDecoder = {
	decodePlugin(member: unknown): AnyWidgetPlugin {
		if (typeof member !== 'object' || member === null) {
			throw new Error('Widget plugin member must be an object.')
		}
		const candidate = member as AnyWidgetPlugin
		if (typeof candidate.type !== 'string' || candidate.type.length === 0) {
			throw new Error('Widget plugin member must declare a non-empty string type property.')
		}
		try {
			inspectPlugin(candidate)
		}
		catch (cause) {
			if (isForeignPluginInspectionError(cause))
				throw new IncompatibleWidgetCoreError(candidate.type, { cause })
			throw new Error(
				`Widget plugin member '${candidate.type}' failed plugin inspection: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			)
		}
		return candidate
	},

	decodeRenderer(member: unknown): DecodedRendererRegistration {
		if (typeof member !== 'object' || member === null) {
			throw new Error('Renderer registration member must be an object.')
		}
		const candidate = member as { type?: unknown; component?: unknown }
		if (typeof candidate.type !== 'string' || candidate.type.length === 0) {
			throw new Error('Renderer registration member must declare a non-empty string type property.')
		}
		if (candidate.component === undefined || candidate.component === null) {
			throw new Error(`Renderer registration member '${candidate.type}' is missing a component definition.`)
		}
		const comp = candidate.component
		const isComponentShape = typeof comp === 'function' || (typeof comp === 'object' && comp !== null)
		if (!isComponentShape) {
			throw new Error(`Renderer registration member '${candidate.type}' component must be a Vue component object or function.`)
		}
		return {
			type: candidate.type,
			component: comp as Component,
		}
	},
} satisfies AdapterRuntimeMemberDecoder

export const productAdapterRegistryInspector: AdapterRegistryInspector = {
	inspect(manifest: AdapterManifest): AdapterRegistryOwnership {
		const widgetTypes: string[] = []
		for (const [index, member] of manifest.widgetPlugins.entries()) {
			try {
				widgetTypes.push(readRegistryPluginType(member))
			}
			catch (cause) {
				throw new Error(`Widget plugin at index ${index} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
			}
		}

		const rendererKeys: string[] = []
		for (const [index, member] of manifest.renderers.entries()) {
			try {
				const renderer = productAdapterRuntimeMemberDecoder.decodeRenderer(member)
				rendererKeys.push(renderer.type)
			}
			catch (cause) {
				throw new Error(`Renderer registration at index ${index} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
			}
		}

		return {
			widgetTypes: Object.freeze(widgetTypes),
			rendererKeys: Object.freeze(rendererKeys),
		}
	},
}

/**
 * Registry discovery runs in the Nitro process, while Workspace adapters are loaded dynamically.
 * A production Nitro bundle may resolve @deviltea/widget-core from a different physical module URL
 * than the selected Workspace. widget-core documents that `inspectPlugin` and `createWidgetSystem`
 * accept only Plugins completed by the loaded module instance and reject any other with the coded
 * `foreign-plugin` error (`WidgetInspectionError` / `WidgetSystemConfigurationError`), so inspecting
 * here would refuse every Adapter whose widget-core copy differs from Nitro's.
 *
 * At this phase UIUX only needs the public semantic registry identity. Plugin authenticity is decided
 * by the one server-side check of the Preview bundle (`src/server/preview-adapter-check.ts`, Clause
 * 01a116f0-cae2-7c64-9c76-d472f252789a): the bundler aliases widget-core to the host's copy, and the
 * evaluated bundle runs productAdapterRuntimeMemberDecoder.decodePlugin with that copy, as the
 * Preview does in the browser.
 */
function readRegistryPluginType(member: unknown): string {
	if (typeof member !== 'object' || member === null)
		throw new Error('Widget plugin member must be an object.')
	const type = (member as { type?: unknown }).type
	if (typeof type !== 'string' || type.length === 0)
		throw new Error('Widget plugin member must declare a non-empty string type property.')
	return type
}


/**
 * Adapter API version 1: `1` or `1.<minor>`, where `<minor>` is `0` or a decimal integer without
 * leading zeros (Clause 01a115cd-d095-790b-bc0b-95297733fed4).
 */
const ADAPTER_API_VERSION_1 = /^1(?:\.(0|[1-9]\d*))?$/

/**
 * The highest minor of Adapter API version 1 this release implements: the host ceiling (Rule
 * 01a11a5a-4aa0-7537-bbfc-600ea0ea61c5). It is the highest minor of `ADAPTER_API_MEMBER_MINORS` and
 * moves only when a minor ships. The public authoring entry exports no value naming it (Discussion
 * #130 decision 7), so an Adapter writes the lowest minor it relies on, never the host's.
 */
export const ADAPTER_API_HOST_MINOR = 3

/**
 * The minor of Adapter API version 1 that introduced each member, in the order they shipped (Clause
 * 01a11a5a-41f3-7474-ba83-128fec22a1f7): the entries of `providers` `1.1`, `themeSupport` `1.2` and
 * `sources` `1.3`. Every other manifest member is part of `1.0`.
 */
export const ADAPTER_API_MEMBER_MINORS = Object.freeze({
	providers: 1,
	themeSupport: 2,
	sources: 3,
} as const)

/** The declared minor of a well-formed `apiVersion`, `1` being `1.0`; `undefined` outside the grammar. */
function declaredMinor(apiVersion: string): bigint | undefined {
	const match = ADAPTER_API_VERSION_1.exec(apiVersion)
	return match ? BigInt(match[1] ?? '0') : undefined
}

export const productAdapterApiCompatibility: AdapterApiCompatibilityPolicy = {
	// `test` is a non-normative test hook (owner ruling 2026-10-07), not an Adapter API version: it is
	// neither capped by the host ceiling nor bound to members.
	refusal(apiVersion: string) {
		if (apiVersion === 'test') return undefined
		const minor = declaredMinor(apiVersion)
		if (minor === undefined) return 'malformed'
		return minor > BigInt(ADAPTER_API_HOST_MINOR) ? 'newer_minor' : undefined
	},
	memberMinorViolations(manifest: AdapterManifest) {
		if (manifest.apiVersion === 'test') return []
		const declared = declaredMinor(manifest.apiVersion) ?? 0n
		const used: { member: string; minor: number }[] = []
		if (manifest.providers.length > 0) used.push({ member: 'providers', minor: ADAPTER_API_MEMBER_MINORS.providers })
		if (Object.hasOwn(manifest, 'themeSupport')) used.push({ member: 'themeSupport', minor: ADAPTER_API_MEMBER_MINORS.themeSupport })
		if (Object.hasOwn(manifest, 'sources')) used.push({ member: 'sources', minor: ADAPTER_API_MEMBER_MINORS.sources })
		return used.filter(item => BigInt(item.minor) > declared)
	},
}
