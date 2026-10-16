import { describe, expect, it } from 'vitest'
import { replyConflictChange, threadState } from '../app/utils/reply-conflict'

/** What a reply conflict reports as changed (Rule 01a116f0-95fc-77c6-a7ab-1318cb6d19af, issue #117). */
describe('replyConflictChange', () => {
	const open = { messageCount: 2, status: 'open' } as const

	it('counts the messages added since the reply was written', () => {
		expect(replyConflictChange(open, { messageCount: 4, status: 'open' })).toEqual({ newMessages: 2 })
	})

	it('names the new status, with a dismissal shown as dismissed', () => {
		expect(replyConflictChange(open, { messageCount: 2, status: 'ready-for-review' })).toEqual({ newMessages: 0, status: 'ready-for-review' })
		expect(replyConflictChange(open, { messageCount: 3, status: 'resolved', resolution: 'answered' })).toEqual({ newMessages: 1, status: 'resolved' })
		expect(replyConflictChange(open, { messageCount: 2, status: 'resolved', resolution: 'wont-fix' })).toEqual({ newMessages: 0, status: 'dismissed' })
	})

	it('reports nothing it can name when only something else changed, and never a negative count', () => {
		expect(replyConflictChange(open, open)).toEqual({ newMessages: 0 })
		expect(replyConflictChange(open, { messageCount: 1, status: 'open' })).toEqual({ newMessages: 0 })
	})

	it('keeps only the fields it compares', () => {
		expect(threadState({ messageCount: 1, status: 'open', id: 'x' } as never)).toEqual({ messageCount: 1, status: 'open' })
	})
})
