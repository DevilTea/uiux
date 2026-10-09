import { evaluateEvidenceStaleness, type EvidenceStalenessContext } from '../evidence/staleness'
import { resourceIdentityKey } from '../history/summary'
import type { ImpactWorkspace } from './model'

/**
 * Reference-impact analysis (issue #132 B6; owner ruling 4 of
 * https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18825439: a standalone
 * analyzer, designed for reuse by issue #75). Pure: it compares two pictures of one Workspace,
 * before and after a change, and lists what the change does to the references other resources
 * hold. It never reads or writes anything and never repairs a reference.
 *
 * The categories are those of Rules 01a11a5e-174b-7e74-b232-5ec76601fbed and
 * 01a11a5e-17a0-7c21-9e23-dd56ef12c9a9; the item shapes are implementation-defined.
 *
 * - `review_anchor_invalidated` / `review_anchor_revalidated`: a Review thread whose Widget anchor
 *   names a Widget that would stop or start existing in its View.
 * - `i18n_reference_dangling`: a `$i18n` binding in a View whose key the default Locale would not
 *   define (it would resolve in no Locale's fallback), and did before or was not there before.
 * - `asset_reference_dangling`: a `$asset` binding in a View whose Asset would not exist.
 * - `flow_step_widget_missing`: a UX Flow step whose transition-trigger Widgets would no longer
 *   exist in the step's target View.
 * - `submission_revision_not_current` / `submission_revision_current`: a ready-for-review thread's
 *   current submission names a resource at a revision that would stop or start being current.
 * - `render_key_removed`: a viewport or theme key the change removes (a rename removes the old key),
 *   with the threads whose render context names it, for information: a stale key never invalidates
 *   a thread.
 * - `evidence_stale`: formal Evidence that is fresh before and would be stale after, by the
 *   freshness rules this build evaluates. Adapter provenance is not evaluated until it is recorded
 *   (issues #57 and #92; owner ruling 5 of the same comment), so a changed `adapters` selection,
 *   order or configuration is not reported yet.
 */
export type ImpactWidgetAnchor = Readonly<{ viewId: string; widgetId: string }>
export type ImpactResourceIdentity = Readonly<{ kind: string; key: string }>

export type ImpactItem =
	| Readonly<{ category: 'review_anchor_invalidated' | 'review_anchor_revalidated'; reviewId: string; reviewStatus?: string; anchor: ImpactWidgetAnchor }>
	| Readonly<{ category: 'i18n_reference_dangling'; viewId: string; i18nKey: string; pointers: readonly string[] }>
	| Readonly<{ category: 'asset_reference_dangling'; viewId: string; assetId: string; pointers: readonly string[] }>
	| Readonly<{ category: 'flow_step_widget_missing'; flowId: string; stepId: string; viewId: string; widgetIds: readonly string[] }>
	| Readonly<{ category: 'submission_revision_not_current' | 'submission_revision_current'; reviewId: string; submissionId: string; resource: ImpactResourceIdentity; revision: string }>
	| Readonly<{ category: 'render_key_removed'; dimension: 'viewport' | 'theme'; key: string; reviewIds: readonly string[] }>
	| Readonly<{ category: 'evidence_stale'; evidence: string; viewId?: string; reason: string }>

export type ImpactCategory = ImpactItem['category']

/** The order items are listed in. */
export const IMPACT_CATEGORIES: readonly ImpactCategory[] = Object.freeze([
	'review_anchor_invalidated',
	'review_anchor_revalidated',
	'i18n_reference_dangling',
	'asset_reference_dangling',
	'flow_step_widget_missing',
	'submission_revision_not_current',
	'submission_revision_current',
	'render_key_removed',
	'evidence_stale',
])

/** How deep the analysis follows nested JSON, so malformed input never exhausts the stack. */
const MAX_DEPTH = 256

/** The fallback Locale when the manifest names none, as the Preview and Evidence freshness assume. */
const DEFAULT_LOCALE_FALLBACK = 'en-US'

export function analyzeImpact(before: ImpactWorkspace, after: ImpactWorkspace): readonly ImpactItem[] {
	return [
		...reviewAnchorImpact(before, after),
		...bindingImpact(before, after),
		...flowImpact(before, after),
		...submissionImpact(before, after),
		...renderKeyImpact(before, after),
		...evidenceImpact(before, after),
	]
}

// ── Review anchors ─────────────────────────────────────────────────────────────

function reviewAnchorImpact(before: ImpactWorkspace, after: ImpactWorkspace): ImpactItem[] {
	const invalidated: ImpactItem[] = []
	const revalidated: ImpactItem[] = []
	const widgetCache = new Map<unknown, ReadonlySet<string>>()
	const widgets = (view: unknown) => {
		let ids = widgetCache.get(view)
		if (!ids) widgetCache.set(view, ids = widgetIds(view))
		return ids
	}
	const valid = (workspace: ImpactWorkspace, anchor: ImpactWidgetAnchor) => {
		const view = workspace.views.get(anchor.viewId)
		return view !== undefined && widgets(view).has(anchor.widgetId)
	}
	for (const thread of sortedThreads(after.reviews)) {
		const anchor = widgetAnchor(thread.anchor)
		if (!anchor) continue
		const was = valid(before, anchor)
		const will = valid(after, anchor)
		if (was === will) continue
		const item = { reviewId: thread.id, ...(typeof thread.status === 'string' ? { reviewStatus: thread.status } : {}), anchor }
		if (was) invalidated.push({ category: 'review_anchor_invalidated', ...item })
		else revalidated.push({ category: 'review_anchor_revalidated', ...item })
	}
	return [...invalidated, ...revalidated]
}

// ── $i18n and $asset bindings ──────────────────────────────────────────────────

type BindingReference = Readonly<{ binding: '$i18n' | '$asset'; target: string; pointer: string }>

function bindingImpact(before: ImpactWorkspace, after: ImpactWorkspace): ImpactItem[] {
	const i18n: ImpactItem[] = []
	const assets: ImpactItem[] = []
	const beforeDefault = defaultLocaleMessages(before)
	const afterDefault = defaultLocaleMessages(after)
	const dangles = (workspace: ImpactWorkspace, messages: unknown, reference: Pick<BindingReference, 'binding' | 'target'>) =>
		reference.binding === '$i18n' ? !hasOwnString(messages, reference.target) : !workspace.assets.has(reference.target)
	for (const viewId of sortedKeys(after.views)) {
		const references = bindingReferences(after.views.get(viewId))
		if (references.length === 0) continue
		const previous = before.views.get(viewId)
		const danglingBefore = new Set<string>()
		for (const reference of previous === undefined ? [] : bindingReferences(previous)) {
			if (dangles(before, beforeDefault, reference)) danglingBefore.add(`${reference.binding}\0${reference.target}`)
		}
		const grouped = new Map<string, { binding: BindingReference['binding']; target: string; pointers: string[] }>()
		for (const reference of references) {
			const id = `${reference.binding}\0${reference.target}`
			if (!dangles(after, afterDefault, reference) || danglingBefore.has(id)) continue
			const group = grouped.get(id) ?? { binding: reference.binding, target: reference.target, pointers: [] }
			group.pointers.push(reference.pointer)
			grouped.set(id, group)
		}
		for (const group of [...grouped.values()].sort((left, right) => compare(left.target, right.target))) {
			if (group.binding === '$i18n') i18n.push({ category: 'i18n_reference_dangling', viewId, i18nKey: group.target, pointers: group.pointers })
			else assets.push({ category: 'asset_reference_dangling', viewId, assetId: group.target, pointers: group.pointers })
		}
	}
	return [...i18n, ...assets]
}

function defaultLocaleMessages(workspace: ImpactWorkspace): unknown {
	const i18n = asRecord(asRecord(workspace.manifest)?.i18n)
	const locale = typeof i18n?.defaultLocale === 'string' ? i18n.defaultLocale : DEFAULT_LOCALE_FALLBACK
	return workspace.locales.get(locale)
}

/** Every `{ $i18n: <key> }` and `{ $asset: <id> }` binding in a View's IR and Variants, with its JSON pointer in the View. */
export function bindingReferences(view: unknown): readonly BindingReference[] {
	const references: BindingReference[] = []
	const record = asRecord(view)
	if (!record) return references
	const visit = (value: unknown, pointer: string, depth: number): void => {
		if (depth > MAX_DEPTH) return
		if (Array.isArray(value)) {
			value.forEach((item, index) => visit(item, `${pointer}/${index}`, depth + 1))
			return
		}
		const object = asRecord(value)
		if (!object) return
		for (const binding of ['$i18n', '$asset'] as const) {
			const target = object[binding]
			if (typeof target === 'string' && target.length > 0) references.push({ binding, target, pointer })
		}
		for (const key of Object.keys(object)) visit(object[key], `${pointer}/${escapePointer(key)}`, depth + 1)
	}
	visit(record.ir, '/ir', 0)
	visit(record.variants, '/variants', 0)
	return references
}

// ── UX Flow steps ──────────────────────────────────────────────────────────────

function flowImpact(before: ImpactWorkspace, after: ImpactWorkspace): ImpactItem[] {
	const items: ImpactItem[] = []
	const missingBefore = missingTriggers(before)
	const missingAfter = missingTriggers(after)
	const grouped = new Map<string, { flowId: string; stepId: string; viewId: string; widgetIds: string[] }>()
	for (const [id, trigger] of missingAfter) {
		if (missingBefore.has(id)) continue
		const groupId = `${trigger.flowId}\0${trigger.stepId}\0${trigger.viewId}`
		const group = grouped.get(groupId) ?? { flowId: trigger.flowId, stepId: trigger.stepId, viewId: trigger.viewId, widgetIds: [] }
		if (!group.widgetIds.includes(trigger.widgetId)) group.widgetIds.push(trigger.widgetId)
		grouped.set(groupId, group)
	}
	for (const group of [...grouped.values()].sort((left, right) => compare(left.flowId, right.flowId) || compare(left.stepId, right.stepId)))
		items.push({ category: 'flow_step_widget_missing', ...group, widgetIds: group.widgetIds.sort(compare) })
	return items
}

type FlowTrigger = Readonly<{ flowId: string; stepId: string; viewId: string; widgetId: string }>

/** Every transition trigger whose Widget does not exist in its step's target View, by identity. */
function missingTriggers(workspace: ImpactWorkspace): Map<string, FlowTrigger> {
	const missing = new Map<string, FlowTrigger>()
	const widgetsByView = new Map<string, ReadonlySet<string> | undefined>()
	for (const flowId of sortedKeys(workspace.flows)) {
		const steps = asRecord(asRecord(workspace.flows.get(flowId))?.steps)
		if (!steps) continue
		for (const stepId of Object.keys(steps).sort(compare)) {
			const step = asRecord(steps[stepId])
			const viewId = asRecord(step?.target)?.viewId
			if (typeof viewId !== 'string' || !Array.isArray(step?.transitions)) continue
			if (!widgetsByView.has(viewId)) {
				const view = workspace.views.get(viewId)
				widgetsByView.set(viewId, view === undefined ? undefined : widgetIds(view))
			}
			const widgets = widgetsByView.get(viewId)
			for (const transition of step.transitions) {
				const widgetId = asRecord(asRecord(transition)?.trigger)?.widgetId
				if (typeof widgetId !== 'string' || widgets?.has(widgetId)) continue
				missing.set(`${flowId}\0${stepId}\0${viewId}\0${widgetId}`, { flowId, stepId, viewId, widgetId })
			}
		}
	}
	return missing
}

// ── Ready-for-review submissions ───────────────────────────────────────────────

function submissionImpact(before: ImpactWorkspace, after: ImpactWorkspace): ImpactItem[] {
	const stopped: ImpactItem[] = []
	const started: ImpactItem[] = []
	for (const thread of sortedThreads(after.reviews)) {
		if (thread.status !== 'ready-for-review') continue
		const submission = currentSubmission(thread)
		if (!submission) continue
		for (const named of Array.isArray(submission.resources) ? submission.resources : []) {
			const entry = asRecord(named)
			const resource = namedResource(entry?.identity)
			if (!resource || typeof entry?.revision !== 'string') continue
			const key = resourceIdentityKey(resource)
			const was = before.revisions.get(key) === entry.revision
			const will = after.revisions.get(key) === entry.revision
			if (was === will) continue
			const item = { reviewId: thread.id, submissionId: submission.id, resource, revision: entry.revision }
			if (was) stopped.push({ category: 'submission_revision_not_current', ...item })
			else started.push({ category: 'submission_revision_current', ...item })
		}
	}
	return [...stopped, ...started]
}

type ThreadLike = Readonly<{ id: string; status?: unknown; anchor?: unknown; renderContext?: unknown; submissions?: unknown; history?: unknown }>
type SubmissionLike = Readonly<{ id: string; resources?: unknown }>

/** The submission the thread's ready-for-review state rests on: the latest transition into it, else the latest submission. */
function currentSubmission(thread: ThreadLike): SubmissionLike | undefined {
	const submissions = (Array.isArray(thread.submissions) ? thread.submissions : [])
		.flatMap(item => isIdentified(item) ? [item as SubmissionLike] : [])
	const history = Array.isArray(thread.history) ? thread.history : []
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const event = asRecord(history[index])
		if (event?.to !== 'ready-for-review' || typeof event.submissionId !== 'string') continue
		const found = submissions.find(item => item.id === event.submissionId)
		if (found) return found
	}
	return submissions.at(-1)
}

/** A submission's named resource: `{ type, id }` (`{ type: "workspace" }` alone for the manifest) or `{ kind, key }`. */
function namedResource(identity: unknown): ImpactResourceIdentity | undefined {
	const record = asRecord(identity)
	if (!record) return undefined
	if (typeof record.kind === 'string' && typeof record.key === 'string') return { kind: record.kind, key: record.key }
	if (record.type === 'workspace') return { kind: 'workspace', key: 'workspace' }
	if (typeof record.type === 'string' && typeof record.id === 'string') return { kind: record.type, key: record.id }
	return undefined
}

// ── Viewport and theme keys ────────────────────────────────────────────────────

function renderKeyImpact(before: ImpactWorkspace, after: ImpactWorkspace): ImpactItem[] {
	const items: ImpactItem[] = []
	for (const [dimension, registry, member] of [['viewport', 'viewports', 'viewportId'], ['theme', 'themes', 'themeId']] as const) {
		const was = asRecord(asRecord(before.manifest)?.[registry])
		const now = asRecord(asRecord(after.manifest)?.[registry])
		if (!was) continue
		for (const key of Object.keys(was).sort(compare)) {
			if (now && Object.hasOwn(now, key)) continue
			const reviewIds = sortedThreads(after.reviews)
				.filter(thread => asRecord(thread.renderContext)?.[member] === key)
				.map(thread => thread.id)
			items.push({ category: 'render_key_removed', dimension, key, reviewIds })
		}
	}
	return items
}

// ── Formal Evidence ────────────────────────────────────────────────────────────

function evidenceImpact(before: ImpactWorkspace, after: ImpactWorkspace): ImpactItem[] {
	const records = after.evidence ?? before.evidence
	if (!records) return []
	const items: ImpactItem[] = []
	const beforeContext = stalenessContext(before)
	const afterContext = stalenessContext(after)
	for (const { digest, record } of [...records].sort((left, right) => compare(left.digest, right.digest))) {
		if (evaluateEvidenceStaleness(record, beforeContext).isStale) continue
		const assessment = evaluateEvidenceStaleness(record, afterContext)
		if (!assessment.isStale) continue
		const viewId = asRecord(record.executionContext)?.viewId
		items.push({ category: 'evidence_stale', evidence: digest, ...(typeof viewId === 'string' ? { viewId } : {}), reason: assessment.reason ?? 'stale' })
	}
	return items
}

function stalenessContext(workspace: ImpactWorkspace): EvidenceStalenessContext {
	const localeRevisions: Record<string, string> = {}
	for (const locale of workspace.locales.keys()) {
		const revision = workspace.revisions.get(resourceIdentityKey({ kind: 'locale', key: locale }))
		if (revision !== undefined) localeRevisions[locale] = revision
	}
	return {
		allViews: sortedKeys(workspace.views).flatMap((key) => {
			const revision = workspace.revisions.get(resourceIdentityKey({ kind: 'view', key }))
			return revision === undefined ? [] : [{ key, revision }]
		}),
		workspace: { resource: (asRecord(workspace.manifest) ?? undefined) as NonNullable<EvidenceStalenessContext['workspace']>['resource'] },
		discoveredLocales: sortedKeys(workspace.locales),
		localeRevisions,
	}
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

/**
 * Every Widget id in a View's IR (the RootShell `root` included), following each node's `slots`.
 * A node counts as the Preview's widget tree counts it (`deriveWidgetTree` in
 * `src/preview/widget-tree.ts`): it needs a non-empty string `id` and `type`, and a node without
 * them is dropped with its whole subtree. Unlike the Preview, nodes deeper than the depth bound are
 * not followed, so malformed input never exhausts the stack.
 */
export function widgetIds(view: unknown): ReadonlySet<string> {
	const ids = new Set<string>()
	const visit = (value: unknown, depth: number): void => {
		const node = asRecord(value)
		if (!node || depth > MAX_DEPTH) return
		if (typeof node.id !== 'string' || node.id.length === 0 || typeof node.type !== 'string' || node.type.length === 0) return
		ids.add(node.id)
		const slots = asRecord(node.slots)
		if (!slots) return
		for (const children of Object.values(slots)) {
			if (Array.isArray(children)) for (const child of children) visit(child, depth + 1)
		}
	}
	visit(asRecord(view)?.ir, 0)
	return ids
}

function widgetAnchor(anchor: unknown): ImpactWidgetAnchor | undefined {
	const record = asRecord(anchor)
	if (!record || Object.hasOwn(record, 'scope')) return undefined
	return typeof record.viewId === 'string' && typeof record.widgetId === 'string' ? { viewId: record.viewId, widgetId: record.widgetId } : undefined
}

function sortedThreads(reviews: readonly unknown[]): ThreadLike[] {
	return reviews.flatMap(item => isIdentified(item) ? [item as ThreadLike] : []).sort((left, right) => compare(left.id, right.id))
}

function isIdentified(value: unknown): boolean {
	return typeof asRecord(value)?.id === 'string'
}

function hasOwnString(messages: unknown, key: string): boolean {
	const record = asRecord(messages)
	return record !== undefined && Object.hasOwn(record, key) && typeof record[key] === 'string'
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined
}

function sortedKeys(map: ReadonlyMap<string, unknown>): string[] {
	return [...map.keys()].sort(compare)
}

function escapePointer(segment: string): string {
	return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}
