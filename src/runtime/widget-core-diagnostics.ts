import { createWidgetSystem, WidgetSystemConfigurationError, type AnyWidgetPlugin, type WidgetSystem } from '@deviltea/widget-core'
import { WidgetInspectionError } from '@deviltea/widget-core/inspection'

import type { Diagnostic } from '../domain/validation'

/**
 * widget-core documents coded errors for inputs it cannot accept: `createWidgetSystem` throws
 * `WidgetSystemConfigurationError` (`foreign-plugin`, `duplicate-plugin-type`) and the inspection
 * entries throw `WidgetInspectionError` (`foreign-plugin`, ...) when a Plugin was not completed by
 * the loaded module instance, whether it comes from another widget-core copy or is a structural
 * look-alike. Both are discriminated by class and `code`; their `message` is not protocol. This
 * module turns those codes into `adapter.*` diagnostics, so an Adapter that bundles its own
 * widget-core copy, or a duplicate Widget type that got past UIUX's own ownership checks, is
 * reported instead of thrown. UIUX's ownership and collision checks stay primary; these mappings
 * are the backstop.
 */

/**
 * Thrown by an Adapter runtime member decoder for a Widget plugin member that the widget-core copy
 * UIUX runs did not complete (inspection code `foreign-plugin`).
 */
export class IncompatibleWidgetCoreError extends Error {
	override readonly name = 'IncompatibleWidgetCoreError'

	constructor(readonly pluginType: string | null, options?: ErrorOptions) {
		super(incompatibleWidgetCoreMessage(pluginType), options)
	}
}

/** True for widget-core's documented inspection error for a Plugin from another module instance. */
export function isForeignPluginInspectionError(cause: unknown): cause is WidgetInspectionError {
	return cause instanceof WidgetInspectionError && cause.code === 'foreign-plugin'
}

/** The diagnostic for a decoder's `IncompatibleWidgetCoreError` at a `widgetPlugins` member path. */
export function incompatibleWidgetCoreDiagnostic(path: string, cause: IncompatibleWidgetCoreError): Diagnostic {
	return { code: 'adapter.runtime_widget_core_incompatible', path, message: cause.message }
}

export type AdapterWidgetSystemResult =
	| Readonly<{ state: 'ready'; system: WidgetSystem }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>

/**
 * Creates the Widget system for a materialized Adapter set. `pluginPaths[i]` is the JSON Pointer
 * reported for `plugins[i]`. widget-core's documented registration errors become diagnostics;
 * any other exception is not an Adapter problem and is rethrown.
 */
export function createAdapterWidgetSystem(plugins: readonly AnyWidgetPlugin[], pluginPaths: readonly string[]): AdapterWidgetSystemResult {
	try {
		return { state: 'ready', system: createWidgetSystem({ plugins }) }
	}
	catch (cause) {
		if (!(cause instanceof WidgetSystemConfigurationError)) throw cause
		const path = pluginPaths[cause.pluginIndex] ?? '/adapters'
		if (cause.code === 'foreign-plugin') {
			return { state: 'invalid', diagnostics: [{ code: 'adapter.runtime_widget_core_incompatible', path, message: incompatibleWidgetCoreMessage(cause.pluginType) }] }
		}
		if (cause.code === 'duplicate-plugin-type') {
			const first = cause.firstPluginIndex === null ? undefined : pluginPaths[cause.firstPluginIndex]
			return {
				state: 'invalid',
				diagnostics: [{
					code: 'adapter.runtime_plugin_collision',
					path,
					message: `Widget type ${cause.pluginType ?? '(unknown)'} is registered more than once${first ? `; it was first registered at ${first}` : ''}.`,
				}],
			}
		}
		throw cause
	}
}

function incompatibleWidgetCoreMessage(pluginType: string | null): string {
	const subject = pluginType ? `Widget plugin '${pluginType}'` : 'A Widget plugin'
	return `${subject} was not created by the @deviltea/widget-core copy UIUX runs: the Adapter bundles its own, incompatible widget-core copy, or the member is not a completed Widget plugin. Keep @deviltea/widget-core external to the Adapter build (a peer dependency).`
}
