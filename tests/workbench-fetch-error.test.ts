import { describe, expect, it } from 'vitest'
import { describeFetchError, formatFetchError, isLockedError } from '../app/utils/fetch-error'
import { promoteConflictTitleKey, promoteMovedOf } from '../app/utils/promote-conflict'

function fetchError(statusCode: number, data: unknown, message = `[POST] "/api/evidence/capture": ${statusCode} Unprocessable Entity`) {
	return Object.assign(new Error(message), { statusCode, status: statusCode, data })
}

describe('describeFetchError', () => {
	it('extracts per-context capture failures instead of the transport string', () => {
		const details = describeFetchError(fetchError(422, {
			status: 'failed',
			results: [{
				status: 'failed',
				error: 'Playwright Chromium is not installed.',
				diagnostics: [{ code: 'evidence.capture_failed', path: '/contexts/0', message: 'Capture could not start.' }],
			}],
			summary: { total: 1, captured: 0, failed: 1 },
		}), 'Capture failed')
		expect(details.message).toBe('Capture could not start.')
		expect(details.statusCode).toBe(422)
		expect(details.status).toBe('failed')
		expect(details.diagnostics.map(item => item.message)).toEqual([
			'Capture could not start.',
			'Playwright Chromium is not installed.',
		])
		expect(details.message).not.toContain('[POST]')
	})

	it('prefers the server body message and keeps structural diagnostics', () => {
		const details = describeFetchError(fetchError(400, {
			status: 'invalid',
			message: 'Request payload failed structural validation.',
			diagnostics: [{ code: 'transport.malformed_payload', path: '/name', message: 'Required' }],
		}, '[PUT] "/api/flows/x": 400 Bad Request'), 'Save failed')
		expect(details.message).toBe('Request payload failed structural validation.')
		expect(formatFetchError(fetchError(400, {
			message: 'Request payload failed structural validation.',
			diagnostics: [{ message: 'Required' }],
		}), 'Save failed')).toBe('Request payload failed structural validation. Required')
	})

	it('falls back to the provided message for bare transport failures', () => {
		expect(describeFetchError(fetchError(500, undefined, '[GET] "/api/x": 500 Internal Server Error'), 'Load failed').message).toBe('Load failed')
		expect(describeFetchError(new TypeError('Failed to fetch'), 'Load failed').message).toBe('Load failed')
		expect(describeFetchError('nope', 'Load failed').message).toBe('Load failed')
	})

	it('keeps meaningful non-transport error messages', () => {
		expect(describeFetchError(new Error('Selected View is unavailable.'), 'Load failed').message).toBe('Selected View is unavailable.')
	})

	it('carries the holder and expiry of a 423 resource.locked refusal', () => {
		const lock = { kind: 'flow', key: 'checkout', holder: { nickname: 'codex', kind: 'agent' }, expiresAt: '2026-10-05T10:05:00.000Z' }
		const details = describeFetchError(fetchError(423, { status: 'locked', key: 'checkout', code: 'resource.locked', message: 'Locked by codex.', lock }), 'Save failed')
		expect(isLockedError(details)).toBe(true)
		expect(details.lock).toEqual(lock)
		expect(details.message).toBe('Locked by codex.')
		const fromList = describeFetchError(fetchError(423, { status: 'locked', code: 'resource.locked', message: 'Locked.', locks: [lock] }), 'Save failed')
		expect(fromList.lock?.holder.nickname).toBe('codex')
		expect(isLockedError(describeFetchError(fetchError(409, { status: 'conflict' }), 'Save failed'))).toBe(false)
	})
})

// Rule 01a11544-611c-73e0-990b-c094b48b3eb6 and Clause 01a11544-6d0a-70f4-b6b7-76e42f95d42e: a
// promotion conflict names which resource moved through `conflicts[]`.
describe('promotion conflicts', () => {
	const entry = (resource: string, key: string) => ({ resource, key, expectedRevision: 'sha256:a', currentRevision: 'sha256:b' })

	it('reads the moved resources of a conflict body, thread first', () => {
		const both = describeFetchError(fetchError(409, { status: 'conflict', key: 'r', currentRevision: 'sha256:b', conflicts: [entry('view', 'v'), entry('review', 'r')] }), 'Promote failed')
		expect(both.conflicts).toEqual([{ resource: 'view', key: 'v' }, { resource: 'review', key: 'r' }])
		expect(promoteMovedOf(both)).toEqual(['review', 'view'])
		expect(promoteConflictTitleKey(promoteMovedOf(both))).toBe('reviews.promote.conflict.both')

		const viewOnly = describeFetchError(fetchError(409, { status: 'conflict', key: 'v', conflicts: [entry('view', 'v')] }), 'Promote failed')
		expect(promoteConflictTitleKey(promoteMovedOf(viewOnly))).toBe('reviews.promote.conflict.view')
		const reviewOnly = describeFetchError(fetchError(409, { status: 'conflict', key: 'r', conflicts: [entry('review', 'r')] }), 'Promote failed')
		expect(promoteConflictTitleKey(promoteMovedOf(reviewOnly))).toBe('reviews.promote.conflict.review')
	})

	it('names nothing when the body lists no conflicts', () => {
		const bare = describeFetchError(fetchError(409, { status: 'conflict', key: 'r', currentRevision: 'sha256:b' }), 'Promote failed')
		expect(bare.conflicts).toBeUndefined()
		expect(promoteMovedOf(bare)).toEqual([])
		expect(promoteConflictTitleKey(promoteMovedOf(bare))).toBeUndefined()
		expect(promoteMovedOf(describeFetchError(fetchError(409, { conflicts: [{ resource: 'review' }, 'x'] }), 'Promote failed'))).toEqual([])
	})
})
