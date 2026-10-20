import { watch, type Ref } from 'vue'

import { threadState, type ThreadState } from '../utils/reply-conflict'

/** The thread a reply draft was written against: its revision and what it looked like then. */
export type ReplyBase = Readonly<{ revision: string; state: ThreadState }>

/**
 * Pins each reply draft to the thread revision it started from. With live refresh a thread is
 * re-read while the user writes, and a reply must not silently apply to a thread that changed
 * underneath it (Rule 01a11485-f451-72eb-81ad-686aeec7b3eb): the reply is sent against the pinned
 * revision, so a change made meanwhile refuses it as a conflict, the alert says what changed since
 * the draft started, and Send again acts on the new revision (Rule 01a116f0-95fc-77c6-a7ab-1318cb6d19af).
 * A draft emptied, sent or refused drops its pin; the next keystroke pins the thread as shown then.
 */
export function useReplyBases(
	drafts: Ref<Record<string, string>>,
	thread: (threadId: string) => (ThreadState & Readonly<{ revision: string }>) | undefined,
) {
	const bases = new Map<string, ReplyBase>()
	watch(drafts, (current) => {
		for (const threadId of [...bases.keys()]) if (!current[threadId]?.trim()) bases.delete(threadId)
		for (const [threadId, text] of Object.entries(current)) {
			if (!text.trim() || bases.has(threadId)) continue
			const item = thread(threadId)
			if (item) bases.set(threadId, { revision: item.revision, state: threadState(item) })
		}
	}, { deep: true, flush: 'sync', immediate: true })
	return {
		/** The pin of a thread's draft, if it has one. */
		get: (threadId: string): ReplyBase | undefined => bases.get(threadId),
		/** Drops the pin, after a conflict: the user acts again on the thread as it is now. */
		release: (threadId: string): void => { bases.delete(threadId) },
	}
}

/**
 * The thread revision one open action step was started on: a reason step, the Promote or Submit
 * dialog, or a message being edited. Live refresh re-reads the thread while the step is open, and
 * the step must not silently apply to a thread that changed meanwhile (Rule
 * 01a11485-f451-72eb-81ad-686aeec7b3eb): its write carries the pinned revision, so a change made
 * elsewhere refuses it as a conflict; after the conflict the step is pinned again to the thread as
 * re-read and shown, and the user acts again.
 */
export function createRevisionPin(revisionOf: (threadId: string) => string | undefined) {
	let pin: Readonly<{ threadId: string; revision: string }> | undefined
	return {
		/** Pins the thread's revision as shown now. */
		pin(threadId: string | undefined): void {
			const revision = threadId === undefined ? undefined : revisionOf(threadId)
			pin = threadId !== undefined && revision !== undefined ? { threadId, revision } : undefined
		},
		/** The pinned revision when the step is for `threadId`. */
		get(threadId: string): string | undefined {
			return pin?.threadId === threadId ? pin.revision : undefined
		},
		release(): void {
			pin = undefined
		},
	}
}
