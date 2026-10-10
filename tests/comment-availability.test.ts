import { describe, expect, it } from 'vitest'
import { commentCreateBlock, commentToolBlock, type CommentAvailabilityInput } from '../app/utils/comment-availability'

const READY: CommentAvailabilityInput = {
	signedIn: true,
	canReview: true,
	handset: false,
	hasView: true,
	session: 'live',
}

describe('comment availability (review feedback 8dd59d25)', () => {
	it('lets a signed-in Reviewer comment on a live View', () => {
		expect(commentCreateBlock(READY)).toBeUndefined()
		expect(commentToolBlock(READY)).toBeUndefined()
	})

	it('names each blocking state, in the order a person can fix it', () => {
		expect(commentCreateBlock({ ...READY, workspaceState: 'migration_required', canReview: false })).toBe('migration')
		expect(commentCreateBlock({ ...READY, workspaceState: 'unsupported' })).toBe('unsupported')
		expect(commentCreateBlock({ ...READY, signedIn: false, canReview: false })).toBe('signed-out')
		expect(commentCreateBlock({ ...READY, canReview: false, handset: true })).toBe('role')
		expect(commentCreateBlock({ ...READY, handset: true })).toBe('handset')
		expect(commentCreateBlock({ ...READY, hasView: false })).toBe('no-view')
		expect(commentCreateBlock({ ...READY, workspaceState: 'valid' })).toBeUndefined()
	})

	it('needs a live Preview for the canvas tool, but not for a comment on the View as a whole', () => {
		for (const [session, code] of [['connecting', 'connecting'], ['idle', 'connecting'], ['reconnecting', 'reconnecting'], ['stopped', 'stopped']] as const) {
			expect(commentToolBlock({ ...READY, session })).toBe(code)
			expect(commentCreateBlock({ ...READY, session })).toBeUndefined()
		}
		// A reason the person must fix first wins over the session.
		expect(commentToolBlock({ ...READY, canReview: false, session: 'reconnecting' })).toBe('role')
	})
})
