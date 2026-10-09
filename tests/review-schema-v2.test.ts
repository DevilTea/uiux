import { describe, expect, it } from 'vitest'

import {
	deriveReviewResolution,
	isAllowedReviewTransition,
	normalizeReviewPinCoordinate,
	REVIEW_RESOLUTIONS,
	validateReviewThread,
	type ReviewThread,
} from '../src/domain/reviews/schema'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const REVIEW_ID = '66666666-6666-4666-8666-666666666666'
const SUBMISSION_ID = '77777777-7777-4777-8777-777777777777'
const READY_ID = '88888888-8888-4888-8888-888888888888'
const RESOLVE_ID = '99999999-9999-4999-8999-999999999999'
const REOPEN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TIME = '2026-10-05T09:00:00Z'
const LATER = '2026-10-05T09:05:00Z'
const DIGEST = `sha256:${'b'.repeat(64)}`
const V1 = { schemaVersion: 1 } as const
const V2 = { schemaVersion: 2 } as const
const human = { type: 'human', displayName: 'Mei' }

const open: ReviewThread = { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'submit' }, variantNames: [], status: 'open', messages: [], history: [], submissions: [] }
const submission = {
	id: SUBMISSION_ID, actor: { type: 'agent' }, at: TIME, changeDomains: ['view-structure'],
	resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: 'r_1' }], scope: {}, evidenceRefs: [{ kind: 'screenshot', evidence: DIGEST }],
}
const readyEvent = { id: READY_ID, kind: 'lifecycle', from: 'open', to: 'ready-for-review', actor: { type: 'agent' }, at: TIME, submissionId: SUBMISSION_ID }

function directResolve(resolution: string, extra: Record<string, unknown> = {}) {
	return { ...open, status: 'resolved', history: [{ id: RESOLVE_ID, kind: 'lifecycle', from: 'open', to: 'resolved', actor: human, at: LATER, resolution, ...extra }] }
}

function readyThenResolve(event: Record<string, unknown>) {
	return {
		...open,
		status: 'resolved',
		submissions: [submission],
		history: [readyEvent, { id: RESOLVE_ID, kind: 'lifecycle', from: 'ready-for-review', to: 'resolved', actor: human, at: LATER, ...event }],
	}
}

function codes(input: unknown, context: { schemaVersion: number }): string[] {
	return validateReviewThread(input, context).diagnostics.map(item => item.code)
}

describe('Review resolution kinds (schemaVersion 2)', () => {
	it('accepts direct resolve of an open thread for every non-verified resolution', () => {
		for (const resolution of ['answered', 'wont-fix', 'obsolete'] as const)
			expect(validateReviewThread(directResolve(resolution), V2).ok).toBe(true)
		expect(validateReviewThread(directResolve('duplicate', { reason: 'Same as the header padding thread.' }), V2).ok).toBe(true)
	})

	it('requires a non-empty reason for duplicate only', () => {
		expect(codes(directResolve('duplicate'), V2)).toContain('review.resolution_reason_required')
		expect(codes(directResolve('duplicate', { reason: '   ' }), V2)).toContain('review.resolution_reason_required')
		expect(validateReviewThread(directResolve('wont-fix'), V2).ok).toBe(true)
		expect(validateReviewThread(directResolve('wont-fix', { reason: 'Out of scope' }), V2).ok).toBe(true)
	})

	it('requires a resolution exactly when entering resolved and rejects unknown values', () => {
		const missing = readyThenResolve({ submissionId: SUBMISSION_ID })
		expect(codes(missing, V2)).toEqual(['review.resolution_required'])
		expect(codes(directResolve('promoted'), V2)).toContain('review.invalid_resolution')
		expect(codes(directResolve('promoted'), V2)).not.toContain('review.invalid_transition')
		const onReady = { ...open, status: 'ready-for-review', submissions: [submission], history: [{ ...readyEvent, resolution: 'verified' }] }
		expect(codes(onReady, V2)).toEqual(['review.resolution_unexpected'])
		const onReopen = {
			...readyThenResolve({ submissionId: SUBMISSION_ID, resolution: 'verified' }),
			status: 'open',
			history: [...readyThenResolve({ submissionId: SUBMISSION_ID, resolution: 'verified' }).history, { id: REOPEN_ID, kind: 'lifecycle', from: 'resolved', to: 'open', actor: human, at: LATER, resolution: 'answered' }],
		}
		expect(codes(onReopen, V2)).toEqual(['review.resolution_unexpected'])
	})

	it('keeps the evidence gate for verified: ready-for-review, the active submission, and a human', () => {
		expect(validateReviewThread(readyThenResolve({ submissionId: SUBMISSION_ID, resolution: 'verified' }), V2).ok).toBe(true)
		expect(codes(readyThenResolve({ resolution: 'verified' }), V2)).toEqual(expect.arrayContaining(['review.resolve_missing_submission', 'review.resolve_stale_submission']))
		const verifiedFromOpen = directResolve('verified')
		expect(codes(verifiedFromOpen, V2)).toEqual(expect.arrayContaining(['review.resolve_missing_submission', 'review.invalid_transition']))
		const byAgent = readyThenResolve({ submissionId: SUBMISSION_ID, resolution: 'verified', actor: { type: 'agent' } })
		expect(codes(byAgent, V2)).toContain('review.resolve_requires_human')
		expect(codes(directResolve('answered', { actor: { type: 'agent' } }), V2)).toContain('review.resolve_requires_human')
	})

	it('forbids a submissionId on non-verified resolutions and closes a pending submission as not accepted', () => {
		expect(codes(readyThenResolve({ submissionId: SUBMISSION_ID, resolution: 'wont-fix' }), V2)).toEqual(['review.direct_resolve_submission_forbidden'])
		const declined = readyThenResolve({ resolution: 'wont-fix', reason: 'Declined after all' })
		expect(validateReviewThread(declined, V2).ok).toBe(true)
		expect(deriveReviewResolution(declined as ReviewThread)).toBe('wont-fix')
		// Reopen after a non-verified close, then a new verified cycle is evaluated fresh.
		const second = { ...submission, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', at: '2026-10-05T10:00:00Z' }
		const cycled = {
			...declined,
			submissions: [submission, second],
			history: [
				...declined.history,
				{ id: REOPEN_ID, kind: 'lifecycle', from: 'resolved', to: 'open', actor: human, at: '2026-10-05T09:30:00Z' },
				{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'lifecycle', from: 'open', to: 'ready-for-review', actor: { type: 'agent' }, at: second.at, submissionId: second.id },
				{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'lifecycle', from: 'ready-for-review', to: 'resolved', actor: human, at: '2026-10-05T10:05:00Z', submissionId: second.id, resolution: 'verified' },
			],
		}
		expect(validateReviewThread(cycled, V2).ok).toBe(true)
		const staleVerified = { ...cycled, history: cycled.history.map((entry, index) => index === 4 ? { ...entry, submissionId: SUBMISSION_ID } : entry) }
		expect(codes(staleVerified, V2)).toContain('review.resolve_stale_submission')
	})

	it('allows a first lifecycle event open -> resolved but still requires history to start from open', () => {
		expect(validateReviewThread(directResolve('answered'), V2).ok).toBe(true)
		const fromReady = { ...open, status: 'resolved', history: [{ id: RESOLVE_ID, kind: 'lifecycle', from: 'ready-for-review', to: 'resolved', actor: human, at: TIME, resolution: 'answered' }] }
		expect(codes(fromReady, V2)).toContain('review.invalid_initial_status')
	})

	it('makes the transition table resolution-aware', () => {
		expect(isAllowedReviewTransition('open', 'resolved')).toBe(false)
		expect(isAllowedReviewTransition('open', 'resolved', 'verified')).toBe(false)
		expect(isAllowedReviewTransition('ready-for-review', 'resolved')).toBe(true)
		expect(isAllowedReviewTransition('ready-for-review', 'resolved', 'verified')).toBe(true)
		for (const resolution of ['answered', 'wont-fix', 'duplicate', 'obsolete'] as const) {
			expect(isAllowedReviewTransition('open', 'resolved', resolution)).toBe(true)
			expect(isAllowedReviewTransition('ready-for-review', 'resolved', resolution)).toBe(true)
			expect(isAllowedReviewTransition('resolved', 'resolved', resolution)).toBe(false)
		}
		expect(isAllowedReviewTransition('open', 'ready-for-review')).toBe(true)
		expect(isAllowedReviewTransition('ready-for-review', 'open')).toBe(true)
		expect(isAllowedReviewTransition('resolved', 'open')).toBe(true)
		expect(REVIEW_RESOLUTIONS).toEqual(['verified', 'answered', 'wont-fix', 'duplicate', 'obsolete'])
	})

	it('derives the current resolution from the final lifecycle event only while resolved', () => {
		expect(deriveReviewResolution(directResolve('obsolete') as ReviewThread)).toBe('obsolete')
		expect(deriveReviewResolution(open)).toBeUndefined()
		expect(deriveReviewResolution(readyThenResolve({ submissionId: SUBMISSION_ID }) as ReviewThread)).toBeUndefined()
	})
})

describe('Review schema version gating', () => {
	it('keeps v1 decoding exactly: resolution is an unknown field and open -> resolved is invalid', () => {
		const v1Resolve = readyThenResolve({ submissionId: SUBMISSION_ID })
		expect(validateReviewThread(v1Resolve, V1).ok).toBe(true)
		expect(codes(readyThenResolve({ submissionId: SUBMISSION_ID, resolution: 'verified' }), V1)).toContain('schema.unknown_field')
		const direct = codes(directResolve('answered'), V1)
		expect(direct).toEqual(expect.arrayContaining(['schema.unknown_field', 'review.invalid_transition', 'review.resolve_missing_submission']))
		expect(codes({ ...open, displayHint: { pin: { x: 0.5, y: 0.5 } } }, V1)).toEqual(['schema.unknown_field'])
	})
})

describe('Review pin display hint (schemaVersion 2)', () => {
	it('accepts a closed in-range hint beside the anchor, including unquantized values', () => {
		expect(validateReviewThread({ ...open, displayHint: { pin: { x: 0.4213, y: 0.1875 } } }, V2).ok).toBe(true)
		expect(validateReviewThread({ ...open, displayHint: { pin: { x: 0, y: 1 } } }, V2).ok).toBe(true)
		expect(validateReviewThread({ ...open, displayHint: { pin: { x: 0.123456789, y: 0.5 } } }, V2).ok).toBe(true)
	})

	it('diagnoses empty, out-of-range, non-number, missing, and unknown members without repairing them', () => {
		expect(codes({ ...open, displayHint: {} }, V2)).toEqual(['review.display_hint_empty'])
		expect(codes({ ...open, displayHint: { pin: { x: 1.2, y: -0.1 } } }, V2)).toEqual(['review.display_hint_out_of_range', 'review.display_hint_out_of_range'])
		expect(codes({ ...open, displayHint: { pin: { x: '0.5', y: 0.5 } } }, V2)).toEqual(['schema.expected_finite_number'])
		expect(codes({ ...open, displayHint: { pin: { x: 0.5 } } }, V2)).toEqual(['schema.expected_finite_number'])
		expect(codes({ ...open, displayHint: { pin: { x: 0.5, y: 0.5, z: 0 } } }, V2)).toEqual(['schema.unknown_field'])
		expect(codes({ ...open, displayHint: { pin: { x: 0.5, y: 0.5 }, region: {} } }, V2)).toEqual(['schema.unknown_field'])
		expect(codes({ ...open, displayHint: null }, V2)).toEqual(['schema.expected_object'])
	})

	it('never treats the hint as anchor identity: the anchor stays closed and an invalid anchor keeps only its own diagnostic', () => {
		expect(codes({ ...open, anchor: { ...open.anchor, displayHint: { x: 0.5, y: 0.5 } } }, V2)).toEqual(['schema.unknown_field'])
		const reanchored = {
			...open,
			anchor: { viewId: VIEW_ID, widgetId: 'next' },
			displayHint: { pin: { x: 0.25, y: 0.75 } },
			history: [{ id: RESOLVE_ID, kind: 'reanchor', actor: human, at: TIME, before: { anchor: open.anchor, variantNames: [] }, after: { anchor: { viewId: VIEW_ID, widgetId: 'next' }, variantNames: [] } }],
		}
		expect(validateReviewThread(reanchored, V2).ok).toBe(true)
		expect(codes({ ...open, anchor: { viewId: 'not-a-uuid', widgetId: 'x' }, displayHint: { pin: { x: 0.5, y: 0.5 } } }, V2)).toEqual(['identity.invalid_uuid'])
	})

	it('normalizes writer coordinates by clamping to [0, 1] and quantizing to 1e-4', () => {
		expect(normalizeReviewPinCoordinate(0.123456)).toBe(0.1235)
		expect(normalizeReviewPinCoordinate(0.99996)).toBe(1)
		expect(normalizeReviewPinCoordinate(1.7)).toBe(1)
		expect(normalizeReviewPinCoordinate(-0.00001)).toBe(0)
		expect(Object.is(normalizeReviewPinCoordinate(-0.00001), -0)).toBe(false)
		expect(normalizeReviewPinCoordinate(0.5)).toBe(0.5)
	})
})
