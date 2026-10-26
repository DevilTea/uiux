import { createWidgetPlugin, createWidgetSystem, type RuntimeEvent, type RuntimeMethod, type WidgetSystemRuntime } from '@deviltea/widget-core'
import { describe, expect, it } from 'vitest'

import { widgetEventHolds, type ObservedWidgetEvent } from '../src/domain/evidence/interaction-replay'
import { InteractionProbe, MAX_PROBED_EVENTS } from '../src/preview/interaction-probe'

/**
 * The harness's interaction probe (Rule 01a11544-66d9-7fcd-8400-93516ddf2857, Clause
 * 01a17762-b631-7681-965d-80e97eb92809) against a real widget-core Runtime, and how a `widgetEvent`
 * expectation reads what it observed.
 */

interface Interfaces {
	state: { value: string }
	methods: { emitWith: (value: unknown) => null }
	events: { changed: readonly [unknown]; poked: readonly [] }
}

const plugin = createWidgetPlugin('Probe')
	.description('Interaction probe fixture')
	.interfaces<Interfaces>()
	.state(state => state.value({ authorWritable: true, validate: (v): v is string => typeof v === 'string', default: () => 'initial' }))
	.methods(methods => methods.emitWith({ validateArgs: (args): args is [unknown] => args.length === 1, execute: ({ args, emit }) => { emit.changed(args[0]); return null } }))
	.events(events => events.changed({ description: 'Changed' }).poked({ description: 'Poked' }))
	.done()

type Widget = { methods: { emitWith: RuntimeMethod<(value: unknown) => null> }; events: { changed: RuntimeEvent<readonly [unknown]> } }

function runtime(): { runtime: WidgetSystemRuntime; widget: Widget } {
	const system = createWidgetSystem({ plugins: [plugin] })
	const blueprint = system.createBlueprint({ id: 'a', type: 'Probe' })
	if (blueprint.status !== 'valid') throw new Error('fixture blueprint invalid')
	const created = blueprint.createRuntime()
	return { runtime: created, widget: created.getWidget('a') as unknown as Widget }
}

describe('InteractionProbe', () => {
	it('records the declared Events it watches, in order, with JSON arguments, and reads State', () => {
		const { runtime: current, widget } = runtime()
		const probe = new InteractionProbe(() => current)
		expect(probe.watch('a', 'changed')).toBe(true)
		// An Event the Widget does not declare, and a Widget the Runtime does not have, cannot be watched.
		expect(probe.watch('a', 'missing')).toBe(false)
		expect(probe.watch('ghost', 'changed')).toBe(false)
		widget.methods.emitWith({ x: 1 })
		widget.methods.emitWith('two')
		expect(probe.occurrences()).toEqual([{ widgetId: 'a', name: 'changed', args: [{ x: 1 }] }, { widgetId: 'a', name: 'changed', args: ['two'] }])
		expect(probe.readState('a', 'value')).toEqual({ found: true, value: 'initial' })
		expect(probe.readState('a', 'nope')).toEqual({ found: false })
		expect(probe.readState('ghost', 'value')).toEqual({ found: false })
		// Watching the same pair again does not record twice.
		expect(probe.watch('a', 'changed')).toBe(true)
		widget.methods.emitWith(3)
		expect(probe.occurrences()).toHaveLength(3)
		probe.dispose()
		widget.methods.emitWith(4)
		expect(probe.occurrences()).toHaveLength(3)
	})

	it('reads arguments that are not JSON as null, and a DOM event object as what JSON makes of it', () => {
		const { runtime: current, widget } = runtime()
		const probe = new InteractionProbe(() => current)
		probe.watch('a', 'changed')
		widget.methods.emitWith(() => 'function')
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		widget.methods.emitWith(cycle)
		widget.methods.emitWith(undefined)
		widget.methods.emitWith({ type: 'click', target: { toJSON() { throw new Error('no') } } })
		expect(probe.occurrences().map(occurrence => occurrence.args)).toEqual([[null], [null], [null], [null]])
	})

	it('keeps at most MAX_PROBED_EVENTS occurrences', () => {
		const { runtime: current, widget } = runtime()
		const probe = new InteractionProbe(() => current)
		probe.watch('a', 'changed')
		for (let index = 0; index < MAX_PROBED_EVENTS + 50; index++) widget.methods.emitWith(index)
		const kept = probe.occurrences()
		expect(kept).toHaveLength(MAX_PROBED_EVENTS)
		expect(kept.at(-1)!.args).toEqual([MAX_PROBED_EVENTS - 1])
	})

	it('observes nothing of a Runtime it cannot inspect, or that is disposed or absent', () => {
		const foreign = { isDisposed: false } as unknown as WidgetSystemRuntime
		const probe = new InteractionProbe(() => foreign)
		expect(probe.watch('a', 'changed')).toBe(false)
		expect(probe.readState('a', 'value')).toEqual({ found: false })
		expect(new InteractionProbe(() => undefined).watch('a', 'changed')).toBe(false)
		const { runtime: current } = runtime()
		current.dispose()
		expect(new InteractionProbe(() => current).watch('a', 'changed')).toBe(false)
	})
})

describe('widgetEvent expectations (owner ruling 1 of the #89 follow-up)', () => {
	const event = (args: ObservedWidgetEvent['args'], widgetId = 'a', name = 'changed'): ObservedWidgetEvent => ({ widgetId, name, args })
	const seen = [event([1]), event([2]), event([1]), event([], 'b'), event([1], 'a', 'other')]

	it('passes when any occurrence of the Event has equal arguments, whatever the others hold', () => {
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed' }, seen)).toBe(true)
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed', payload: [2] }, seen)).toBe(true)
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed', payload: [3] }, seen)).toBe(false)
		expect(widgetEventHolds({ widgetId: 'b', name: 'changed', payload: [1] }, seen)).toBe(false)
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed' }, [])).toBe(false)
		// Object member order does not matter.
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed', payload: [{ x: 1, y: 2 }] }, [event([{ y: 2, x: 1 }])])).toBe(true)
	})

	it('requires exactly count matching occurrences when count is given', () => {
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed', count: 3 }, seen)).toBe(true)
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed', count: 1 }, seen)).toBe(false)
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed', payload: [1], count: 2 }, seen)).toBe(true)
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed', payload: [2], count: 1 }, seen)).toBe(true)
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed', payload: [1], count: 1 }, seen)).toBe(false)
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed', count: 0 }, [])).toBe(true)
		expect(widgetEventHolds({ widgetId: 'a', name: 'changed', count: 0 }, seen)).toBe(false)
	})
})
