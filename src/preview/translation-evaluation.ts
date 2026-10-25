import type { WidgetSystemRuntime } from '@deviltea/widget-core'

import type { AdapterWidgetCatalogEntry } from '../domain/adapters/schema'
import type { TranslationEvidenceOccurrence, TranslationMissingOccurrence } from '../domain/evidence/schema'
import { resolveI18nPropertyNames, validateTranslationResult, type I18nOccurrenceLocator } from '../domain/i18n/schema'
import type { ViewResource } from '../domain/views/schema'
import { deriveWidgetTree, flattenWidgetTree } from './widget-tree'

/**
 * The outcome of evaluating every Catalog-declared translation-result Property of one View and
 * Variant (Rule 01a115cd-ba68-7c73-a157-08ef34be1e54): the Properties that produced a
 * `{ text, warnings }` result, and those that could not be evaluated (Clause
 * 01a17245-06ad-70f3-88ac-9b44e9c7ba0d). Both lists are in the order of Clause
 * 01a115cd-cfb1-7b51-8730-6418d218eb51 and plain JSON, so they cross the page boundary unchanged.
 */
export type TranslationEvaluation = Readonly<{
	entries: readonly TranslationEvidenceOccurrence[]
	missing: readonly TranslationMissingOccurrence[]
}>

/** The longest `reason` kept for a Property that could not be evaluated. */
const MAX_REASON_LENGTH = 200

/**
 * Evaluates, through the public Runtime API only, the result Property of every Catalog `i18n.fields`
 * mapping of every Widget of `view`, hidden or never rendered Widgets included: a Property's `get()`
 * computes it whether or not anything shows it. Reading is side-effect free (Rule
 * 01a115cd-b610-78ca-8e24-8448d3a350ac), so evaluating changes nothing the Preview renders.
 *
 * Widgets are visited depth first in the View's IR order (`deriveWidgetTree`), a Widget's mappings in
 * result Property name order. A Widget or Property absent at runtime, a Property whose evaluation
 * fails or throws, and a result that is not a `TranslationResult` are listed as missing, each with a
 * short reason; nothing in `entries` stands in for them.
 */
export function evaluateTranslationProperties(input: Readonly<{
	view: ViewResource
	runtime: WidgetSystemRuntime
	catalogByType: ReadonlyMap<string, AdapterWidgetCatalogEntry>
	variantName?: string
}>): TranslationEvaluation {
	const tree = deriveWidgetTree(input.view.ir)
	if (tree.status !== 'valid') throw new Error(`The View's widget tree cannot be traversed: ${tree.reason}`)
	const entries: TranslationEvidenceOccurrence[] = []
	const missing: TranslationMissingOccurrence[] = []
	for (const node of flattenWidgetTree(tree.root)) {
		const fields = input.catalogByType.get(node.type)?.i18n?.fields
		if (!fields) continue
		const declared = Object.entries(fields)
			.map(([catalogField, mapping]) => ({ catalogField, resultProperty: resolveI18nPropertyNames(catalogField, mapping).resultProperty }))
			.sort((a, b) => compareCodeUnits(a.resultProperty, b.resultProperty) || compareCodeUnits(a.catalogField, b.catalogField))
		for (const { catalogField, resultProperty } of declared) {
			const occurrence: I18nOccurrenceLocator = {
				viewId: input.view.id,
				...(input.variantName !== undefined ? { variantName: input.variantName } : {}),
				widgetId: node.id,
				resultProperty,
				catalogField,
			}
			const outcome = evaluateOne(input.runtime, node.id, resultProperty)
			if (outcome.state === 'evaluated') entries.push({ occurrence, evaluatedText: outcome.text, warnings: outcome.warnings })
			else missing.push({ ...occurrence, reason: outcome.reason })
		}
	}
	return { entries, missing }
}

type Outcome =
	| Readonly<{ state: 'evaluated'; text: string; warnings: TranslationEvidenceOccurrence['warnings'] }>
	| Readonly<{ state: 'missing'; reason: string }>

interface PropertyReader { get: () => { ok: true; value: unknown } | { ok: false; failure?: { diagnostics?: ReadonlyArray<{ message?: unknown }> } } }

function evaluateOne(runtime: WidgetSystemRuntime, widgetId: string, resultProperty: string): Outcome {
	let property: PropertyReader | undefined
	try {
		const widget = runtime.getWidget(widgetId) as unknown as { properties?: Record<string, PropertyReader | undefined> } | null
		if (!widget) return { state: 'missing', reason: 'The Widget is absent at runtime.' }
		property = widget.properties && Object.hasOwn(widget.properties, resultProperty) ? widget.properties[resultProperty] : undefined
	}
	catch (cause) {
		return { state: 'missing', reason: shortReason(`The Widget could not be read: ${describe(cause)}`) }
	}
	if (!property || typeof property.get !== 'function') return { state: 'missing', reason: 'The result Property is absent at runtime.' }
	let result: ReturnType<PropertyReader['get']>
	try {
		result = property.get()
	}
	catch (cause) {
		return { state: 'missing', reason: shortReason(`The evaluation threw: ${describe(cause)}`) }
	}
	if (!result.ok) {
		const message = result.failure?.diagnostics?.find(diagnostic => typeof diagnostic.message === 'string')?.message
		return { state: 'missing', reason: shortReason(`The evaluation failed${typeof message === 'string' ? `: ${message}` : '.'}`) }
	}
	const validation = validateTranslationResult(result.value)
	if (!validation.ok) return { state: 'missing', reason: 'The result is not a { text, warnings } translation result.' }
	// Plain copies, so what leaves the Runtime is data that no Adapter object can change afterwards.
	return { state: 'evaluated', text: validation.value.text, warnings: validation.value.warnings.map(warning => ({ ...warning })) }
}

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause)
}

function shortReason(reason: string): string {
	return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason
}

function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}
