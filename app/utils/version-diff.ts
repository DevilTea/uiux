import type {
	AssetImageRef,
	JsonPointerChange,
	KeyedChanges,
	ListItemChanges,
	ResourceDiff,
	ValueChange,
	WidgetPosition,
} from '../../src/domain/history/diff'
import type { JsonValue } from '../../src/domain/validation'

/**
 * The B5 semantic diff of one resource as a list of sections the Workbench renders the same way
 * for every kind (Rule 01a11a5e-11e0-7f39-84a7-fde3faa43340: the diff per resource after the
 * summary). Labels here are identifiers from the Workspace (Widget IDs, Variant names, message
 * keys, JSON pointers), never chrome: section and field names are i18n keys the component looks up.
 */

export type DiffOp = 'added' | 'removed' | 'changed' | 'moved' | 'reordered'

export type DiffItem = Readonly<{
	op: DiffOp
	/** A Workspace identifier (`#cta`, `compact`, `greeting`, `/config/label`). */
	label?: string
	/** A chrome field name, looked up as `history.diff.field.<field>`. */
	field?: string
	before?: JsonValue
	after?: JsonValue
	/** Nested structural changes, pointers relative to the item. */
	changes?: readonly JsonPointerChange[]
}>

/** `key` is looked up as `history.diff.section.<key>`. */
export type DiffSection = Readonly<{ key: string; items: readonly DiffItem[] }>

export type DescribedDiff = Readonly<{
	sections: readonly DiffSection[]
	/** An Asset's images, fetched by content digest. */
	image?: Readonly<{ before?: AssetImageRef; after?: AssetImageRef }>
	/** True for a resource kind this build cannot diff (the open kind set). */
	unsupported?: true
}>

function valueItem(field: string, change: ValueChange | undefined): DiffItem[] {
	if (!change) return []
	const op: DiffOp = change.before === undefined ? 'added' : change.after === undefined ? 'removed' : 'changed'
	return [{ op, field, ...(change.before === undefined ? {} : { before: change.before }), ...(change.after === undefined ? {} : { after: change.after }) }]
}

/** One item per pointer change. */
export function pointerItems(changes: readonly JsonPointerChange[] | undefined, prefix = ''): DiffItem[] {
	return (changes ?? []).map((change) => {
		const label = `${prefix}${change.path || '/'}`
		if (change.op === 'add') return { op: 'added', label, after: change.after }
		if (change.op === 'remove') return { op: 'removed', label, before: change.before }
		return { op: 'changed', label, before: change.before, after: change.after }
	})
}

function listItems(field: string, changes: ListItemChanges<JsonValue> | undefined, label?: string): DiffItem[] {
	if (!changes) return []
	return [
		...changes.added.map(value => ({ op: 'added' as const, field, ...(label ? { label } : {}), after: value })),
		...changes.removed.map(value => ({ op: 'removed' as const, field, ...(label ? { label } : {}), before: value })),
		...(changes.reordered ? [{ op: 'reordered' as const, field, ...(label ? { label } : {}) }] : []),
	]
}

function keyedItems(changes: KeyedChanges | undefined): DiffItem[] {
	if (!changes) return []
	return [
		...changes.added.map(entry => ({ op: 'added' as const, label: entry.key, after: entry.value })),
		...changes.removed.map(entry => ({ op: 'removed' as const, label: entry.key, before: entry.value })),
		...changes.changed.map(entry => ({ op: 'changed' as const, label: entry.key, changes: entry.changes })),
	]
}

/** `parent › slot #index`: where a Widget sits among its siblings. */
export function formatWidgetPosition(position: WidgetPosition | undefined): string | undefined {
	if (!position) return undefined
	return `#${position.parent} › ${position.slot} [${position.index}]`
}

function section(key: string, items: readonly DiffItem[]): DiffSection[] {
	return items.length ? [{ key, items }] : []
}

export function describeResourceDiff(diff: ResourceDiff): DescribedDiff {
	switch (diff.type) {
		case 'view': {
			const widgets = diff.widgets
			const variants = diff.variants
			const spec = diff.spec
			return {
				sections: [
					...section('properties', [...valueItem('name', diff.name), ...valueItem('feature', diff.feature)]),
					...section('widgets', widgets
						? [
								...widgets.added.map(widget => ({ op: 'added' as const, label: `#${widget.id}`, ...(widget.type ? { after: widget.type } : {}) })),
								...widgets.removed.map(widget => ({ op: 'removed' as const, label: `#${widget.id}`, ...(widget.type ? { before: widget.type } : {}) })),
								...widgets.moved.map(widget => ({
									op: 'moved' as const,
									label: `#${widget.id}`,
									...(formatWidgetPosition(widget.before) ? { before: formatWidgetPosition(widget.before)! } : {}),
									...(formatWidgetPosition(widget.after) ? { after: formatWidgetPosition(widget.after)! } : {}),
								})),
								...widgets.typeChanged.map(widget => ({ op: 'changed' as const, label: `#${widget.id}`, field: 'type', ...(widget.before ? { before: widget.before } : {}), ...(widget.after ? { after: widget.after } : {}) })),
								...widgets.configChanged.map(widget => ({ op: 'changed' as const, label: `#${widget.id}`, changes: widget.changes })),
							]
						: pointerItems(diff.irChanges, '/ir')),
					...section('variants', [
						...variants.added.map(name => ({ op: 'added' as const, label: name })),
						...variants.removed.map(name => ({ op: 'removed' as const, label: name })),
						...variants.stateChanged.map(change => ({ op: 'changed' as const, label: `${change.variant} · #${change.widgetId}`, field: 'state', changes: change.changes })),
						...variants.otherChanged.map(change => ({ op: 'changed' as const, label: change.variant, changes: change.changes })),
					]),
					...section('spec', [
						...valueItem('intent', spec.intent),
						...spec.sections.flatMap(entry => listItems(entry.section, entry)),
						...pointerItems(spec.otherChanges, '/spec'),
					]),
					...section('decisions', [
						...spec.decisions.added.map(decision => ({ op: 'added' as const, label: decision.question || decision.id, ...(decision.status ? { after: decision.status } : {}) })),
						...spec.decisions.removed.map(decision => ({ op: 'removed' as const, label: decision.question || decision.id, ...(decision.status ? { before: decision.status } : {}) })),
						...spec.decisions.changed.flatMap(decision => [
							...valueItem('question', decision.question),
							...valueItem('status', decision.status),
							...valueItem('outcome', decision.outcome),
							...(decision.otherChanges?.length ? [{ op: 'changed' as const, changes: decision.otherChanges }] : []),
						].map(item => ({ ...item, label: decision.id }))),
					]),
					...section('other', pointerItems(diff.otherChanges)),
				],
			}
		}
		case 'flow':
			return {
				sections: [
					...section('properties', [...valueItem('name', diff.name), ...valueItem('entryStepId', diff.entryStepId)]),
					...section('steps', diff.steps
						? [
								...diff.steps.added.map(step => ({ op: 'added' as const, label: step.stepId })),
								...diff.steps.removed.map(step => ({ op: 'removed' as const, label: step.stepId })),
								...diff.steps.changed.flatMap(step => [
									...valueItem('target', step.target),
									...listItems('transition', step.transitions),
									...(step.otherChanges?.length ? [{ op: 'changed' as const, changes: step.otherChanges }] : []),
								].map(item => ({ ...item, label: step.stepId }))),
							]
						: pointerItems(diff.stepsChanges, '/steps')),
					...section('other', pointerItems(diff.otherChanges)),
				],
			}
		case 'locale':
			return {
				sections: [
					...section('messages', diff.messages
						? [
								...diff.messages.added.map(message => ({ op: 'added' as const, label: message.key, after: message.value })),
								...diff.messages.removed.map(message => ({ op: 'removed' as const, label: message.key, before: message.value })),
								...diff.messages.changed.map(message => ({ op: 'changed' as const, label: message.key, before: message.before, after: message.after })),
							]
						: pointerItems(diff.changes)),
				],
			}
		case 'workspace':
			return {
				sections: [
					...section('i18n', [...valueItem('defaultLocale', diff.defaultLocale), ...pointerItems(diff.i18nChanges, '/i18n')]),
					...section('viewports', keyedItems(diff.viewports)),
					...section('themes', keyedItems(diff.themes)),
					...section('adapters', diff.adapters
						? [
								...diff.adapters.added.map(adapter => ({ op: 'added' as const, label: adapter.moduleSpecifier })),
								...diff.adapters.removed.map(adapter => ({ op: 'removed' as const, label: adapter.moduleSpecifier })),
								...diff.adapters.changed.map(adapter => ({ op: 'changed' as const, label: adapter.moduleSpecifier, changes: adapter.changes })),
								...(diff.adapters.reordered ? [{ op: 'reordered' as const }] : []),
							]
						: pointerItems(diff.adaptersChanges, '/adapters')),
					...section('other', pointerItems(diff.otherChanges)),
				],
			}
		case 'asset':
			return {
				sections: [
					...section('metadata', pointerItems(diff.metadata)),
					...section('content', diff.content ? valueItem('content', diff.content) : []),
					...section('files', (diff.files ?? []).map(file => ({
						op: file.before === undefined ? 'added' as const : file.after === undefined ? 'removed' as const : 'changed' as const,
						label: file.name,
						...(file.before === undefined ? {} : { before: file.before }),
						...(file.after === undefined ? {} : { after: file.after }),
					}))),
				],
				...(diff.image ? { image: diff.image } : {}),
			}
		case 'structural':
			return { sections: section('structure', pointerItems(diff.changes)) }
		case 'opaque':
			return {
				sections: section('files', diff.files.map(file => ({
					op: file.before === undefined ? 'added' as const : file.after === undefined ? 'removed' as const : 'changed' as const,
					label: file.path,
					...(file.before === undefined ? {} : { before: file.before }),
					...(file.after === undefined ? {} : { after: file.after }),
				}))),
			}
		case 'unsupported_kind':
			return { sections: [], unsupported: true }
	}
}

const MAX_VALUE_LENGTH = 160

/** A diff value on one line: strings as they are, anything else as compact JSON, truncated. */
export function formatDiffValue(value: JsonValue | undefined): string {
	if (value === undefined) return ''
	const text = typeof value === 'string' ? value : JSON.stringify(value)
	return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text
}
