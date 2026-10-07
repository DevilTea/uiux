import type { WidgetSystemRuntime } from '@deviltea/widget-core'
import { inspectRuntime, WidgetInspectionError } from '@deviltea/widget-core/inspection'

import type { WidgetEventTrigger } from './protocol/widget-events'

/** What the observer reports: the arm, the Widget and the declared Event name. Nothing else. */
export type WidgetEventReport = Readonly<{ armId: string; widgetId: string; event: string }>

type Arm = { readonly armId: string; readonly triggers: readonly WidgetEventTrigger[]; spent: boolean }

/**
 * The runtime side of Widget Event reporting (Part 2 decision group "Widget Event reporting",
 * decision 4). It observes only the armed `{ widgetId, event }` pairs, through widget-core's
 * read-only inspection surface (`inspectRuntime(runtime).getWidget(nodeId).getEvent(name)`),
 * never the public `events[name].subscribe` and never DOM events.
 *
 * widget-core documents that surface (`@deviltea/widget-core/inspection`) as a supported
 * read-only host surface, and documents for Event inspection that it grants no emit authority and
 * never changes emission, public listener membership or order, or any exception the emitter
 * sees; that a throwing inspection listener is isolated from the emitter and every other
 * listener; that only future occurrences are delivered; and that a listener should defer work
 * that writes State or invokes Methods, for example to a microtask. The observer relies on those
 * guarantees rather than guarding the emitter itself.
 *
 * - The listener takes no parameters: the argument tuple is never read, copied or retained.
 * - Each arm yields at most one report (one-shot); the arm is then spent until a new one arrives.
 * - It reports nothing until `attach` is called for a mounted Runtime, so emissions during
 *   creation or mount never count, while timer and async emissions after mount do.
 * - Swapping the Runtime instance (`detach` then `attach`) keeps the arm and its spent state.
 * - Reports are scheduled (a microtask), never sent inside the emitter, and keep emission order.
 */
export class WidgetEventObserver {
	private arm?: Arm
	private runtime?: WidgetSystemRuntime
	private detachers: Array<() => void> = []
	private disposed = false

	constructor(
		private readonly report: (report: WidgetEventReport) => void,
		private readonly schedule: (callback: () => void) => void = callback => queueMicrotask(callback),
	) {}

	/** Applies an arm: it replaces the previous one entirely; no triggers disarms. */
	setArm(armId: string, triggers: readonly WidgetEventTrigger[]): void {
		this.arm = triggers.length
			? { armId, triggers: Object.freeze(triggers.map(trigger => Object.freeze({ widgetId: trigger.widgetId, event: trigger.event }))), spent: false }
			: undefined
		this.resubscribe()
	}

	/** A View or Variant change inside a generation clears the arm (decision 3). */
	clearArm(): void {
		this.arm = undefined
		this.resubscribe()
	}

	/** Starts observing a Runtime that has finished mounting. */
	attach(runtime: WidgetSystemRuntime): void {
		this.runtime = runtime
		this.resubscribe()
	}

	/** Stops observing the current Runtime, before it is replaced or disposed. */
	detach(): void {
		this.runtime = undefined
		this.resubscribe()
	}

	dispose(): void {
		this.disposed = true
		this.arm = undefined
		this.runtime = undefined
		this.unsubscribeAll()
	}

	/** Test and diagnostics view: the current arm identity and whether it is spent. */
	snapshot(): Readonly<{ armId?: string; spent: boolean; observing: number }> {
		return Object.freeze({ ...(this.arm ? { armId: this.arm.armId } : {}), spent: this.arm?.spent ?? false, observing: this.detachers.length })
	}

	private resubscribe(): void {
		this.unsubscribeAll()
		const runtime = this.runtime
		const arm = this.arm
		if (this.disposed || !runtime || runtime.isDisposed || !arm || arm.spent) return
		let inspection: ReturnType<typeof inspectRuntime>
		try {
			inspection = inspectRuntime(runtime)
		}
		catch (cause) {
			// A Runtime this widget-core module instance did not create (`foreign-runtime`) cannot be
			// observed, so nothing reports. Any other exception is a defect and propagates.
			if (!(cause instanceof WidgetInspectionError)) throw cause
			return
		}
		for (const trigger of arm.triggers) {
			// Unknown pairs (a missing Widget, or an Event it does not declare) are skipped silently.
			const node = inspection.blueprint.nodes.find(candidate => candidate.resolved && candidate.node.id === trigger.widgetId)
			if (!node?.resolved || !node.events.some(member => member.name === trigger.event)) continue
			const observable = inspection.getWidget(node.nodeId)?.getEvent(trigger.event)
			if (!observable) continue
			const { widgetId, event } = trigger
			// The listener deliberately declares no parameters: the argument tuple is never read.
			this.detachers.push(observable.subscribe(() => this.observe(arm, widgetId, event)))
		}
	}

	private observe(arm: Arm, widgetId: string, event: string): void {
		if (this.disposed || this.arm !== arm || arm.spent) return
		arm.spent = true
		this.schedule(() => {
			// The arm is spent: stop observing outside the emitter, then report unless disposed.
			if (this.arm === arm) this.unsubscribeAll()
			if (this.disposed) return
			try {
				this.report(Object.freeze({ armId: arm.armId, widgetId, event }))
			}
			catch {
				// A failing reporter never reaches the emitting plugin.
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
