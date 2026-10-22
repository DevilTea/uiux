import type { ReviewActor, ReviewHistoryEvent, ReviewMessage, ReviewMessageEdit, ReviewSubmission, ReviewThread } from './schema'

const MEMBER_PREFIX = 'member:'

function isMemberActor(actor: ReviewActor | undefined): actor is ReviewActor & { id: string } {
	return typeof actor?.id === 'string' && actor.id.startsWith(MEMBER_PREFIX)
}

/**
 * Marks an actor of kind member whose member ID is not in the roster with `removed: true`, and
 * returns every other actor unchanged (Rule 01a11485-f185-7c23-8f2a-e045a279cd27). The recorded
 * display name is kept.
 */
export function markRemovedActor(actor: ReviewActor, memberIds: ReadonlySet<string>): ReviewActor {
	return isMemberActor(actor) && !memberIds.has(actor.id.slice(MEMBER_PREFIX.length)) ? { ...actor, removed: true } : actor
}

/** A read-time copy of a thread with `removed` on every removed member's actor; the stored thread is untouched. */
export function markRemovedActors(thread: ReviewThread, memberIds: ReadonlySet<string>): ReviewThread {
	const mark = (actor: ReviewActor) => markRemovedActor(actor, memberIds)
	return {
		...thread,
		...(Array.isArray(thread.messages)
			? {
					messages: thread.messages.map((message: ReviewMessage) => ({
						...message,
						actor: mark(message.actor),
						...(message.edits ? { edits: message.edits.map((edit: ReviewMessageEdit) => ({ ...edit, actor: mark(edit.actor) })) } : {}),
					})),
				}
			: {}),
		...(Array.isArray(thread.submissions) ? { submissions: thread.submissions.map((submission: ReviewSubmission) => ({ ...submission, actor: mark(submission.actor) })) } : {}),
		...(Array.isArray(thread.history) ? { history: thread.history.map((event: ReviewHistoryEvent) => ({ ...event, actor: mark(event.actor) })) } : {}),
	}
}
