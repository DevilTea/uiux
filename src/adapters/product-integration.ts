import type { AnyWidgetPlugin } from '@deviltea/widget-core'
import { inspectPlugin } from '@deviltea/widget-core/inspection'
import type { Component } from 'vue'

import { validateAdapterManifest, type AdapterManifest } from '../domain/adapters/schema'
import type { AdapterApiCompatibilityPolicy, AdapterRegistryInspector, AdapterRegistryOwnership } from './resolution'
import type { AdapterRuntimeMemberDecoder, DecodedRendererRegistration } from '../runtime/adapter-runtime'

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
 * than the selected Workspace. Widget's private Symbol brand intentionally cannot cross that boundary.
 *
 * At this phase UIUX only needs the public semantic registry identity. Full plugin authenticity and
 * capability inspection stays at runtime materialization, where the preview bundler aliases Widget
 * dependencies to one authoritative copy before productAdapterRuntimeMemberDecoder.inspectPlugin runs.
 */
function readRegistryPluginType(member: unknown): string {
	if (typeof member !== 'object' || member === null)
		throw new Error('Widget plugin member must be an object.')
	const type = (member as { type?: unknown }).type
	if (typeof type !== 'string' || type.length === 0)
		throw new Error('Widget plugin member must declare a non-empty string type property.')
	return type
}

export const productAdapterApiCompatibility: AdapterApiCompatibilityPolicy = {
	isCompatible(apiVersion: string): boolean {
		return apiVersion === '1' || apiVersion === 'test' || apiVersion.startsWith('1.')
	},
}
