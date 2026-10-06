import { isMessageFrozen, type ReviewThread } from '../../src/domain/reviews/schema'

/**
 * What the Workbench offers on a message or a thread, decided from the loaded thread alone. The
 * server re-checks every rule (and E6, a promoted Decision, which the Workbench cannot see), so
 * these only decide what to show; they never authorize.
 *
 * - Edit (scope/edit decisions 11–12): the author's own message, written by a stamped member,
 *   until a later ready-for-review submission or resolution freezes it for good.
 * - Delete (retract addendum decision 2, E1–E5): the author's brand-new open thread with exactly
 *   their one message and no history or submissions; an empty open thread for any Reviewer.
 */

export type MessageEditState =
	| Readonly<{ kind: 'editable' }>
	| Readonly<{ kind: 'frozen'; by: 'submission' | 'resolution' }>
	/** Not the viewer's message (or written before authors were identified): no Edit at all. */
	| Readonly<{ kind: 'none' }>

/** `me` is the signed-in member's stamped actor id, `member:<uuid>`. */
export function messageEditState(thread: Pick<ReviewThread, 'messages' | 'submissions' | 'history'>, messageId: string, me: string | undefined): MessageEditState {
	const message = thread.messages.find(candidate => candidate.id === messageId)
	if (!message || !me || !isMemberId(message.actor.id) || message.actor.id !== me) return { kind: 'none' }
	const freeze = isMessageFrozen(thread, messageId)
	return freeze.frozen ? { kind: 'frozen', by: freeze.by } : { kind: 'editable' }
}

/** The viewer's newest message that can still be edited (`↑` in an empty reply box). */
export function latestEditableMessageId(thread: Pick<ReviewThread, 'messages' | 'submissions' | 'history'>, me: string | undefined): string | undefined {
	for (const message of [...thread.messages].reverse()) {
		if (messageEditState(thread, message.id, me).kind === 'editable') return message.id
	}
	return undefined
}

export type RetractEligibility = Readonly<{ eligible: false } | { eligible: true; empty: boolean }>

export function retractEligibility(thread: Pick<ReviewThread, 'status' | 'messages' | 'history' | 'submissions'> | undefined, me: string | undefined): RetractEligibility {
	if (!thread || !me || thread.status !== 'open' || thread.history.length > 0 || thread.submissions.length > 0) return { eligible: false }
	if (thread.messages.length === 0) return { eligible: true, empty: true }
	if (thread.messages.length !== 1) return { eligible: false }
	const author = thread.messages[0]!.actor
	return isMemberId(author.id) && author.id === me ? { eligible: true, empty: false } : { eligible: false }
}

function isMemberId(id: string | undefined): id is string {
	return typeof id === 'string' && id.startsWith('member:')
}
