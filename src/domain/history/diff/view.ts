import type { JsonValue } from '../../validation'
import {
	asRecord,
	asString,
	diffJson,
	diffJsonExcept,
	diffListItems,
	jsonEqual,
	unionKeys,
	valueChange,
	type JsonPointerChange,
	type ListItemChanges,
	type Side,
	type ValueChange,
} from './json-pointer'

/**
 * The semantic diff of a View (Rules 01a11a5e-0e37-754b-bea2-a15716749c0c,
 * 01a11a5e-0e8d-7d8a-84f1-3195ac7719e7, 01a11a5e-0edf-7ea0-8d15-cc2a028d2a14 and
 * 01a11a5e-0f31-7635-aeb2-16a1e9673b20). Field names beyond the Rules are implementation-defined.
 *
 * - Widgets are matched by their stable `id`. A Widget is `moved` when its parent or Slot changed,
 *   or when its order among the siblings it kept changed (siblings that only shifted because
 *   another Widget was added or removed beside them are not moved).
 * - `configChanged` lists JSON pointers relative to the Widget, without `id`, `type` and `slots`
 *   (so `/config/label`); bindings stay references.
 * - When the IR cannot be matched by id (a Widget without a string id, or one id used twice) the
 *   Widget diff is replaced by the structural diff of `ir` in `irChanges`.
 * - Every pointer list is relative to the object it is reported on: the Widget, the State
 *   override, the Variant, the Decision, the Spec or the View.
 */
export type WidgetPosition = Readonly<{ parent: string; slot: string; index: number }>

export type WidgetSummary = Readonly<{ id: string; type?: string; position?: WidgetPosition }>

export type ViewWidgetChanges = Readonly<{
	added: readonly WidgetSummary[]
	removed: readonly WidgetSummary[]
	moved: readonly Readonly<{ id: string; type?: string; before?: WidgetPosition; after?: WidgetPosition }>[]
	typeChanged: readonly Readonly<{ id: string; before?: string; after?: string }>[]
	configChanged: readonly Readonly<{ id: string; type?: string; changes: readonly JsonPointerChange[] }>[]
}>

export type ViewVariantChanges = Readonly<{
	added: readonly string[]
	removed: readonly string[]
	/** Per-Widget State override changes, pointers relative to the override object. */
	stateChanged: readonly Readonly<{ variant: string; widgetId: string; changes: readonly JsonPointerChange[] }>[]
	/** Changes of a Variant's members other than `state`. */
	otherChanged: readonly Readonly<{ variant: string; changes: readonly JsonPointerChange[] }>[]
}>

export type DecisionSummary = Readonly<{ id: string; question?: string; status?: string }>

export type ViewDecisionChanges = Readonly<{
	added: readonly DecisionSummary[]
	removed: readonly DecisionSummary[]
	changed: readonly Readonly<{
		id: string
		question?: ValueChange
		status?: ValueChange
		outcome?: ValueChange
		/** Other members (history, provenance), structurally. */
		otherChanges?: readonly JsonPointerChange[]
	}>[]
}>

export const VIEW_SPEC_LIST_SECTIONS = Object.freeze(['entryConditions', 'interactionRules', 'constraints', 'accessibility', 'references'] as const)
export type ViewSpecListSection = typeof VIEW_SPEC_LIST_SECTIONS[number]

export type ViewSpecChanges = Readonly<{
	intent?: ValueChange
	sections: readonly (Readonly<{ section: ViewSpecListSection }> & ListItemChanges<JsonValue>)[]
	decisions: ViewDecisionChanges
	/** Spec members outside the known sections, structurally. */
	otherChanges?: readonly JsonPointerChange[]
}>

export type ViewDiff = Readonly<{
	type: 'view'
	name?: ValueChange
	feature?: ValueChange
	widgets?: ViewWidgetChanges
	irChanges?: readonly JsonPointerChange[]
	variants: ViewVariantChanges
	spec: ViewSpecChanges
	/** View members outside `name`, `feature`, `ir`, `variants` and `spec`, structurally. */
	otherChanges?: readonly JsonPointerChange[]
}>

const VIEW_MEMBERS = ['name', 'feature', 'ir', 'variants', 'spec'] as const

export function diffView(before: Side, after: Side): ViewDiff {
	const left = asRecord(before) ?? {}
	const right = asRecord(after) ?? {}
	const name = valueChange(left.name, right.name)
	const feature = valueChange(left.feature, right.feature)
	const beforeWidgets = collectWidgets(left.ir)
	const afterWidgets = collectWidgets(right.ir)
	const widgetChanges = beforeWidgets && afterWidgets ? diffWidgets(beforeWidgets, afterWidgets) : undefined
	const other = diffJsonExcept(left, right, VIEW_MEMBERS)
	return {
		type: 'view',
		...(name ? { name } : {}),
		...(feature ? { feature } : {}),
		...(widgetChanges ? { widgets: widgetChanges } : { irChanges: diffJson(left.ir, right.ir) }),
		variants: diffVariants(left.variants, right.variants),
		spec: diffSpec(left.spec, right.spec),
		...(other.length > 0 ? { otherChanges: other } : {}),
	}
}

type WidgetEntry = Readonly<{ id: string; type?: string; position?: WidgetPosition; node: Readonly<Record<string, JsonValue>> }>

/** Every Widget of an IR by id, in document order, or `undefined` when the IR cannot be matched by id. */
function collectWidgets(ir: Side): Map<string, WidgetEntry> | undefined {
	const widgets = new Map<string, WidgetEntry>()
	if (ir === undefined) return widgets
	let matchable = true
	const visit = (value: JsonValue, position: WidgetPosition | undefined): void => {
		const node = asRecord(value)
		const id = asString(node?.id)
		if (!node || id === undefined || widgets.has(id)) {
			matchable = false
			return
		}
		const type = asString(node.type)
		widgets.set(id, { id, ...(type === undefined ? {} : { type }), ...(position ? { position } : {}), node })
		const slots = asRecord(node.slots)
		if (!slots) return
		for (const slot of Object.keys(slots)) {
			const children = slots[slot]
			if (!Array.isArray(children)) {
				matchable = false
				continue
			}
			children.forEach((child, index) => visit(child, { parent: id, slot, index }))
		}
	}
	visit(ir, undefined)
	return matchable ? widgets : undefined
}

function diffWidgets(before: Map<string, WidgetEntry>, after: Map<string, WidgetEntry>): ViewWidgetChanges {
	const added: WidgetSummary[] = []
	const removed: WidgetSummary[] = []
	const moved: { id: string; type?: string; before?: WidgetPosition; after?: WidgetPosition }[] = []
	const typeChanged: { id: string; before?: string; after?: string }[] = []
	const configChanged: { id: string; type?: string; changes: JsonPointerChange[] }[] = []
	for (const entry of before.values()) if (!after.has(entry.id)) removed.push(summary(entry))
	for (const entry of after.values()) if (!before.has(entry.id)) added.push(summary(entry))
	const reordered = reorderedWidgets(before, after)
	for (const now of after.values()) {
		const was = before.get(now.id)
		if (!was) continue
		const relocated = was.position?.parent !== now.position?.parent || was.position?.slot !== now.position?.slot
		if (relocated || reordered.has(now.id))
			moved.push({ id: now.id, ...(now.type === undefined ? {} : { type: now.type }), ...(was.position ? { before: was.position } : {}), ...(now.position ? { after: now.position } : {}) })
		if (was.type !== now.type)
			typeChanged.push({ id: now.id, ...(was.type === undefined ? {} : { before: was.type }), ...(now.type === undefined ? {} : { after: now.type }) })
		const changes = diffJsonExcept(was.node, now.node, ['id', 'type', 'slots'])
		if (changes.length > 0) configChanged.push({ id: now.id, ...(now.type === undefined ? {} : { type: now.type }), changes })
	}
	return { added, removed, moved, typeChanged, configChanged }
}

function summary(entry: WidgetEntry): WidgetSummary {
	return { id: entry.id, ...(entry.type === undefined ? {} : { type: entry.type }), ...(entry.position ? { position: entry.position } : {}) }
}

/**
 * Widgets that stayed in the same parent and Slot but changed order relative to the siblings that
 * also stayed: per Slot, the kept siblings outside a longest common subsequence of the two orders.
 */
function reorderedWidgets(before: Map<string, WidgetEntry>, after: Map<string, WidgetEntry>): Set<string> {
	const slotOf = (entry: WidgetEntry) => entry.position ? `${entry.position.parent}\0${entry.position.slot}` : undefined
	const groups = new Map<string, { before: string[]; after: string[] }>()
	const stays = (id: string) => {
		const was = before.get(id)
		const now = after.get(id)
		return was !== undefined && now !== undefined && slotOf(was) !== undefined && slotOf(was) === slotOf(now)
	}
	for (const [side, widgets] of [['before', before], ['after', after]] as const) {
		for (const entry of widgets.values()) {
			const slot = slotOf(entry)
			if (slot === undefined || !stays(entry.id)) continue
			const group = groups.get(slot) ?? { before: [], after: [] }
			group[side].push(entry.id)
			groups.set(slot, group)
		}
	}
	const reordered = new Set<string>()
	for (const group of groups.values()) {
		const order = (ids: string[], side: Map<string, WidgetEntry>) => ids.sort((left, right) => side.get(left)!.position!.index - side.get(right)!.position!.index)
		const kept = longestCommonSubsequence(order(group.before, before), order(group.after, after))
		for (const id of group.after) if (!kept.has(id)) reordered.add(id)
	}
	return reordered
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): Set<string> {
	const table: number[][] = Array.from({ length: left.length + 1 }, () => Array.from({ length: right.length + 1 }, () => 0))
	for (let i = left.length - 1; i >= 0; i--)
		for (let j = right.length - 1; j >= 0; j--)
			table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
	const kept = new Set<string>()
	let i = 0
	let j = 0
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			kept.add(left[i]!)
			i++
			j++
		}
		else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++
		else j++
	}
	return kept
}

function diffVariants(before: Side, after: Side): ViewVariantChanges {
	const left = asRecord(before) ?? {}
	const right = asRecord(after) ?? {}
	const added: string[] = []
	const removed: string[] = []
	const stateChanged: { variant: string; widgetId: string; changes: JsonPointerChange[] }[] = []
	const otherChanged: { variant: string; changes: JsonPointerChange[] }[] = []
	for (const variant of unionKeys(left, right)) {
		if (!Object.hasOwn(left, variant)) {
			added.push(variant)
			continue
		}
		if (!Object.hasOwn(right, variant)) {
			removed.push(variant)
			continue
		}
		const was = left[variant]
		const now = right[variant]
		if (jsonEqual(was, now)) continue
		const wasState = asRecord(asRecord(was)?.state) ?? {}
		const nowState = asRecord(asRecord(now)?.state) ?? {}
		for (const widgetId of unionKeys(wasState, nowState)) {
			const changes = diffJson(wasState[widgetId], nowState[widgetId])
			if (changes.length > 0) stateChanged.push({ variant, widgetId, changes })
		}
		const other = diffJsonExcept(was, now, ['state'])
		if (other.length > 0) otherChanged.push({ variant, changes: other })
	}
	return { added, removed, stateChanged, otherChanged }
}

function diffSpec(before: Side, after: Side): ViewSpecChanges {
	const left = asRecord(before) ?? {}
	const right = asRecord(after) ?? {}
	const intent = valueChange(left.intent, right.intent)
	const sections: (Readonly<{ section: ViewSpecListSection }> & ListItemChanges<JsonValue>)[] = []
	for (const section of VIEW_SPEC_LIST_SECTIONS) {
		const was = left[section]
		const now = right[section]
		if (!Array.isArray(was ?? []) || !Array.isArray(now ?? [])) continue
		const changes = diffListItems((was ?? []) as JsonValue[], (now ?? []) as JsonValue[])
		if (changes) sections.push({ section, ...changes })
	}
	const decisions = diffDecisions(left.decisions, right.decisions)
	// A section that is not a list on both sides is left to the structural diff below.
	const listed = VIEW_SPEC_LIST_SECTIONS.filter(section => Array.isArray(left[section] ?? []) && Array.isArray(right[section] ?? []))
	const other = diffJsonExcept(left, right, ['intent', ...listed, ...(decisions ? ['decisions'] : [])])
	return {
		...(intent ? { intent } : {}),
		sections,
		decisions: decisions ?? { added: [], removed: [], changed: [] },
		...(other.length > 0 ? { otherChanges: other } : {}),
	}
}

/** Decisions matched by id, or `undefined` (reported structurally) when they cannot be. */
function diffDecisions(before: Side, after: Side): ViewDecisionChanges | undefined {
	const left = indexDecisions(before)
	const right = indexDecisions(after)
	if (!left || !right) return undefined
	const added: DecisionSummary[] = []
	const removed: DecisionSummary[] = []
	const changed: ViewDecisionChanges['changed'][number][] = []
	for (const [id, decision] of left) if (!right.has(id)) removed.push(decisionSummary(id, decision))
	for (const [id, decision] of right) {
		const was = left.get(id)
		if (!was) {
			added.push(decisionSummary(id, decision))
			continue
		}
		if (jsonEqual(was, decision)) continue
		const question = valueChange(was.question, decision.question)
		const status = valueChange(was.status, decision.status)
		const outcome = valueChange(was.outcome, decision.outcome)
		const other = diffJsonExcept(was, decision, ['id', 'question', 'status', 'outcome'])
		changed.push({
			id,
			...(question ? { question } : {}),
			...(status ? { status } : {}),
			...(outcome ? { outcome } : {}),
			...(other.length > 0 ? { otherChanges: other } : {}),
		})
	}
	return { added, removed, changed }
}

function indexDecisions(value: Side): Map<string, Readonly<Record<string, JsonValue>>> | undefined {
	if (value === undefined) return new Map()
	if (!Array.isArray(value)) return undefined
	const decisions = new Map<string, Readonly<Record<string, JsonValue>>>()
	for (const item of value) {
		const decision = asRecord(item)
		const id = asString(decision?.id)
		if (!decision || id === undefined || decisions.has(id)) return undefined
		decisions.set(id, decision)
	}
	return decisions
}

function decisionSummary(id: string, decision: Readonly<Record<string, JsonValue>>): DecisionSummary {
	const question = asString(decision.question)
	const status = asString(decision.status)
	return { id, ...(question === undefined ? {} : { question }), ...(status === undefined ? {} : { status }) }
}
