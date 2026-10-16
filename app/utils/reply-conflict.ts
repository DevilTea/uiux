import type { ReviewResolution, ReviewStatus } from '../../src/domain/reviews/schema'
import { inboxStatusOf, type InboxStatus } from './review-inbox'

/**
 * A reply refused for a revision conflict (Rule 01a116f0-95fc-77c6-a7ab-1318cb6d19af): what the
 * thread looked like when the reply was sent, and what changed by the time it was re-read. Pure, so
 * the canvas bubble and the Reviews detail and sheet say the same thing.
 */
export type ThreadState = Readonly<{ messageCount: number; status: ReviewStatus; resolution?: ReviewResolution }>

export type ReplyConflict = Readonly<{ threadId: string; before: ThreadState }>

export type ReplyConflictChange = Readonly<{
	/** Messages added since the reply was written. */
	newMessages: number
	/** The status shown now (a dismissal is `dismissed`), when it differs from before. */
	status?: InboxStatus
}>

export function threadState(thread: ThreadState): ThreadState {
	return { messageCount: thread.messageCount, status: thread.status, ...(thread.resolution ? { resolution: thread.resolution } : {}) }
}

export function replyConflictChange(before: ThreadState, after: ThreadState): ReplyConflictChange {
	const was = inboxStatusOf(before.status, before.resolution)
	const now = inboxStatusOf(after.status, after.resolution)
	return { newMessages: Math.max(0, after.messageCount - before.messageCount), ...(was === now ? {} : { status: now }) }
}
