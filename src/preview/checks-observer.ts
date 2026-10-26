import type { WidgetSystemRuntime } from '@deviltea/widget-core'
import { inspectRuntime, WidgetInspectionError, type RuntimePropertyInspection } from '@deviltea/widget-core/inspection'

import type { AdapterWidgetCatalogEntry } from '../domain/adapters/schema'
import { resolveI18nPropertyNames, validateTranslationResult } from '../domain/i18n/schema'
import type { ChecksTranslationWarning } from './protocol/checks-report'

/** A Property whose latest completed result failed. */
export type ObservedPropertyError = Readonly<{
	widgetId: string
	property: string
	/** The first diagnostic of the failure, as text. */
	detail: string
}>

/**
 * What the observer saw of one Runtime instance: the warnings of the translation-result Properties
 * it evaluated and the Properties whose evaluation failed. Never anything about a Property that was
 * not evaluated.
 */
export type ChecksObservation = Readonly<{
	/** Counts the Runtime instances attached and the observation resets: it never decreases. */
	context: number
	translationWarnings: readonly ChecksTranslationWarning[]
	propertyErrors: readonly ObservedPropertyError[]
}>

type Tracked = {
	readonly widgetId: string
	readonly property: string
	readonly translation: boolean
	readonly inspection: RuntimePropertyInspection<unknown>
	/** The result a reset found: a Property counts again only once it completes a newer one. */
	ignored?: unknown
}

/**
 * The runtime side of Checks' live Preview findings (issue #347; Rules
 * 01a115cd-b94f-7a87-830c-2060f2e63a2e and 01a115cd-b9be-7018-9247-003f129366f9). It reads only
 * widget-core's read-only Property inspection (`inspectRuntime(runtime).getWidget(nodeId).getProperty(name)`):
 * a Property that nothing evaluated reports `never-evaluated` and is skipped, and observing never
 * evaluates a Property, never invokes `t` and never changes what the Preview renders. Each recomputation
 * publishes a new completed result, which replaces the Property's warnings.
 *
 * - It reports nothing until `attach` is called for a mounted Runtime; attaching reads the results
 *   the first render already completed.
 * - `reset` (a Locale change inside the Runtime) forgets every result so far: a Property counts again
 *   only after it completes a new result, so warnings of the previous Locale never carry over.
 * - Observations are scheduled (a microtask), never produced inside an evaluation, and coalesced.
 */
export class RuntimeChecksObserver {
	private runtime?: WidgetSystemRuntime
	private tracked: Tracked[] = []
	private detachers: Array<() => void> = []
	private context = 0
	private disposed = false
	private scheduled = false

	constructor(
		private readonly catalogByType: ReadonlyMap<string, AdapterWidgetCatalogEntry>,
		private readonly onObservation: (observation: ChecksObservation) => void,
		private readonly schedule: (callback: () => void) => void = callback => queueMicrotask(callback),
	) {}

	/** Starts observing a Runtime that has finished mounting. */
	attach(runtime: WidgetSystemRuntime): void {
		this.unsubscribeAll()
		this.runtime = runtime
		this.tracked = []
		this.context++
		if (this.disposed || runtime.isDisposed) return
		let inspection: ReturnType<typeof inspectRuntime>
		try {
			inspection = inspectRuntime(runtime)
		}
		catch (cause) {
			// A Runtime this widget-core module instance did not create (`foreign-runtime`) cannot be
			// observed, so nothing reports. Any other exception is a defect and propagates.
			if (!(cause instanceof WidgetInspectionError)) throw cause
			this.requestObservation()
			return
		}
		for (const node of inspection.blueprint.nodes) {
			if (!node.resolved) continue
			const widgetId = node.node.id
			const fields = this.catalogByType.get(node.node.type)?.i18n?.fields
			const translationProperties = new Set(Object.entries(fields ?? {}).map(([field, mapping]) => resolveI18nPropertyNames(field, mapping).resultProperty))
			const widget = inspection.getWidget(node.nodeId)
			for (const member of node.properties) {
				const observable = widget?.getProperty(member.name)
				if (!observable) continue
				const entry: Tracked = { widgetId, property: member.name, translation: translationProperties.has(member.name), inspection: observable }
				this.tracked.push(entry)
				this.detachers.push(observable.subscribe(() => this.requestObservation()))
			}
		}
		this.requestObservation()
	}

	/** Stops observing the current Runtime, before it is replaced or disposed. */
	detach(): void {
		this.unsubscribeAll()
		this.runtime = undefined
		this.tracked = []
	}

	/** The Locale of the attached Runtime changed: nothing evaluated so far counts any more. */
	reset(): void {
		for (const entry of this.tracked) {
			const snapshot = entry.inspection.getSnapshot()
			entry.ignored = snapshot.status === 'completed' ? snapshot.result : undefined
		}
		this.context++
		this.requestObservation()
	}

	dispose(): void {
		this.disposed = true
		this.detach()
	}

	/** The observation right now, synchronously. */
	observe(): ChecksObservation {
		const translationWarnings: ChecksTranslationWarning[] = []
		const propertyErrors: ObservedPropertyError[] = []
		for (const entry of this.tracked) {
			const snapshot = entry.inspection.getSnapshot()
			if (snapshot.status !== 'completed' || snapshot.result === entry.ignored) continue
			const result = snapshot.result
			if (!result.ok) {
				const first = result.failure.diagnostics[0]
				const message = typeof first?.message === 'string' ? first.message : undefined
				propertyErrors.push({ widgetId: entry.widgetId, property: entry.property, detail: message ?? `The Property failed (${first?.code ?? 'unknown'}).` })
				continue
			}
			if (!entry.translation) continue
			const validation = validateTranslationResult(result.value)
			if (!validation.ok) {
				// A translation-result Property that evaluated to anything else cannot have its warnings read.
				propertyErrors.push({ widgetId: entry.widgetId, property: entry.property, detail: 'The result is not a { text, warnings } translation result.' })
				continue
			}
			for (const warning of validation.value.warnings)
				translationWarnings.push({ widgetId: entry.widgetId, resultProperty: entry.property, warning: { ...warning } })
		}
		return Object.freeze({ context: this.context, translationWarnings, propertyErrors })
	}

	private requestObservation(): void {
		if (this.scheduled || this.disposed) return
		this.scheduled = true
		this.schedule(() => {
			this.scheduled = false
			// Nothing is observed while no Runtime is attached (between a swap's detach and attach).
			if (this.disposed || !this.runtime) return
			try {
				this.onObservation(this.observe())
			}
			catch {
				// A failing consumer never reaches the evaluation that published the result.
			}
		})
	}

	private unsubscribeAll(): void {
		const detachers = this.detachers
		this.detachers = []
		for (const detach of detachers) {
			try {
				detach()
			}
			catch {
				// Unsubscribing a disposed Runtime's observation is a no-op.
			}
		}
	}
}
