import { describe, expect, it } from 'vitest'
import { commentCreateBlock, commentToolBlock, resolveBlock, resolveBlockMessage, type CommentAvailabilityInput } from '../app/utils/comment-availability'

const READY: CommentAvailabilityInput = {
	signedIn: true,
	canWriteReviews: true,
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
		expect(commentCreateBlock({ ...READY, workspaceState: 'migration_required', canWriteReviews: false })).toBe('migration')
		expect(commentCreateBlock({ ...READY, workspaceState: 'unsupported' })).toBe('unsupported')
		expect(commentCreateBlock({ ...READY, signedIn: false, canWriteReviews: false })).toBe('signed-out')
		expect(commentCreateBlock({ ...READY, canWriteReviews: false, handset: true })).toBe('key')
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
		expect(commentToolBlock({ ...READY, canWriteReviews: false, session: 'reconnecting' })).toBe('key')
	})
})

describe('why a thread cannot be resolved (PR #190 review note N1)', () => {
	const t = (key: string, params?: Record<string, unknown>) => params ? `${key} ${JSON.stringify(params)}` : key

	it('tells a holder of `reviews.resolve` on a write-blocked Workspace why, not that it lacks the key', () => {
		expect(resolveBlock({ workspaceState: 'migration_required', agent: false, holdsResolve: true })).toBe('migration')
		expect(resolveBlock({ workspaceState: 'unsupported', agent: false, holdsResolve: true })).toBe('unsupported')
		expect(resolveBlockMessage('migration', t)).toBe('commentBlock.migration')
		expect(resolveBlockMessage('unsupported', t)).toBe('commentBlock.unsupported')
	})

	it('otherwise names an Agent, then the missing key, and nothing for a holder on a live Workspace', () => {
		expect(resolveBlock({ workspaceState: 'valid', agent: true, holdsResolve: false })).toBe('agent')
		expect(resolveBlock({ workspaceState: 'valid', agent: false, holdsResolve: false })).toBe('key')
		expect(resolveBlock({ agent: false, holdsResolve: false })).toBe('key')
		expect(resolveBlock({ workspaceState: 'valid', agent: false, holdsResolve: true })).toBeUndefined()
		expect(resolveBlockMessage('agent', t)).toBe('comments.resolveNeedsPerson')
		expect(resolveBlockMessage('key', t)).toBe('access.requiresKey {"key":"reviews.resolve"}')
	})
})
