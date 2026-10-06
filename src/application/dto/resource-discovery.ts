import { REVIEW_RESOLUTIONS, type ReviewAnchor, type ReviewDisplayHint, type ReviewResolution, type ReviewStatus } from '../../domain/reviews/schema'
import { jsonPointer, rejectUnknownKeys, Validator, type Diagnostic } from '../../domain/validation'
import type { ResourceRevision } from './revisions'

export const DISCOVERABLE_RESOURCE_KINDS = ['view', 'flow', 'locale', 'review', 'asset'] as const
export const MAX_RESOURCE_DISCOVERY_LIMIT = 100

export type DiscoverableResourceKind = typeof DISCOVERABLE_RESOURCE_KINDS[number]
export type ResourceDiscoveryRequest = Readonly<{
	kinds?: readonly DiscoverableResourceKind[]
	query?: string
	/** Structured Review filter: only resolved threads whose derived resolution is listed match. */
	resolution?: readonly ReviewResolution[]
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
	status?: ReviewStatus
	/** Derived from the final lifecycle event; present only while `status` is resolved. */
	resolution?: ReviewResolution
	messageCount?: number
	/** Latest canonical activity (newest message, submission or history event), ISO 8601. */
	latestActivityAt?: string
}>

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
	rejectUnknownKeys(value, ['kinds', 'query', 'resolution', 'cursor', 'limit'], '', v)

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

	if (Object.hasOwn(value, 'resolution')) {
		const resolutions = v.array(value.resolution, '/resolution')
		if (resolutions && resolutions.length === 0)
			v.issue('discovery.empty_resolution_filter', '/resolution', 'A resolution filter must list at least one resolution.')
		const seen = new Set<string>()
		resolutions?.forEach((resolution, index) => {
			const path = jsonPointer('/resolution', index)
			if (typeof resolution !== 'string' || !(REVIEW_RESOLUTIONS as readonly string[]).includes(resolution))
				v.issue('discovery.invalid_resolution', path, 'Resolution filter values must be verified, answered, wont-fix, duplicate, or obsolete.')
			else if (seen.has(resolution))
				v.issue('discovery.duplicate_resolution', path, 'Resolution filter values must not repeat.')
			else seen.add(resolution)
		})
	}

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
