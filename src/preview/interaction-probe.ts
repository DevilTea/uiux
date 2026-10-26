import type { WidgetSystemRuntime } from '@deviltea/widget-core'
import { inspectRuntime, WidgetInspectionError } from '@deviltea/widget-core/inspection'

import { isJsonValue, type JsonValue } from '../domain/validation'

/** One observed Widget Event: the Widget, the declared Event name and its arguments as JSON. */
export type ProbedWidgetEvent = Readonly<{ widgetId: string; name: string; args: readonly JsonValue[] }>

/** What `readState` found: `found` is false for a Widget or State member the Runtime does not have. */
export type ProbedState = Readonly<{ found: false }> | Readonly<{ found: true; value: JsonValue | null }>

/** The most occurrences one probe keeps; a replay asserts a handful, so more is a runaway emitter. */
export const MAX_PROBED_EVENTS = 1000

/**
 * The capture harness's observation of a mounted Runtime for interaction replay (Rule
 * 01a11544-66d9-7fcd-8400-93516ddf2857): the declared Widget Events a replay's browser actions cause
 * and the State a Widget holds afterwards. It reads only through widget-core's read-only inspection
 * surface, like `WidgetEventObserver`, and never writes State, invokes a Method or emits.
 *
 * Unlike the Workbench's Widget Event reporting, which never reads an Event argument, a probe keeps
 * each occurrence's arguments (as a JSON copy; an argument that is not JSON is recorded as `null`),
 * because an assertion may compare them. It exists only in the formal capture harness
 * (`?harness=formal`) and its observations never leave the page except through the harness hooks.
 *
 * A probe watches the Runtime that is mounted when `watch` is called; the harness Preview mounts one
 * Runtime and does not replace it while a replay runs.
 */
export class InteractionProbe {
	private readonly events: ProbedWidgetEvent[] = []
	private readonly watched = new Set<string>()
	private readonly detachers: Array<() => void> = []

	constructor(private readonly runtime: () => WidgetSystemRuntime | undefined) {}

	/** Starts observing the Event `name` of the Widget `widgetId`; false when the Runtime has no such Event. */
	watch(widgetId: string, name: string): boolean {
		const key = JSON.stringify([widgetId, name])
		if (this.watched.has(key)) return true
		const inspection = this.inspect()
		if (!inspection) return false
		const node = inspection.blueprint.nodes.find(candidate => candidate.resolved && candidate.node.id === widgetId)
		if (!node?.resolved || !node.events.some(member => member.name === name)) return false
		const observable = inspection.getWidget(node.nodeId)?.getEvent(name)
		if (!observable) return false
		this.watched.add(key)
		this.detachers.push(observable.subscribe((args) => {
			if (this.events.length >= MAX_PROBED_EVENTS) return
			this.events.push(Object.freeze({ widgetId, name, args: Object.freeze(args.map(toJson)) }))
		}))
		return true
	}

	/** The occurrences observed since the first `watch`, in emission order. */
	occurrences(): readonly ProbedWidgetEvent[] {
		return [...this.events]
	}

	/** The current value of a Widget's State member, as JSON. */
	readState(widgetId: string, key: string): ProbedState {
		const inspection = this.inspect()
		const node = inspection?.blueprint.nodes.find(candidate => candidate.resolved && candidate.node.id === widgetId)
		if (!inspection || !node?.resolved) return { found: false }
		const state = inspection.getWidget(node.nodeId)?.getState(key)
		if (!state) return { found: false }
		return { found: true, value: toJson(state.getSnapshot().value) }
	}

	dispose(): void {
		for (const detach of this.detachers.splice(0)) {
			try { detach() }
			catch { /* Unsubscribing a disposed Runtime's observation is a no-op. */ }
		}
		this.watched.clear()
	}

	private inspect(): ReturnType<typeof inspectRuntime> | undefined {
		const runtime = this.runtime()
		if (!runtime || runtime.isDisposed) return undefined
		try {
			return inspectRuntime(runtime)
		}
		catch (cause) {
			// A Runtime this widget-core module instance did not create (`foreign-runtime`) cannot be observed.
			if (!(cause instanceof WidgetInspectionError)) throw cause
			return undefined
		}
	}
}

/** A JSON copy of `value`, or `null` for what is not JSON (a function, a cycle, a class instance). */
function toJson(value: unknown): JsonValue {
	if (value === undefined) return null
	try {
		const copy: unknown = JSON.parse(JSON.stringify(value) ?? 'null')
		return isJsonValue(copy) ? copy : null
	}
	catch {
		return null
	}
}
