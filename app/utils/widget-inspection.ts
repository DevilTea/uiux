import type { WidgetTreeNode } from '../../src/preview/widget-tree'
import type { DecisionRead, Diagnostic, ReferenceRead, ViewRead } from '../composables/workbench-types'

/**
 * Pure derivations behind the Inspector and the Spec document (brief e). Nothing here reads
 * runtime state; the components bind these to the Workbench selection.
 */

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Lucide icon for a Widget type from the reference Catalog; unknown types get a neutral glyph. */
export function widgetTypeIcon(type: string, hasChildren = false): string {
	switch (type) {
		case 'RootShell': return 'i-lucide-frame'
		case 'Stack': return 'i-lucide-rows-3'
		case 'Panel': return 'i-lucide-panel-top'
		case 'Text': return 'i-lucide-type'
		case 'Badge': return 'i-lucide-tag'
		case 'Button': return 'i-lucide-rectangle-horizontal'
		case 'Divider': return 'i-lucide-minus'
		case 'NavItem': return 'i-lucide-link'
		case 'TextInput': return 'i-lucide-text-cursor-input'
		case 'Image': return 'i-lucide-image'
		default: return hasChildren ? 'i-lucide-box' : 'i-lucide-square'
	}
}

/** The raw IR node for a Widget id, depth first in slot order. */
export function findIrNode(ir: unknown, id: string): JsonRecord | undefined {
	if (!isRecord(ir)) return undefined
	if (ir.id === id) return ir
	if (!isRecord(ir.slots)) return undefined
	for (const entries of Object.values(ir.slots)) {
		if (!Array.isArray(entries)) continue
		for (const entry of entries) {
			const found = findIrNode(entry, id)
			if (found) return found
		}
	}
	return undefined
}

/** Nodes from the root down to (and including) the Widget, or `[]` when it is not in the tree. */
export function widgetAncestry(root: WidgetTreeNode, id: string): readonly WidgetTreeNode[] {
	if (root.id === id) return [root]
	for (const child of root.children) {
		const path = widgetAncestry(child, id)
		if (path.length) return [root, ...path]
	}
	return []
}

/** A Widget's visible label as authored: literal text or a Locale message key. */
export type WidgetLabelSource =
	| Readonly<{ kind: 'text'; value: string }>
	| Readonly<{ kind: 'message'; key: string }>

const LABEL_FIELDS = ['label', 'text', 'title', 'placeholder', 'alt'] as const

export function widgetLabelSource(node: JsonRecord | undefined): WidgetLabelSource | undefined {
	const config = node && isRecord(node.config) ? node.config : undefined
	if (!config) return undefined
	for (const field of LABEL_FIELDS) {
		const value = config[field]
		if (typeof value === 'string' && value.trim()) return { kind: 'text', value }
		if (isRecord(value) && typeof value.$i18n === 'string' && value.$i18n) return { kind: 'message', key: value.$i18n }
	}
	return undefined
}

/** One authored Variant state override on the selected Widget. */
export type VariantOverride = Readonly<{ property: string; value: unknown }>

export function variantOverrides(view: ViewRead | undefined, variantName: string | undefined, widgetId: string): readonly VariantOverride[] {
	if (!view || !variantName) return []
	const state = view.resource.variants[variantName]?.state?.[widgetId]
	if (!isRecord(state)) return []
	return Object.entries(state).map(([property, value]) => ({ property, value }))
}

/** Diagnostics reported against a Variant (its own subtree of the View resource). */
export function variantDiagnostics(view: ViewRead | undefined, variantName: string | undefined): readonly Diagnostic[] {
	if (!view || !variantName) return []
	const prefix = `/variants/${variantName.replaceAll('~', '~0').replaceAll('/', '~1')}`
	return view.diagnostics.filter(item => item.path === prefix || item.path.startsWith(`${prefix}/`))
}

/** A compact, literal rendering of a JSON value for the override diff. */
export function formatStateValue(value: unknown): string {
	if (typeof value === 'string') return JSON.stringify(value)
	if (value === undefined) return ''
	try { return JSON.stringify(value) ?? String(value) }
	catch { return String(value) }
}

/** Keeps both ends of a long identity, e.g. a revision: `sha256:7f3d…a91c`. */
export function truncateMiddle(value: string, max = 24): string {
	if (value.length <= max) return value
	const keep = Math.max(4, Math.floor((max - 1) / 2))
	return `${value.slice(0, keep)}…${value.slice(-keep)}`
}

/** Initials for an actor display name: "Mei Lin" → "ML", "reviewer" → "R". */
export function actorInitials(name: string | undefined): string {
	const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
	if (!words.length) return '?'
	const letters = words.length === 1 ? [...words[0]!].slice(0, 1) : [[...words[0]!][0]!, [...words.at(-1)!][0]!]
	return letters.join('').toUpperCase()
}

/** Splits prose into text runs and `#widget-id` mentions of Widgets that exist in this View. */
export type MentionSegment =
	| Readonly<{ kind: 'text'; text: string }>
	| Readonly<{ kind: 'widget'; text: string; widgetId: string }>

export function splitWidgetMentions(text: string, knownIds: ReadonlySet<string>): readonly MentionSegment[] {
	const segments: MentionSegment[] = []
	let cursor = 0
	for (const match of text.matchAll(/(^|[^\w#&])#([A-Za-z](?:[\w-]*\w)?)/g)) {
		const widgetId = match[2]!
		if (!knownIds.has(widgetId)) continue
		const start = match.index! + match[1]!.length
		if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) })
		segments.push({ kind: 'widget', text: `#${widgetId}`, widgetId })
		cursor = start + widgetId.length + 1
	}
	if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
	return segments
}

/** The Review thread a Decision was promoted from, if its provenance or history names one. */
export function decisionSourceThread(decision: DecisionRead & { provenance?: unknown }): string | undefined {
	const provenance = isRecord(decision.provenance) ? decision.provenance : undefined
	const fromProvenance = provenance?.sourceReviewThreadId ?? provenance?.reviewId
	if (typeof fromProvenance === 'string' && fromProvenance) return fromProvenance
	for (const entry of [...decision.history].reverse()) {
		const source = isRecord(entry) && isRecord(entry.source) ? entry.source : undefined
		if (typeof source?.reviewId === 'string' && source.reviewId) return source.reviewId
	}
	return undefined
}

/** When the Decision last changed state, from its history. */
export function decisionChangedAt(decision: DecisionRead): string | undefined {
	const last = decision.history.at(-1)
	return isRecord(last) && typeof last.at === 'string' ? last.at : undefined
}

/** The six Spec fields `update_view_spec` writes. Decisions are preserved by the server. */
export const SPEC_LIST_SECTIONS = ['entryConditions', 'interactionRules', 'constraints', 'accessibility'] as const
export type SpecListSection = typeof SPEC_LIST_SECTIONS[number]
export type SpecSectionKey = 'intent' | SpecListSection | 'references'

export type ExternalReferenceDraft = { type: 'external'; uri: string; label: string; relation: string }
export type ViewReferenceDraft = { type: 'view'; viewId: string; variantName: string; relation: string }
export type ReferenceDraft = ExternalReferenceDraft | ViewReferenceDraft

export type SpecReference =
	| Readonly<{ type: 'external'; uri: string; label?: string; relation?: string }>
	| Readonly<{ type: 'view'; viewId: string; variantName?: string; relation?: string }>

export type SpecContent = Readonly<{
	intent: string
	entryConditions: readonly string[]
	interactionRules: readonly string[]
	constraints: readonly string[]
	accessibility: readonly string[]
	references: readonly SpecReference[]
}>

/** The writable part of a View Spec, as `PUT /api/views/:id/spec` expects it. */
export function specContentOf(view: ViewRead): SpecContent {
	const spec = view.resource.spec
	return {
		intent: spec.intent,
		entryConditions: [...spec.entryConditions],
		interactionRules: [...spec.interactionRules],
		constraints: [...spec.constraints],
		accessibility: [...spec.accessibility],
		references: spec.references.map(reference => ({ ...reference }) as unknown as SpecReference),
	}
}

export function referenceDraftOf(reference: ReferenceRead | SpecReference): ReferenceDraft {
	const record = reference as unknown as JsonRecord
	if (record.type === 'view') {
		return { type: 'view', viewId: String(record.viewId ?? ''), variantName: String(record.variantName ?? ''), relation: String(record.relation ?? '') }
	}
	return { type: 'external', uri: String(record.uri ?? ''), label: String(record.label ?? ''), relation: String(record.relation ?? '') }
}

/** Serializes a reference draft, dropping empty optional fields (the schema rejects empty relations). */
export function referenceFromDraft(draft: ReferenceDraft): SpecReference {
	const relation = draft.relation.trim()
	if (draft.type === 'view') {
		const variantName = draft.variantName.trim()
		return { type: 'view', viewId: draft.viewId, ...(variantName ? { variantName } : {}), ...(relation ? { relation } : {}) }
	}
	const label = draft.label.trim()
	return { type: 'external', uri: draft.uri.trim(), ...(label ? { label } : {}), ...(relation ? { relation } : {}) }
}

export function isAbsoluteUri(value: string): boolean {
	if (!/^[a-z][a-z\d+.-]*:/i.test(value.trim())) return false
	try { return Boolean(new URL(value.trim())) }
	catch { return false }
}

/** Trims list items and drops the empty ones a reviewer left behind. */
export function normalizeList(items: readonly string[]): string[] {
	return items.map(item => item.trim()).filter(Boolean)
}

/** Replaces one section of the Spec content, leaving every other section exactly as read. */
export function withSpecSection(content: SpecContent, section: SpecSectionKey, value: string | readonly string[] | readonly SpecReference[]): SpecContent {
	return { ...content, [section]: value } as SpecContent
}

/** "2h ago" style relative time in the chrome locale, for compact thread rows. */
export function relativeTime(at: string, locale: string, now = Date.now()): string {
	const time = new Date(at).getTime()
	if (Number.isNaN(time)) return ''
	const seconds = Math.round((time - now) / 1000)
	const steps: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]]
	const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' })
	for (const [unit, size] of steps) {
		if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
	}
	return format.format(0, 'minute')
}
