import { CHANGE_DOMAINS, type ChangeDomain } from '../../domain/reviews/change-domains'
import { REVIEW_ANCHOR_STATES, type ReviewAnchorState } from '../../domain/reviews/anchor-state'
import { REVIEW_RESOLUTIONS, type ReviewActor, type ReviewAnchor, type ReviewDisplayHint, type ReviewRenderContext, type ReviewResolution, type ReviewStatus } from '../../domain/reviews/schema'
import { isFullUuid, jsonPointer, rejectUnknownKeys, Validator, type Diagnostic } from '../../domain/validation'
import type { ResourceRevision } from './revisions'

export const DISCOVERABLE_RESOURCE_KINDS = ['view', 'flow', 'locale', 'review', 'asset'] as const
/** Review anchor arms for the `anchorScope` filter: `view` is every Widget-anchored thread (including View roots). */
export const REVIEW_ANCHOR_SCOPES = ['workspace', 'view'] as const
export type ReviewAnchorScope = typeof REVIEW_ANCHOR_SCOPES[number]
/**
 * Values of the Review `status` filter (Clause 01a163a5-7110-79e8-94ac-887c8eddde6a), in the Workbench
 * inbox vocabulary: `resolved` is resolved as `verified` or `answered`, `dismissed` resolved as
 * `wont-fix`, `duplicate` or `obsolete`.
 */
export const REVIEW_DISCOVERY_STATUSES = ['ready-for-review', 'open', 'resolved', 'dismissed'] as const
export type ReviewDiscoveryStatus = typeof REVIEW_DISCOVERY_STATUSES[number]
export const REVIEW_DISMISSAL_RESOLUTIONS: readonly ReviewResolution[] = ['wont-fix', 'duplicate', 'obsolete']
/** The `viewId` filter value for Workspace threads (View IDs are UUIDs, so it cannot collide). */
export const REVIEW_WORKSPACE_VIEW_TOKEN = 'workspace'
/** The `variant` filter value for View-wide threads (`variantNames: []`). */
export const REVIEW_VIEW_WIDE_VARIANT = '*'
/** Length of `latestMessage.excerpt` in grapheme clusters (Clause 01a163a5-719e-789d-a0fb-fc08646ed1d8). */
export const REVIEW_MESSAGE_EXCERPT_GRAPHEMES = 200
export const MAX_RESOURCE_DISCOVERY_LIMIT = 100

/** Every Review filter; any of them excludes other resource kinds (Clause 01a11544-6d38-7c63-958a-e0133b131fd3). */
export const REVIEW_DISCOVERY_FILTERS = ['resolution', 'anchorScope', 'status', 'viewId', 'variant', 'anchor', 'changeDomain'] as const
export type ReviewDiscoveryFilter = typeof REVIEW_DISCOVERY_FILTERS[number]

export type DiscoverableResourceKind = typeof DISCOVERABLE_RESOURCE_KINDS[number]
export type ResourceDiscoveryRequest = Readonly<{
	kinds?: readonly DiscoverableResourceKind[]
	query?: string
	/** Structured Review filter: only resolved threads whose derived resolution is listed match. */
	resolution?: readonly ReviewResolution[]
	/** Structured Review filter by anchor arm; other kinds ignore it, as with `resolution`. */
	anchorScope?: readonly ReviewAnchorScope[]
	/** Review filters of Clauses 01a11544-6d38-7c63-958a-e0133b131fd3 and 01a163a5-7110-79e8-94ac-887c8eddde6a. */
	status?: readonly ReviewDiscoveryStatus[]
	viewId?: readonly string[]
	variant?: readonly string[]
	anchor?: readonly ReviewAnchorState[]
	changeDomain?: readonly ChangeDomain[]
	cursor?: string
	limit: number
}>

export type ResourceDiscoveryItem =
	| Readonly<{ kind: 'view'; key: string; revision: ResourceRevision; diagnosticCount: number; summary: Readonly<{ name?: string; feature?: string }> }>
	| Readonly<{ kind: 'flow'; key: string; revision: ResourceRevision; diagnosticCount: number; summary: Readonly<{ name?: string }> }>
	| Readonly<{ kind: 'locale'; key: string; revision: ResourceRevision; diagnosticCount: number; summary: Readonly<{ messageCount?: number }> }>
	| Readonly<{ kind: 'review'; key: string; revision: ResourceRevision; diagnosticCount: number; summary: ReviewDiscoverySummary }>
	| Readonly<{ kind: 'asset'; key: string; revision: ResourceRevision; diagnosticCount: number; summary: Readonly<{ name?: string; mediaType?: string; contentFilename?: string }> }>

export type ReviewDiscoverySummary = Readonly<{
	anchor?: ReviewAnchor
	/** Anchor Variant scope; `[]` means View-wide. */
	variantNames?: readonly string[]
	/** Non-authoritative pin placement, beside (never inside) `anchor`. */
	displayHint?: ReviewDisplayHint
	/** Recorded render context (Workspace-local Locale, viewport and theme keys); absent means unknown. */
	renderContext?: ReviewRenderContext
	status?: ReviewStatus
	/** Derived from the final lifecycle event; present only while `status` is resolved. */
	resolution?: ReviewResolution
	messageCount?: number
	/** Latest canonical activity (newest message, submission or history event), ISO 8601. */
	latestActivityAt?: string
	/** The last message, with only an excerpt of its current body; absent while the thread has no message. */
	latestMessage?: ReviewLatestMessageSummary
	/** The latest submission while ready for review or resolved and not reopened since. */
	currentSubmission?: ReviewCurrentSubmissionSummary
}>

/** Clause 01a163a5-719e-789d-a0fb-fc08646ed1d8: `excerpt` is the first 200 grapheme clusters of `body`. */
export type ReviewLatestMessageSummary = Readonly<{ id: string; actor: ReviewActor; at: string; excerpt: string; edited: boolean }>
export type ReviewCurrentSubmissionSummary = Readonly<{ id: string; at: string; changeDomains: readonly string[] }>

export type ResourceDiscoveryPage = Readonly<{ items: readonly ResourceDiscoveryItem[]; nextCursor?: string }>
export type ResourceDiscoveryOutcome =
	| Readonly<{ status: 'ok'; page: ResourceDiscoveryPage }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>

export type ResourceDiscoveryRequestValidation =
	| Readonly<{ status: 'valid'; request: ResourceDiscoveryRequest }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>

export function validateResourceDiscoveryRequest(input: unknown, mode: 'list' | 'search'): ResourceDiscoveryRequestValidation {
	const v = new Validator()
	const value = v.object(input, '')
	if (!value) return { status: 'invalid', diagnostics: v.diagnostics }
	rejectUnknownKeys(value, ['kinds', 'query', ...REVIEW_DISCOVERY_FILTERS, 'cursor', 'limit'], '', v)

	if (Object.hasOwn(value, 'kinds')) {
		const kinds = v.array(value.kinds, '/kinds')
		const seen = new Set<string>()
		kinds?.forEach((kind, index) => {
			const path = jsonPointer('/kinds', index)
			if (typeof kind !== 'string' || !DISCOVERABLE_RESOURCE_KINDS.includes(kind as DiscoverableResourceKind))
				v.issue('discovery.invalid_kind', path, 'Discovery kind must be view, flow, locale, review, or asset.')
			else if (seen.has(kind))
				v.issue('discovery.duplicate_kind', path, 'Discovery kinds must not repeat.')
			else seen.add(kind)
		})
	}

	validateFilterList(value, v, 'resolution', 'resolution', value => (REVIEW_RESOLUTIONS as readonly string[]).includes(value),
		'A resolution filter must list at least one resolution.', 'Resolution filter values must be verified, answered, wont-fix, duplicate, or obsolete.', 'Resolution filter values must not repeat.')
	validateFilterList(value, v, 'anchorScope', 'anchor_scope', value => (REVIEW_ANCHOR_SCOPES as readonly string[]).includes(value),
		'An anchorScope filter must list at least one scope.', 'anchorScope values must be workspace or view.', 'anchorScope values must not repeat.')
	validateFilterList(value, v, 'status', 'status', value => (REVIEW_DISCOVERY_STATUSES as readonly string[]).includes(value),
		'A status filter must list at least one status.', 'status values must be ready-for-review, open, resolved, or dismissed.', 'status values must not repeat.')
	validateFilterList(value, v, 'viewId', 'view_id', value => value === REVIEW_WORKSPACE_VIEW_TOKEN || isFullUuid(value),
		'A viewId filter must list at least one View.', 'viewId values must be View IDs (full UUIDs) or workspace.', 'viewId values must not repeat.')
	validateFilterList(value, v, 'variant', 'variant', value => value.length > 0,
		'A variant filter must list at least one Variant.', 'variant values must be non-empty Variant names or * for View-wide threads.', 'variant values must not repeat.')
	validateFilterList(value, v, 'anchor', 'anchor', value => (REVIEW_ANCHOR_STATES as readonly string[]).includes(value),
		'An anchor filter must list at least one anchor state.', 'anchor values must be valid, stale, or missing.', 'anchor values must not repeat.')
	validateFilterList(value, v, 'changeDomain', 'change_domain', value => (CHANGE_DOMAINS as readonly string[]).includes(value),
		'A changeDomain filter must list at least one change domain.', `changeDomain values must be known change domains: ${CHANGE_DOMAINS.join(', ')}.`, 'changeDomain values must not repeat.')

	const query = Object.hasOwn(value, 'query') ? v.string(value.query, '/query') : undefined
	if (mode === 'search' && (query === undefined || query.trim().length === 0))
		v.issue('discovery.query_required', '/query', 'Search requires a non-empty query after trimming whitespace.')
	if (mode === 'list' && Object.hasOwn(value, 'query'))
		v.issue('discovery.query_not_allowed', '/query', 'List discovery does not accept a search query.')
	if (Object.hasOwn(value, 'cursor')) v.string(value.cursor, '/cursor', true)
	const limit = v.finiteNumber(value.limit, '/limit')
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESOURCE_DISCOVERY_LIMIT))
		v.issue('discovery.invalid_limit', '/limit', `Discovery limit must be an integer from 1 to ${MAX_RESOURCE_DISCOVERY_LIMIT}.`)

	if (v.diagnostics.length > 0) return { status: 'invalid', diagnostics: v.diagnostics }
	return { status: 'valid', request: input as ResourceDiscoveryRequest }
}

/**
 * A Review filter is a non-empty array of unique allowed strings. Codes follow the existing discovery
 * family: `discovery.empty_<filter>_filter`, `discovery.invalid_<filter>`, `discovery.duplicate_<filter>`.
 */
function validateFilterList(
	value: Readonly<Record<string, unknown>>,
	v: Validator,
	key: ReviewDiscoveryFilter,
	code: string,
	allowed: (value: string) => boolean,
	emptyMessage: string,
	invalidMessage: string,
	duplicateMessage: string,
): void {
	if (!Object.hasOwn(value, key)) return
	const path = `/${key}`
	const entries = v.array(value[key], path)
	if (entries && entries.length === 0)
		v.issue(`discovery.empty_${code}_filter`, path, emptyMessage)
	const seen = new Set<string>()
	entries?.forEach((entry, index) => {
		const entryPath = jsonPointer(path, index)
		if (typeof entry !== 'string' || !allowed(entry))
			v.issue(`discovery.invalid_${code}`, entryPath, invalidMessage)
		else if (seen.has(entry))
			v.issue(`discovery.duplicate_${code}`, entryPath, duplicateMessage)
		else seen.add(entry)
	})
}
